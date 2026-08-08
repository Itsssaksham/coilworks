import mongoose from 'mongoose';

const saleSchema = new mongoose.Schema(
  {
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine', required: true },
    machineCode: { type: String, required: true }, // denormalized for reporting
    slotCode: { type: String, required: true },
    sku: { type: String, required: true },
    priceCents: { type: Number, required: true, min: 0 },
    payment: { type: String, enum: ['card', 'cash', 'mobile'], required: true },
    ts: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

// Depletion-rate aggregations scan one machine over a window - this is the
// covering index for them.
saleSchema.index({ machineId: 1, ts: -1 });
saleSchema.index({ machineId: 1, slotCode: 1, ts: -1 });
// Fleet-wide "what sells" rollups.
saleSchema.index({ ts: -1 });
saleSchema.index({ sku: 1, ts: -1 });

saleSchema.set('toJSON', { transform: (_d, ret) => (delete ret.__v, ret) });

export const Sale = mongoose.model('Sale', saleSchema);
