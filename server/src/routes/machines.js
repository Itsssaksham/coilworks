import express from 'express';
import { z } from 'zod';
import { Machine } from '../models/Machine.js';
import { Alert } from '../models/Alert.js';
import { Telemetry } from '../models/Telemetry.js';
import { requireOperator, requireRole, generateMachineKey } from '../middleware/auth.js';
import { nearestMachines } from '../services/geo.js';
import { containsFilter, parsePaging } from '../util/query.js';

export const machinesRouter = express.Router();

machinesRouter.use(requireOperator);

/**
 * GET /api/machines - fleet list, optionally filtered or sorted by distance.
 *
 * Paginated. Returns `{ machines, total, limit, offset }` rather than a bare
 * array: an unbounded list is fine at fleet-of-16 scale and a problem at
 * fleet-of-10,000, where it balloons the response and holds the whole result
 * set in memory on both ends.
 */
machinesRouter.get('/', async (req, res, next) => {
  try {
    const { status, site, lat, lng, radiusKm } = req.query;
    const { limit, offset } = parsePaging(req.query, { defaultLimit: 100, maxLimit: 500 });

    if (lat && lng) {
      const rows = await nearestMachines({
        coordinates: [Number(lng), Number(lat)],
        maxMeters: (Number(radiusKm) || 25) * 1000,
        limit,
        filter: status ? { status } : {},
      });
      return res.json({ machines: rows, total: rows.length, limit, offset: 0 });
    }

    const query = {};
    if (status) query.status = status;
    // Escaped: the raw value would let a caller supply a catastrophically
    // backtracking pattern and pin a CPU core.
    if (site) query.siteName = containsFilter(site);

    // Sorted by the {status, lastSeenAt} index: problems first, then staleness.
    const [machines, total] = await Promise.all([
      Machine.find(query).sort({ status: 1, lastSeenAt: -1 }).skip(offset).limit(limit).lean(),
      Machine.countDocuments(query),
    ]);

    res.json({ machines, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

/** GET /api/machines/:code - detail, open alerts, and recent telemetry. */
machinesRouter.get('/:code', async (req, res, next) => {
  try {
    const machine = await Machine.findOne({ code: req.params.code.toUpperCase() });
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const [alerts, telemetry] = await Promise.all([
      Alert.find({ machineId: machine._id, status: { $ne: 'resolved' } })
        .sort({ openedAt: -1 })
        .lean(),
      Telemetry.find({ machineId: machine._id }).sort({ ts: -1 }).limit(120).lean(),
    ]);

    res.json({
      machine: machine.toJSON(),
      alerts,
      telemetry: telemetry.reverse(), // oldest first for charting
      lowSlots: machine.lowSlots(),
      fillRatio: machine.fillRatio(),
    });
  } catch (err) {
    next(err);
  }
});

const provisionSchema = z.object({
  code: z.string().regex(/^VM-\d{4}$/, 'code must look like VM-0142'),
  name: z.string().min(1),
  model: z.string().min(1),
  firmware: z.string().min(1),
  siteName: z.string().min(1),
  address: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/**
 * POST /api/machines - provision a machine and mint its ingest key.
 *
 * The plaintext key is returned exactly once, in this response. Only its hash
 * is stored, so it cannot be recovered later - a lost key is re-minted, not
 * looked up.
 */
machinesRouter.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const parsed = provisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid machine', issues: parsed.error.issues });
    }
    const { lat, lng, ...rest } = parsed.data;
    const key = generateMachineKey();

    const machine = await Machine.create({
      ...rest,
      location: { type: 'Point', coordinates: [lng, lat] },
      apiKeyHash: key.hash,
      apiKeyLast4: key.last4,
    });

    res.status(201).json({
      machine: machine.toJSON(),
      machineKey: key.plain,
      notice: 'Store this key now. It is not recoverable.',
    });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: 'That machine code already exists' });
    next(err);
  }
});

const restockSchema = z.object({
  picks: z
    .array(z.object({ slotCode: z.string(), qty: z.number().int().min(1).max(100) }))
    .min(1),
});

/**
 * POST /api/machines/:code/restock - record units loaded into slots.
 *
 * Clamps at slot capacity rather than rejecting an over-count: a driver
 * reporting 12 into a slot with room for 10 loaded 10, and the run should
 * record what physically fits.
 */
machinesRouter.post('/:code/restock', async (req, res, next) => {
  try {
    const parsed = restockSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid restock', issues: parsed.error.issues });
    }

    const machine = await Machine.findOne({ code: req.params.code.toUpperCase() });
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const applied = [];
    for (const pick of parsed.data.picks) {
      const slot = machine.slots.find((s) => s.code === pick.slotCode);
      if (!slot) continue;
      const before = slot.qty;
      slot.qty = Math.min(slot.capacity, slot.qty + pick.qty);
      applied.push({ slotCode: slot.code, loaded: slot.qty - before, qty: slot.qty });
    }

    await machine.save();

    // Restocking is what clears stock alerts - re-run the rules so the queue
    // reflects the visit instead of waiting for the next heartbeat.
    const { evaluateMachine } = await import('../services/alerts.js');
    await evaluateMachine({
      machine,
      reading: { ts: new Date(), coilFaults: [], cashCents: machine.cashCents },
      chilled: false,
    });

    res.json({ ok: true, applied, fillRatio: machine.fillRatio() });
  } catch (err) {
    next(err);
  }
});
