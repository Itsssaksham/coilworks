import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { Machine } from '../models/Machine.js';

/* ------------------------------------------------------------------ *
 * Operator auth (humans) - JWT bearer tokens
 * ------------------------------------------------------------------ */

export function signOperatorToken(operator) {
  return jwt.sign(
    { sub: operator._id.toString(), email: operator.email, role: operator.role },
    config.jwtSecret,
    { expiresIn: config.jwtTtlSeconds },
  );
}

export function requireOperator(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  try {
    req.operator = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Route guard for operator roles. `requireRole('admin')` etc. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.operator) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.operator.role)) {
      return res.status(403).json({
        error: `This action requires the ${roles.join(' or ')} role. You are signed in as ${req.operator.role}.`,
        requiredRoles: roles,
        yourRole: req.operator.role,
      });
    }
    next();
  };
}

/**
 * Guard for anything that changes fleet state.
 *
 * The demo is deployed publicly with a shareable read-only login, so this
 * boundary is what stops a stranger resolving alerts or emptying a machine.
 * Enforced here on the server - hiding a button in the UI is presentation, not
 * a permission.
 */
export const requireWriteAccess = requireRole('dispatcher', 'admin');

/* ------------------------------------------------------------------ *
 * Machine auth (hardware) - per-machine API keys
 * ------------------------------------------------------------------ */

export function generateMachineKey() {
  // 32 bytes of CSPRNG output, base64url. The plaintext is returned once at
  // provisioning and never stored.
  const plain = `cwk_${crypto.randomBytes(32).toString('base64url')}`;
  return { plain, hash: hashMachineKey(plain), last4: plain.slice(-4) };
}

export function hashMachineKey(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

/**
 * Authenticate a telemetry POST as coming from a specific machine.
 *
 * Compares hashes with timingSafeEqual rather than `===`. The lookup is by hash
 * (indexed), so this guards the final comparison against a timing oracle.
 */
export async function requireMachine(req, res, next) {
  const key = req.get('x-machine-key');
  if (!key) return res.status(401).json({ error: 'Missing X-Machine-Key header' });

  const presented = hashMachineKey(key);
  const machine = await Machine.findOne({ code: req.params.code }).select('+apiKeyHash');
  if (!machine) return res.status(404).json({ error: 'Unknown machine' });

  const a = Buffer.from(presented, 'hex');
  const b = Buffer.from(machine.apiKeyHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid machine key' });
  }

  req.machine = machine;
  next();
}
