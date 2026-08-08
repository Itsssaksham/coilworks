import { Machine } from '../../models/Machine.js';
import { Alert } from '../../models/Alert.js';
import { forecastStockouts, topProducts, fleetSummary } from '../forecast.js';
import { nearestMachines } from '../geo.js';
import { containsFilter } from '../../util/query.js';

/**
 * The tool surface exposed to the ops assistant.
 *
 * Every tool here is READ-ONLY by construction. The assistant answers questions
 * about the fleet; it cannot dispatch a technician, edit a planogram, or
 * acknowledge an alert. Those are operator actions behind the authenticated UI,
 * and keeping them out of the model's reach means a prompt-injected answer can
 * mislead a reader but cannot change fleet state.
 *
 * Descriptions say WHEN to call each tool, not just what it does - that is what
 * drives correct tool selection.
 */
export const TOOL_DEFS = [
  {
    name: 'fleet_summary',
    description:
      'Overall fleet health: machine counts by status, units on hand, fill ratio, cash on hand, and last-24h sales. ' +
      'Call this for broad questions like "how is the fleet doing" or when you need context before a narrower query.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'find_machines',
    description:
      'List machines, optionally filtered by status or site, or sorted by distance from a coordinate. ' +
      'Call this when the user asks which machines are offline/faulted, what is at a given site, or what is near a location.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['online', 'offline', 'fault'] },
        siteName: { type: 'string', description: 'Case-insensitive substring match on the site name.' },
        nearLat: { type: 'number', description: 'Latitude to search from. Must be paired with nearLng.' },
        nearLng: { type: 'number', description: 'Longitude to search from. Must be paired with nearLat.' },
        radiusKm: { type: 'number', description: 'Search radius in km when nearLat/nearLng are given. Default 25.' },
        limit: { type: 'number', description: 'Max machines to return. Default 20, max 50.' },
      },
      required: [],
    },
  },
  {
    name: 'get_machine',
    description:
      'Full detail for one machine by its code (for example "VM-0142"): planogram with per-slot quantities, ' +
      'latest readings, and its open alerts. Call this when the user names a specific machine.',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Machine code, e.g. VM-0142.' } },
      required: ['code'],
    },
  },
  {
    name: 'forecast_stockouts',
    description:
      'Slots projected to hit zero within a horizon, based on measured depletion rate. ' +
      'Call this for anything about running out, what to restock, or which machines need a visit soonest.',
    input_schema: {
      type: 'object',
      properties: {
        horizonDays: { type: 'number', description: 'Only return slots emptying within this many days. Default 7.' },
        machineCode: { type: 'string', description: 'Restrict to one machine.' },
      },
      required: [],
    },
  },
  {
    name: 'list_alerts',
    description:
      'The alert queue, filterable by status, severity, and type. ' +
      'Call this when the user asks what is wrong, what needs attention, or about a class of fault.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'acknowledged', 'resolved'] },
        severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
        type: {
          type: 'string',
          enum: ['offline', 'temperature', 'stockout', 'low_stock', 'jam', 'cash_full', 'door_open', 'power'],
        },
        limit: { type: 'number', description: 'Default 20, max 50.' },
      },
      required: [],
    },
  },
  {
    name: 'sales_summary',
    description:
      'Best-selling products fleet-wide over a trailing window, with units and revenue. ' +
      'Call this for questions about what sells, revenue, or product performance.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Trailing window in days. Default 7.' },
        limit: { type: 'number', description: 'How many products. Default 10.' },
      },
      required: [],
    },
  },
];

const clamp = (n, lo, hi, fallback) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

/**
 * Execute one tool call. Inputs come from the model, so every one is clamped or
 * validated here rather than trusted.
 */
export async function runTool(name, input = {}) {
  switch (name) {
    case 'fleet_summary':
      return fleetSummary();

    case 'find_machines': {
      const limit = clamp(input.limit, 1, 50, 20);

      if (input.nearLat != null && input.nearLng != null) {
        const filter = {};
        if (input.status) filter.status = input.status;
        const rows = await nearestMachines({
          coordinates: [Number(input.nearLng), Number(input.nearLat)],
          maxMeters: clamp(input.radiusKm, 0.1, 500, 25) * 1000,
          limit,
          filter,
        });
        return rows.map((m) => ({
          code: m.code, name: m.name, site: m.siteName, status: m.status,
          distanceKm: Number((m.distanceMeters / 1000).toFixed(2)),
        }));
      }

      const query = {};
      if (input.status) query.status = input.status;
      // Escaped, not interpolated: this input is model-generated, so it is the
      // last place to hand a caller control of a regex.
      if (input.siteName) query.siteName = containsFilter(input.siteName);

      const machines = await Machine.find(query).limit(limit).lean();
      return machines.map((m) => ({
        code: m.code,
        name: m.name,
        site: m.siteName,
        status: m.status,
        lastSeenAt: m.lastSeenAt,
        fillPct: Math.round(
          (m.slots.reduce((n, s) => n + s.qty, 0) /
            Math.max(1, m.slots.reduce((n, s) => n + s.capacity, 0))) * 100,
        ),
      }));
    }

    case 'get_machine': {
      const machine = await Machine.findOne({ code: String(input.code || '').toUpperCase() }).lean();
      if (!machine) return { error: `No machine with code ${input.code}` };
      const alerts = await Alert.find({ machineId: machine._id, status: 'open' }).lean();
      return {
        code: machine.code,
        name: machine.name,
        site: machine.siteName,
        address: machine.address,
        model: machine.model,
        firmware: machine.firmware,
        status: machine.status,
        lastSeenAt: machine.lastSeenAt,
        temperatureC: machine.temperatureC,
        cashCents: machine.cashCents,
        slots: machine.slots.map((s) => ({
          code: s.code, sku: s.sku, qty: s.qty, capacity: s.capacity,
          parLevel: s.parLevel, priceCents: s.priceCents, jammed: s.jammed,
        })),
        openAlerts: alerts.map((a) => ({ type: a.type, severity: a.severity, message: a.message })),
      };
    }

    case 'forecast_stockouts': {
      let machineId;
      if (input.machineCode) {
        const m = await Machine.findOne({ code: String(input.machineCode).toUpperCase() }).select('_id').lean();
        if (!m) return { error: `No machine with code ${input.machineCode}` };
        machineId = m._id;
      }
      const rows = await forecastStockouts({
        horizonDays: clamp(input.horizonDays, 0.5, 60, 7),
        machineId,
      });
      return rows.slice(0, 40).map((r) => ({
        machine: r.machineCode, site: r.siteName, slot: r.slotCode, sku: r.sku,
        qty: r.qty, ratePerDay: r.ratePerDay, daysToEmpty: r.daysToEmpty,
      }));
    }

    case 'list_alerts': {
      const query = {};
      if (input.status) query.status = input.status;
      if (input.severity) query.severity = input.severity;
      if (input.type) query.type = input.type;
      const alerts = await Alert.find(query)
        .sort({ openedAt: -1 })
        .limit(clamp(input.limit, 1, 50, 20))
        .lean();
      return alerts.map((a) => ({
        machine: a.machineCode, type: a.type, severity: a.severity,
        status: a.status, message: a.message, openedAt: a.openedAt,
      }));
    }

    case 'sales_summary':
      return topProducts({
        days: clamp(input.days, 1, 90, 7),
        limit: clamp(input.limit, 1, 25, 10),
      });

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
