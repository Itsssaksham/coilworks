import mongoose from 'mongoose';

export const ALERT_TYPES = [
  'offline', // no heartbeat within the grace window
  'temperature', // chilled machine drifted out of range
  'stockout', // a slot hit zero
  'low_stock', // a slot fell to or below par
  'jam', // spiral turned without vending
  'cash_full', // cash box near capacity
  'door_open', // door held open outside a service visit
  'power', // mains dropped, running on backup
];

export const SEVERITIES = ['critical', 'warning', 'info'];

const alertSchema = new mongoose.Schema(
  {
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine', required: true },
    machineCode: { type: String, required: true },
    type: { type: String, enum: ALERT_TYPES, required: true },
    severity: { type: String, enum: SEVERITIES, required: true },
    status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open' },

    message: { type: String, required: true },
    // Whatever the rule saw when it fired - the evidence behind the alert, and
    // the input the AI triage reasons over.
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Deduplication key. One open alert per (machine, type, subject) - a slot
    // that is low does not create a new alert every telemetry tick.
    dedupeKey: { type: String, required: true },

    openedAt: { type: Date, default: Date.now },
    acknowledgedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },

    // Filled by the AI triage layer on demand, cached so a re-open of the same
    // alert doesn't pay for another model call.
    triage: {
      diagnosis: { type: String, default: null },
      likelyCause: { type: String, default: null },
      recommendedAction: { type: String, default: null },
      dispatchRequired: { type: Boolean, default: null },
      confidence: { type: Number, default: null },
      provider: { type: String, default: null }, // "claude" | "offline"
      model: { type: String, default: null },
      generatedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

// Only one OPEN alert may exist per dedupe key; resolved ones are excluded from
// the constraint so the same fault can legitimately recur later.
alertSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['open', 'acknowledged'] } } },
);
alertSchema.index({ status: 1, severity: 1, openedAt: -1 });
alertSchema.index({ machineId: 1, status: 1 });

alertSchema.set('toJSON', { transform: (_d, ret) => (delete ret.__v, ret) });

export const Alert = mongoose.model('Alert', alertSchema);
