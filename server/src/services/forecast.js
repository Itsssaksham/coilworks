import mongoose from 'mongoose';
import { Machine } from '../models/Machine.js';
import { Sale } from '../models/Sale.js';

const MS_PER_DAY = 86_400_000;

/**
 * Per-slot stockout forecast across the fleet.
 *
 * Runs as one aggregation rather than a query-per-slot: unwind the planogram,
 * correlate each slot with its own sales over the window via a $lookup with a
 * pipeline, and derive the depletion rate and days-to-empty in $project.
 *
 * daysToEmpty = qty / (units sold per day). A slot with no sales in the window
 * has no meaningful rate, so it reports null rather than a fake infinity.
 *
 * @param {object}  opts
 * @param {number}  opts.windowDays  trailing window used to measure the rate
 * @param {number}  opts.horizonDays only return slots emptying within this many days
 * @param {string}  [opts.machineId] restrict to one machine
 */
export async function forecastStockouts({ windowDays = 14, horizonDays = 7, machineId } = {}) {
  const since = new Date(Date.now() - windowDays * MS_PER_DAY);

  const match = machineId ? { _id: new mongoose.Types.ObjectId(String(machineId)) } : {};

  return Machine.aggregate([
    { $match: match },
    { $unwind: '$slots' },
    {
      $lookup: {
        from: 'sales',
        let: { mid: '$_id', slot: '$slots.code' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$machineId', '$$mid'] },
                  { $eq: ['$slotCode', '$$slot'] },
                  { $gte: ['$ts', since] },
                ],
              },
            },
          },
          { $count: 'units' },
        ],
        as: 'window',
      },
    },
    {
      $addFields: {
        unitsSold: { $ifNull: [{ $first: '$window.units' }, 0] },
      },
    },
    {
      $addFields: {
        // Units per day over the measurement window.
        ratePerDay: { $divide: ['$unitsSold', windowDays] },
      },
    },
    {
      $addFields: {
        daysToEmpty: {
          $cond: [
            { $gt: ['$ratePerDay', 0] },
            { $divide: ['$slots.qty', '$ratePerDay'] },
            null, // no sales in the window - rate is unknown, not zero
          ],
        },
      },
    },
    {
      $match: {
        $or: [
          { daysToEmpty: { $ne: null, $lte: horizonDays } },
          { 'slots.qty': 0 }, // already empty: always surface it
        ],
      },
    },
    {
      $project: {
        _id: 0,
        machineId: '$_id',
        machineCode: '$code',
        machineName: '$name',
        siteName: 1,
        location: 1,
        slotCode: '$slots.code',
        sku: '$slots.sku',
        qty: '$slots.qty',
        capacity: '$slots.capacity',
        parLevel: '$slots.parLevel',
        unitsSold: 1,
        ratePerDay: { $round: ['$ratePerDay', 2] },
        daysToEmpty: { $round: ['$daysToEmpty', 1] },
      },
    },
    { $sort: { daysToEmpty: 1, qty: 1 } },
  ]);
}

/** Revenue and unit totals bucketed by hour, for the dashboard trend chart. */
export async function salesByHour({ hours = 24, machineId } = {}) {
  const since = new Date(Date.now() - hours * 3_600_000);
  const match = { ts: { $gte: since } };
  if (machineId) match.machineId = new mongoose.Types.ObjectId(String(machineId));

  const rows = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        // $dateTrunc buckets server-side; doing this in JS would mean pulling
        // every sale document over the wire.
        _id: { $dateTrunc: { date: '$ts', unit: 'hour' } },
        units: { $sum: 1 },
        revenueCents: { $sum: '$priceCents' },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, hour: '$_id', units: 1, revenueCents: 1 } },
  ]);

  // Fill gaps so the chart has a point per hour even when nothing sold.
  const byHour = new Map(rows.map((r) => [r.hour.getTime(), r]));
  const out = [];
  const start = new Date(Math.floor(since.getTime() / 3_600_000) * 3_600_000);
  for (let t = start.getTime(); t <= Date.now(); t += 3_600_000) {
    out.push(byHour.get(t) ?? { hour: new Date(t), units: 0, revenueCents: 0 });
  }
  return out;
}

/** Best sellers fleet-wide over a trailing window. */
export async function topProducts({ days = 7, limit = 10 } = {}) {
  const since = new Date(Date.now() - days * MS_PER_DAY);
  return Sale.aggregate([
    { $match: { ts: { $gte: since } } },
    {
      $group: {
        _id: '$sku',
        units: { $sum: 1 },
        revenueCents: { $sum: '$priceCents' },
      },
    },
    { $sort: { units: -1 } },
    { $limit: limit },
    {
      $lookup: { from: 'products', localField: '_id', foreignField: 'sku', as: 'product' },
    },
    {
      $project: {
        _id: 0,
        sku: '$_id',
        name: { $ifNull: [{ $first: '$product.name' }, '$_id'] },
        category: { $first: '$product.category' },
        units: 1,
        revenueCents: 1,
      },
    },
  ]);
}

/** One-query fleet health summary for the dashboard KPI row. */
export async function fleetSummary() {
  const [machineStats] = await Machine.aggregate([
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
        fill: [
          { $unwind: '$slots' },
          {
            $group: {
              _id: null,
              qty: { $sum: '$slots.qty' },
              capacity: { $sum: '$slots.capacity' },
              emptySlots: { $sum: { $cond: [{ $eq: ['$slots.qty', 0] }, 1, 0] } },
            },
          },
        ],
        cash: [{ $group: { _id: null, cents: { $sum: '$cashCents' } } }],
        total: [{ $count: 'n' }],
      },
    },
  ]);

  const byStatus = Object.fromEntries((machineStats.byStatus ?? []).map((r) => [r._id, r.n]));
  const fill = machineStats.fill?.[0] ?? { qty: 0, capacity: 0, emptySlots: 0 };

  const since = new Date(Date.now() - MS_PER_DAY);
  const [today] = await Sale.aggregate([
    { $match: { ts: { $gte: since } } },
    { $group: { _id: null, units: { $sum: 1 }, revenueCents: { $sum: '$priceCents' } } },
  ]);

  return {
    machines: {
      total: machineStats.total?.[0]?.n ?? 0,
      online: byStatus.online ?? 0,
      offline: byStatus.offline ?? 0,
      fault: byStatus.fault ?? 0,
    },
    inventory: {
      unitsOnHand: fill.qty,
      capacity: fill.capacity,
      fillRatio: fill.capacity ? Number((fill.qty / fill.capacity).toFixed(3)) : 1,
      emptySlots: fill.emptySlots,
    },
    cashOnHandCents: machineStats.cash?.[0]?.cents ?? 0,
    last24h: {
      units: today?.units ?? 0,
      revenueCents: today?.revenueCents ?? 0,
    },
  };
}
