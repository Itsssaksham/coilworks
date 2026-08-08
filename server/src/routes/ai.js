import express from 'express';
import { z } from 'zod';
import { requireOperator } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { askAssistant } from '../services/llm/assistant.js';
import { providerInfo } from '../services/llm/client.js';

export const aiRouter = express.Router();

aiRouter.use(requireOperator);

// Model calls cost money and take seconds; cap what one operator can spend.
const askLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyFn: (req) => `ai:${req.operator?.sub ?? req.ip}`,
});

const askSchema = z.object({ question: z.string().min(1).max(1000) });

/**
 * POST /api/ai/ask - ask the ops assistant a question about the fleet.
 *
 * Returns the answer plus the full tool trace, so an operator can see which
 * queries produced it rather than taking the answer on faith.
 */
aiRouter.post('/ask', askLimit, async (req, res, next) => {
  try {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A question is required' });

    const result = await askAssistant(parsed.data.question);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/ai/provider - which backend is live, for the UI badge. */
aiRouter.get('/provider', (_req, res) => res.json(providerInfo()));
