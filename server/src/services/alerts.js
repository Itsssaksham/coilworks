import { Alert } from '../models/Alert.js';

/**
 * Grace period before a silent machine is called offline. Controllers heartbeat
 * every ~30s, so this tolerates a few dropped beats without crying wolf.
 */
export const OFFLINE_AFTER_MS = 3 * 60 * 1000;

/** Acceptable range for a machine holding chilled product. */
export const CHILLED_RANGE_C = { min: 1, max: 7 };

/** Fraction of cash capacity at which the box needs collecting. */
export const CASH_FULL_RATIO = 0.85;

/**
 * Raise an alert, or leave the existing one alone if it is already open.
 *
 * The dedupe key is what makes this idempotent: telemetry arrives every few
 * seconds and a slot that is low stays low, so without this the alert queue
 * would be thousands of copies of the same fact. The unique partial index on
 * Alert enforces it at the database level too, so two concurrent ingest
 * requests cannot both win.
 *
 * @returns {Promise<{alert: object, created: boolean}>}
 */
export async function raiseAlert({ machine, type, severity, message, detail = {}, subject = '' }) {
  const dedupeKey = [machine._id.toString(), type, subject].filter(Boolean).join(':');

  const existing = await Alert.findOne({ dedupeKey, status: { $in: ['open', 'acknowledged'] } });
  if (existing) return { alert: existing, created: false };

  try {
    const alert = await Alert.create({
      machineId: machine._id,
      machineCode: machine.code,
      type,
      severity,
      message,
      detail,
      dedupeKey,
    });
    return { alert, created: true };
  } catch (err) {
    // Lost a race against a concurrent insert - the index did its job.
    if (err?.code === 11000) {
      const alert = await Alert.findOne({ dedupeKey, status: { $in: ['open', 'acknowledged'] } });
      return { alert, created: false };
    }
    throw err;
  }
}

/** Resolve any open alert matching a dedupe key. Used when a condition clears. */
export async function clearAlert({ machineId, type, subject = '' }) {
  const dedupeKey = [machineId.toString(), type, subject].filter(Boolean).join(':');
  return Alert.findOneAndUpdate(
    { dedupeKey, status: { $in: ['open', 'acknowledged'] } },
    { status: 'resolved', resolvedAt: new Date() },
    { new: true },
  );
}

/**
 * Evaluate every rule against one telemetry tick and the machine it came from.
 *
 * Rules are pure with respect to their inputs: given the same machine state and
 * reading they always produce the same alerts. That is what lets the simulator
 * be deterministic and the smoke test assert on outcomes.
 *
 * @returns {Promise<Array<{alert: object, created: boolean}>>} newly created alerts only
 */
export async function evaluateMachine({ machine, reading, chilled }) {
  const raised = [];
  const push = (r) => { if (r.created) raised.push(r.alert); };

  // --- Temperature -------------------------------------------------------
  if (chilled && reading.temperatureC != null) {
    const { min, max } = CHILLED_RANGE_C;
    if (reading.temperatureC > max || reading.temperatureC < min) {
      push(
        await raiseAlert({
          machine,
          type: 'temperature',
          severity: reading.temperatureC > max + 4 ? 'critical' : 'warning',
          message: `Chiller out of range at ${reading.temperatureC.toFixed(1)}C (target ${min}-${max}C)`,
          detail: { temperatureC: reading.temperatureC, min, max },
        }),
      );
    } else {
      await clearAlert({ machineId: machine._id, type: 'temperature' });
    }
  }

  // --- Power -------------------------------------------------------------
  if (reading.powerOk === false) {
    push(
      await raiseAlert({
        machine,
        type: 'power',
        severity: 'critical',
        message: 'Mains power lost - running on backup',
        detail: { since: reading.ts },
      }),
    );
  } else {
    await clearAlert({ machineId: machine._id, type: 'power' });
  }

  // --- Coil jams ---------------------------------------------------------
  const faulting = new Set(reading.coilFaults ?? []);

  for (const slotCode of faulting) {
    push(
      await raiseAlert({
        machine,
        type: 'jam',
        severity: 'warning',
        subject: slotCode,
        message: `Spiral ${slotCode} turned without vending`,
        detail: { slotCode },
      }),
    );
  }

  // A slot the controller no longer reports as faulting has been cleared - on a
  // service visit, or because the obstruction shifted. Resolve its alert.
  //
  // Without this a jam alert stayed open forever: `machine.slots[].jammed` was
  // reset on every heartbeat but the alert was not, so the queue accumulated
  // jams that had physically been fixed - and an alert queue that only grows
  // stops being read.
  //
  // ASSUMPTION, and the one worth challenging: this trusts the controller to
  // LATCH a jam until it is serviced, so that absence of the fault in a reading
  // means resolved. That is how `slot.jammed` already behaves, so the two stay
  // consistent. It would be wrong for a controller that only reports a fault at
  // the moment a vend fails - then a slot nobody buys from would look healthy,
  // and the alert would close on a jam that is still physically there. If a
  // real controller behaves that way, clear on a *successful vend* from the
  // slot instead, which is positive evidence rather than absence of evidence.
  for (const slot of machine.slots) {
    if (!faulting.has(slot.code)) {
      await clearAlert({ machineId: machine._id, type: 'jam', subject: slot.code });
    }
  }

  // --- Cash box ----------------------------------------------------------
  if (machine.cashCapacityCents > 0 && reading.cashCents / machine.cashCapacityCents >= CASH_FULL_RATIO) {
    push(
      await raiseAlert({
        machine,
        type: 'cash_full',
        severity: 'warning',
        message: `Cash box ${Math.round((reading.cashCents / machine.cashCapacityCents) * 100)}% full`,
        detail: { cashCents: reading.cashCents, capacityCents: machine.cashCapacityCents },
      }),
    );
  } else {
    await clearAlert({ machineId: machine._id, type: 'cash_full' });
  }

  // --- Stock -------------------------------------------------------------
  for (const slot of machine.slots) {
    if (slot.qty === 0) {
      push(
        await raiseAlert({
          machine,
          type: 'stockout',
          severity: 'critical',
          subject: slot.code,
          message: `${slot.sku} sold out in slot ${slot.code}`,
          detail: { slotCode: slot.code, sku: slot.sku, capacity: slot.capacity },
        }),
      );
    } else if (slot.qty <= slot.parLevel) {
      // A slot that recovers past par clears its own stockout alert.
      await clearAlert({ machineId: machine._id, type: 'stockout', subject: slot.code });
      push(
        await raiseAlert({
          machine,
          type: 'low_stock',
          severity: 'info',
          subject: slot.code,
          message: `${slot.sku} low in slot ${slot.code} (${slot.qty}/${slot.capacity})`,
          detail: { slotCode: slot.code, sku: slot.sku, qty: slot.qty, parLevel: slot.parLevel },
        }),
      );
    } else {
      await clearAlert({ machineId: machine._id, type: 'stockout', subject: slot.code });
      await clearAlert({ machineId: machine._id, type: 'low_stock', subject: slot.code });
    }
  }

  return raised;
}

/**
 * Sweep for machines that have stopped heartbeating.
 *
 * This cannot be driven by telemetry - the signal is the *absence* of it - so
 * it runs on a timer instead.
 */
export async function sweepOfflineMachines(Machine) {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);
  const stale = await Machine.find({
    status: { $ne: 'offline' },
    lastSeenAt: { $lt: cutoff },
  });

  const raised = [];
  for (const machine of stale) {
    machine.status = 'offline';
    await machine.save();
    const r = await raiseAlert({
      machine,
      type: 'offline',
      severity: 'critical',
      message: `No heartbeat since ${machine.lastSeenAt?.toISOString() ?? 'never'}`,
      detail: { lastSeenAt: machine.lastSeenAt, graceMs: OFFLINE_AFTER_MS },
    });
    if (r.created) raised.push(r.alert);
  }
  return raised;
}
