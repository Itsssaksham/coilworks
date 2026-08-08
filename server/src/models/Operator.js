import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const operatorSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    /**
     * viewer     - read everything, change nothing. The role a public demo
     *              login gets, so a stranger can explore the fleet without
     *              being able to resolve alerts or empty a machine.
     * driver     - read, plus completing stops on a run assigned to them.
     * dispatcher - read plus fleet mutations: restock, alerts, planning runs.
     * admin      - everything, including provisioning machines and minting keys.
     */
    role: {
      type: String,
      enum: ['viewer', 'driver', 'dispatcher', 'admin'],
      default: 'viewer', // least privilege by default; escalation is explicit
    },
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
