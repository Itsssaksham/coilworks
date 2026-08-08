import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    category: {
      type: String,
      required: true,
      enum: ['soda', 'water', 'energy', 'snack', 'candy', 'coffee'],
      index: true,
    },
    costCents: { type: Number, required: true, min: 0 }, // what we pay
    listPriceCents: { type: Number, required: true, min: 0 }, // default vend price
    // Chilled products drive the temperature alert threshold for a machine.
    requiresChilled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

productSchema.set('toJSON', { transform: (_d, ret) => (delete ret.__v, ret) });

export const Product = mongoose.model('Product', productSchema);
