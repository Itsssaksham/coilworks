import express from 'express';
import { z } from 'zod';
import { Operator } from '../models/Operator.js';
import { signOperatorToken, requireOperator } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { issueTicket } from '../realtime/tickets.js';

export const authRouter = express.Router();

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Tight budget per IP - login is the one endpoint worth guessing at.
const loginLimit = rateLimit({ windowMs: 60_000, max: 10 });

authRouter.post('/login', loginLimit, async (req, res, next) => {
  try {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Email and password required' });

    const operator = await Operator.findOne({ email: parsed.data.email }).select('+passwordHash');
    // Same response for unknown email and wrong password - no account enumeration.
    const ok = operator && (await operator.verifyPassword(parsed.data.password));
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    res.json({ token: signOperatorToken(operator), operator: operator.toJSON() });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/ws-ticket
 *
 * Mint a short-lived, single-use ticket for the WebSocket upgrade.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the credential has
 * to ride in the URL - and URLs land in proxy logs, access logs, and browser
 * history. Putting the session JWT there would leak a long-lived credential
 * into all three. A ticket expires in 30 seconds and dies on first use.
 */
authRouter.post('/ws-ticket', requireOperator, (req, res) => {
  res.json(issueTicket(req.operator));
});

authRouter.get('/me', requireOperator, async (req, res, next) => {
  try {
    const operator = await Operator.findById(req.operator.sub);
    if (!operator) return res.status(404).json({ error: 'Operator no longer exists' });
    res.json(operator.toJSON());
  } catch (err) {
    next(err);
  }
});
