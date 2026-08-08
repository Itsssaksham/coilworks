import mongoose from 'mongoose';

/**
 * One selection slot in the planogram (spiral A1, B4, ...). Slots live embedded
 * in the machine because they are never queried independently of it and are
 * always read and written as a unit.
 */
const slotSchema = new mongoose.Schema(
  {
    code: { type: String, required: true }, // "A1"
    sku: { type: String, required: true, ref: 'Product' },
    capacity: { type: Number, required: true, min: 1 },
    qty: { type: Number, required: true, min: 0 },
    // Restock threshold. Below this the slot is "low" and joins the pick list.
    parLevel: { type: Number, required: true, min: 0 },
    priceCents: { type: Number, required: true, min: 0 },
    // A spiral that turned without vending. Blocks the slot until cleared on site.
    jammed: { type: Boolean, default: false },
  },
  { _id: false },
);

const machineSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true }, // "VM-0142"
    name: { type: String, required: true },
    model: { type: String, required: true }, // hardware model
    firmware: { type: String, required: true },

    siteName: { type: String, required: true },
    address: { type: String, required: true },

    // GeoJSON Point, [longitude, latitude] - note the order, it is not lat/lng.
    // Indexed 2dsphere so $geoNear and $geoWithin can run against it.
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: {
        type: [Number],
        required: true,
        validate: {
          validator: (v) => v.length === 2 && v[0] >= -180 && v[0] <= 180 && v[1] >= -90 && v[1] <= 90,
          message: 'location.coordinates must be [longitude, latitude]',
        },
      },
    },

    status: {
      type: String,
      enum: ['online', 'offline', 'fault'],
      default: 'offline',
      index: true,
    },
    lastSeenAt: { type: Date, default: null, index: true },

    // Latest reading, denormalized off the telemetry stream so the fleet list
    // renders from one query instead of one aggregation per machine.
    temperatureC: { type: Number, default: null },
    doorOpen: { type: Boolean, default: false },
    cashCents: { type: Number, default: 0 },
    cashCapacityCents: { type: Number, default: 40000 },
    signalStrength: { type: Number, default: null }, // 0-100

    slots: { type: [slotSchema], default: [] },

    // Per-machine ingest credential. Stored hashed - the plaintext is shown
    // once at provisioning and never persisted.
    apiKeyHash: { type: String, required: true, select: false },
    apiKeyLast4: { type: String, required: true },
  },
  { timestamps: true },
);

machineSchema.index({ location: '2dsphere' });
// Fleet list sorts by status then staleness; this covers it without a fetch-sort.
machineSchema.index({ status: 1, lastSeenAt: -1 });

/** Slots at or below par, worst first - the restock pick list for this machine. */
machineSchema.methods.lowSlots = function lowSlots() {
  return this.slots
    .filter((s) => s.qty <= s.parLevel)
    .sort((a, b) => a.qty / a.capacity - b.qty / b.capacity);
};

/** 0-1. How full the machine is overall, weighted by slot capacity. */
machineSchema.methods.fillRatio = function fillRatio() {
  const capacity = this.slots.reduce((n, s) => n + s.capacity, 0);
  if (capacity === 0) return 1;
  return this.slots.reduce((n, s) => n + s.qty, 0) / capacity;
};

machineSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.apiKeyHash;
    delete ret.__v;
    return ret;
  },
});

export const Machine = mongoose.model('Machine', machineSchema);
