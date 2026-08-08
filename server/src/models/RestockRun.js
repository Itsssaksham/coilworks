import mongoose from 'mongoose';

const pickSchema = new mongoose.Schema(
  { slotCode: String, sku: String, qty: Number },
  { _id: false },
);

const stopSchema = new mongoose.Schema(
  {
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine', required: true },
    machineCode: String,
    name: String,
    address: String,
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: [Number],
    },
    order: Number, // 1-based visit order along the planned route
    legMeters: Number, // distance from the previous stop (or depot for stop 1)
    picks: { type: [pickSchema], default: [] },
    unitsToLoad: Number,
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

const restockRunSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ['planned', 'in_progress', 'completed', 'cancelled'],
      default: 'planned',
      index: true,
    },
    depot: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: [Number],
    },
    stops: { type: [stopSchema], default: [] },
    totalMeters: { type: Number, default: 0 },
    totalUnits: { type: Number, default: 0 },
    createdBy: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

restockRunSchema.index({ status: 1, createdAt: -1 });

restockRunSchema.set('toJSON', { transform: (_d, ret) => (delete ret.__v, ret) });

export const RestockRun = mongoose.model('RestockRun', restockRunSchema);
