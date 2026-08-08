import express from 'express';
import { Alert } from '../models/Alert.js';
import { Machine } from '../models/Machine.js';
import { requireOperator } from '../middleware/auth.js';
import { triageAlert } from '../services/llm/triage.js';
import { providerInfo } from '../services/llm/client.js';

export const alertsRouter = express.Router();

alertsRouter.use(requireOperator);

/** GET /api/alerts - the queue, newest first, critical-first within status. */
alertsRouter.get('/', async (req, res, next) => {
  try {
    const { status = 'open', severity, type, limit = 100 } = req.query;
    const query = {};
    if (status !== 'all') query.status = status;
    if (severity) query.severity = severity;
    if (type) query.type = type;

    const severityRank = { critical: 0, warning: 1, info: 2 };
    const alerts = await Alert.find(query)
      .sort({ openedAt: -1 })
      .limit(Math.min(Number(limit) || 100, 500))
      .lean();

    alerts.sort(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] ||
        new Date(b.openedAt) - new Date(a.openedAt),
    );

    res.json(alerts);
  } catch (err) {
    next(err);
  }
});

/** POST /api/alerts/:id/acknowledge - operator has seen it and owns it. */
alertsRouter.post('/:id/acknowledge', async (req, res, next) => {
  try {
    const alert = await Alert.findByIdAndUpdate(
      req.params.id,
      { status: 'acknowledged', acknowledgedAt: new Date() },
      { new: true },
    );
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json(alert);
  } catch (err) {
    next(err);
  }
});

/** POST /api/alerts/:id/resolve - the condition is dealt with. */
alertsRouter.post('/:id/resolve', async (req, res, next) => {
  try {
    const alert = await Alert.findByIdAndUpdate(
      req.params.id,
      { status: 'resolved', resolvedAt: new Date() },
      { new: true },
    );
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json(alert);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/alerts/:id/triage - diagnose the fault.
 *
 * Cached on the alert after the first call. `?force=1` recomputes, which is what
 * you want after new telemetry has arrived.
 */
alertsRouter.post('/:id/triage', async (req, res, next) => {
  try {
    const alert = await Alert.findById(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    const machine = await Machine.findById(alert.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine no longer exists' });

    const triage = await triageAlert({
      alert,
      machine,
      force: req.query.force === '1',
    });

    res.json({ triage, ...providerInfo() });
  } catch (err) {
    next(err);
  }
});
