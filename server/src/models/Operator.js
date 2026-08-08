import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const operatorSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'dispatcher', 'driver'], default: 'dispatcher' },
  },
  { timestamps: true },
);

operatorSchema.statics.hashPassword = (plain) => bcrypt.hash(plain, 10);

operatorSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

operatorSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

export const Operator = mongoose.model('Operator', operatorSchema);
