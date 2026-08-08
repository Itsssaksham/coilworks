import express from 'express';
import { z } from 'zod';
import { Machine } from '../models/Machine.js';
import { RestockRun } from '../models/RestockRun.js';
import { requireOperator, requireWriteAccess } from '../middleware/auth.js';
import { planRoute, haversineMeters } from '../services/geo.js';
import { forecastStockouts } from '../services/forecast.js';

export const runsRouter = express.Router();

runsRouter.use(requireOperator);

const planSchema = z.object({
  name: z.string().min(1).max(80),
  depotLat: z.number().min(-90).max(90),
  depotLng: z.number().min(-180).max(180),
  horizonDays: z.number().min(0.5).max(30).default(4),
  maxStops: z.number().int().min(1).max(40).default(12),
});

/**
 * POST /api/runs/plan - build a restock run.
 *
 * Which machines to visit comes from the forecast (what will actually run out),
 * not from a fixed schedule. What order to visit them in comes from the route
 * planner. The result is a driver-ready list: stops in order, with the pick list
 * for each.
 */
runsRouter.post('/plan', requireWriteAccess, async (req, res, next) => {
  try {
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid plan request', issues: parsed.error.issues });
    }
    const { name, depotLat, depotLng, horizonDays, maxStops } = parsed.data;
    const depot = [depotLng, depotLat];

    // 1. What needs stock, and how urgently.
    const forecast = await forecastStockouts({ horizonDays });
    if (forecast.length === 0) {
      return res.status(200).json({ run: null, reason: 'Nothing is forecast to run out in this window.' });
    }

    // 2. Group slot-level rows into machine-level stops.
    const byMachine = new Map();
    for (const row of forecast) {
      const key = row.machineId.toString();
      if (!byMachine.has(key)) {
        byMachine.set(key, {
          machineId: row.machineId,
          machineCode: row.machineCode,
          name: row.machineName,
          siteName: row.siteName,
          location: row.location,
          picks: [],
          urgency: Infinity,
        });
      }
      const stop = byMachine.get(key);
      stop.picks.push({
        slotCode: row.slotCode,
        sku: row.sku,
        qty: Math.max(0, row.capacity - row.qty), // fill the slot
      });
      stop.urgency = Math.min(stop.urgency, row.daysToEmpty ?? 0);
    }

    // 3. Most urgent machines first, capped at what fits in one round.
    const candidates = [...byMachine.values()]
      .sort((a, b) => a.urgency - b.urgency)
      .slice(0, maxStops);

    // 4. Order them into a route.
    const { ordered, totalMeters } = planRoute({ depot, stops: candidates });

    const machines = await Machine.find({ _id: { $in: ordered.map((s) => s.machineId) } })
      .select('code address')
      .lean();
    const addressByCode = new Map(machines.map((m) => [m.code, m.address]));

    let cursor = depot;
    const stops = ordered.map((stop, i) => {
      const legMeters = haversineMeters(cursor, stop.location.coordinates);
      cursor = stop.location.coordinates;
      return {
        machineId: stop.machineId,
        machineCode: stop.machineCode,
        name: stop.name,
        address: addressByCode.get(stop.machineCode) ?? stop.siteName,
        location: stop.location,
        order: i + 1,
        legMeters: Math.round(legMeters),
        picks: stop.picks,
        unitsToLoad: stop.picks.reduce((n, p) => n + p.qty, 0),
      };
    });

    const run = await RestockRun.create({
      name,
      depot: { type: 'Point', coordinates: depot },
      stops,
      totalMeters: Math.round(totalMeters),
      totalUnits: stops.reduce((n, s) => n + s.unitsToLoad, 0),
      createdBy: req.operator.email,
    });

    res.status(201).json({ run });
  } catch (err) {
    next(err);
  }
});

/** GET /api/runs - recent runs. */
runsRouter.get('/', async (req, res, next) => {
  try {
    const query = req.query.status ? { status: req.query.status } : {};
    res.json(await RestockRun.find(query).sort({ createdAt: -1 }).limit(50).lean());
  } catch (err) {
    next(err);
  }
});

/** GET /api/runs/:id */
runsRouter.get('/:id', async (req, res, next) => {
  try {
    const run = await RestockRun.findById(req.params.id).lean();
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    next(err);
  }
});

const statusSchema = z.object({
  status: z.enum(['planned', 'in_progress', 'completed', 'cancelled']),
});

/** POST /api/runs/:id/status */
runsRouter.post('/:id/status', requireWriteAccess, async (req, res, next) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid status' });

    const patch = { status: parsed.data.status };
    if (parsed.data.status === 'in_progress') patch.startedAt = new Date();
    if (parsed.data.status === 'completed') patch.completedAt = new Date();

    const run = await RestockRun.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  } catch (err) {
    next(err);
  }
});
