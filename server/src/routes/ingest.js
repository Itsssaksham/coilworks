import express from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Telemetry } from '../models/Telemetry.js';
import { Sale } from '../models/Sale.js';
import { Product } from '../models/Product.js';
import { requireMachine } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { evaluateMachine } from '../services/alerts.js';

export const ingestRouter = express.Router();

/**
 * Machine-facing ingest API.
 *
 * Authenticated per machine with an API key, not with an operator session - a
 * compromised machine key can write telemetry for exactly one machine and can
 * read nothing.
 */

// A machine heartbeats every ~30s; 120/min leaves generous headroom for retries
// and burst catch-up after a reconnect, while capping a machine stuck in a loop.
const ingestLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyFn: (req) => `ingest:${req.params.code}`,
});

const telemetrySchema = z.object({
  ts: z.coerce.date().optional(),
  temperatureC: z.number().min(-40).max(80).optional(),
  doorOpen: z.boolean().optional(),
  cashCents: z.number().int().min(0).optional(),
  powerOk: z.boolean().optional(),
  signalStrength: z.number().min(0).max(100).optional(),
  coilFaults: z.array(z.string().max(8)).max(60).optional(),
  uptimeSeconds: z.number().int().min(0).optional(),
});

/**
 * POST /api/ingest/:code/telemetry
 *
 * One heartbeat. Three effects, in order:
 *  1. append the raw reading to the time-series collection
 *  2. denormalize the latest values onto the machine (what the fleet list reads)
 *  3. run the alert rules over the new state
 *
 * Step 2 is what the change stream picks up, so a heartbeat is what makes the
 * dashboard move.
 */
ingestRouter.post('/:code/telemetry', ingestLimit, requireMachine, async (req, res, next) => {
  try {
    const parsed = telemetrySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid telemetry', issues: parsed.error.issues });
    }

    const machine = req.machine;
    const reading = { ...parsed.data, ts: parsed.data.ts ?? new Date() };

    await Telemetry.create({ machineId: machine._id, ...reading });

    // Mark faulted rather than online when the controller reports a jam or a
    // power loss - the machine is reachable but not fully serviceable.
    const faulted = (reading.coilFaults?.length ?? 0) > 0 || reading.powerOk === false;

    machine.lastSeenAt = reading.ts;
    machine.status = faulted ? 'fault' : 'online';
    if (reading.temperatureC != null) machine.temperatureC = reading.temperatureC;
    if (reading.doorOpen != null) machine.doorOpen = reading.doorOpen;
    if (reading.cashCents != null) machine.cashCents = reading.cashCents;
    if (reading.signalStrength != null) machine.signalStrength = reading.signalStrength;

    for (const slot of machine.slots) {
      slot.jammed = reading.coilFaults?.includes(slot.code) ?? false;
    }

    await machine.save();

    const chilled = await machineHoldsChilled(machine);
    const raised = await evaluateMachine({ machine, reading, chilled });

    res.status(202).json({ ok: true, alertsRaised: raised.length });
  } catch (err) {
    next(err);
  }
});

const vendSchema = z.object({
  slotCode: z.string().min(1).max(8),
  payment: z.enum(['card', 'cash', 'mobile']),
  ts: z.coerce.date().optional(),
});

/**
 * POST /api/ingest/:code/vend
 *
 * A completed sale. The slot decrement and the sale record must both happen or
 * neither: a decrement without a sale loses revenue data, and a sale without a
 * decrement means the forecast thinks stock exists that doesn't. They are run
 * in a transaction, which is the second reason this app needs a replica set.
 */
ingestRouter.post('/:code/vend', ingestLimit, requireMachine, async (req, res, next) => {
  const parsed = vendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid vend', issues: parsed.error.issues });
  }

  const machine = req.machine;
  const slot = machine.slots.find((s) => s.code === parsed.data.slotCode);
  if (!slot) return res.status(404).json({ error: `No slot ${parsed.data.slotCode}` });
  if (slot.qty <= 0) return res.status(409).json({ error: `Slot ${slot.code} is empty` });

  const session = await mongoose.startSession();
  try {
    let sale;
    await session.withTransaction(async () => {
      slot.qty -= 1;
      machine.cashCents += parsed.data.payment === 'cash' ? slot.priceCents : 0;
      await machine.save({ session });

      [sale] = await Sale.create(
        [
          {
            machineId: machine._id,
            machineCode: machine.code,
            slotCode: slot.code,
            sku: slot.sku,
            priceCents: slot.priceCents,
            payment: parsed.data.payment,
            ts: parsed.data.ts ?? new Date(),
          },
        ],
        { session },
      );
    });

    // Alert rules run outside the transaction: a stockout alert failing to
    // write must not roll back a sale that physically happened.
    const chilled = await machineHoldsChilled(machine);
    await evaluateMachine({
      machine,
      reading: { ts: new Date(), coilFaults: [], cashCents: machine.cashCents },
      chilled,
    });

    res.status(201).json({ ok: true, sale, remaining: slot.qty });
  } catch (err) {
    next(err);
  } finally {
    await session.endSession();
  }
});

/**
 * Does this machine hold anything that must stay chilled? Drives whether the
 * temperature rule applies at all - a snack-only machine has no target range.
 */
async function machineHoldsChilled(machine) {
  const skus = [...new Set(machine.slots.map((s) => s.sku))];
  if (skus.length === 0) return false;
  const count = await Product.countDocuments({ sku: { $in: skus }, requiresChilled: true });
  return count > 0;
}
