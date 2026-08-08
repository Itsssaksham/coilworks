import express from 'express';
import { requireOperator } from '../middleware/auth.js';
import { fleetSummary, salesByHour, topProducts, forecastStockouts } from '../services/forecast.js';

export const analyticsRouter = express.Router();

analyticsRouter.use(requireOperator);

/** GET /api/analytics/summary - the dashboard KPI row. */
analyticsRouter.get('/summary', async (_req, res, next) => {
  try {
    res.json(await fleetSummary());
  } catch (err) {
    next(err);
  }
});

/** GET /api/analytics/sales-by-hour?hours=24 - trend chart series. */
analyticsRouter.get('/sales-by-hour', async (req, res, next) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 14);
    res.json(await salesByHour({ hours, machineId: req.query.machineId }));
  } catch (err) {
    next(err);
  }
});

/** GET /api/analytics/top-products?days=7 */
analyticsRouter.get('/top-products', async (req, res, next) => {
  try {
    res.json(
      await topProducts({
        days: Math.min(Math.max(Number(req.query.days) || 7, 1), 90),
        limit: Math.min(Math.max(Number(req.query.limit) || 10, 1), 25),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** GET /api/analytics/forecast?horizonDays=7 - projected stockouts. */
analyticsRouter.get('/forecast', async (req, res, next) => {
  try {
    res.json(
      await forecastStockouts({
        windowDays: Math.min(Math.max(Number(req.query.windowDays) || 14, 1), 90),
        horizonDays: Math.min(Math.max(Number(req.query.horizonDays) || 7, 0.5), 60),
        machineId: req.query.machineId,
      }),
    );
  } catch (err) {
    next(err);
  }
});
