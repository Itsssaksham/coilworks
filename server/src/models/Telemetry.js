import mongoose from 'mongoose';

/**
 * Backed by the native time-series collection created in db.js.
 *
 * Two constraints come with that and both are load-bearing:
 *  - `ts` is the timeField and `machineId` the metaField, so neither may be
 *    changed after insert. Telemetry is append-only by design.
 *  - Documents in a time-series collection cannot be updated or deleted
 *    individually; MongoDB expires them via expireAfterSeconds instead.
 */
const telemetrySchema = new mongoose.Schema(
  {
    ts: { type: Date, required: true },
    machineId: { type: mongoose.Schema.Types.ObjectId, required: true },

    temperatureC: Number,
    doorOpen: Boolean,
    cashCents: Number,
    powerOk: Boolean,
    signalStrength: Number, // 0-100
    // Slot codes the controller reported as jammed on this tick.
    coilFaults: { type: [String], default: [] },
    uptimeSeconds: Number,
  },
  {
    versionKey: false,
    // Tell Mongoose this collection already exists as time-series so it does
    // not try to create an ordinary one or add an _id index.
    timeseries: { timeField: 'ts', metaField: 'machineId', granularity: 'minutes' },
    autoCreate: false,
    autoIndex: false,
  },
);

export const Telemetry = mongoose.model('Telemetry', telemetrySchema, 'telemetry');
