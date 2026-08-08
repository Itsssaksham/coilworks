import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import { config, isProduction, normalizeOrigin, validateConfig } from './config.js';
import { log } from './logger.js';
import { connect } from './db.js';
import { hub } from './realtime/hub.js';
import { Machine } from './models/Machine.js';
import { sweepOfflineMachines } from './services/alerts.js';
import { providerInfo } from './services/llm/client.js';

import { authRouter } from './routes/auth.js';
import { machinesRouter } from './routes/machines.js';
import { ingestRouter } from './routes/ingest.js';
import { alertsRouter } from './routes/alerts.js';
import { analyticsRouter } from './routes/analytics.js';
import { runsRouter } from './routes/runs.js';
import { aiRouter } from './routes/ai.js';

/**
 * Security headers, set by hand.
 *
 * helmet would be the usual choice; this is the subset that actually applies to
 * a JSON API plus a self-hosted SPA, and it avoids a dependency for ~10 lines.
 * The CSP is deliberately strict: the client bundles everything, so nothing
 * needs to load from a third-party origin.
 */
function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-DNS-Prefetch-Control', 'off');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // Vite injects a style tag for the bundled CSS.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  if (isProduction()) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * CORS policy.
 *
 * In production the allowlist is required and enforced (validateConfig refuses
 * to boot without it). In development an empty list reflects the request
 * origin, which is what makes the Vite proxy and a bare curl both work.
 *
 * Same-origin requests are always allowed, whatever the allowlist says. A
 * browser does not normally send Origin on a same-origin GET, but it does on
 * some requests and some intermediaries add one - and refusing those would take
 * the served SPA down over a misconfigured env var, which is exactly the
 * failure this served: an allowlist that did not name this host returned 403
 * for the app's own JavaScript and left visitors a blank page.
 */
function corsMiddleware() {
  const allow = { origin: true, credentials: true };

  return cors((req, callback) => {
    const origin = req.headers.origin;

    // No Origin header at all: server-to-server calls, curl, health probes.
    if (!origin) return callback(null, allow);

    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      // A malformed Origin is not something to reflect back.
    }
    if (host && host === req.headers.host) return callback(null, allow);

    if (config.corsOrigins.length === 0) return callback(null, allow);
    if (config.corsOrigins.includes(normalizeOrigin(origin))) return callback(null, allow);

    callback(new Error(`Origin not allowed: ${origin}`));
  });
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(securityHeaders);
  // Scoped to the API deliberately. The SPA's own assets are served from this
  // same origin and need no CORS decision at all; gating them meant a rejected
  // origin took out the whole page rather than one cross-origin API call.
  app.use('/api', corsMiddleware());
  app.use(express.json({ limit: '256kb' }));

  // Liveness: is the process up at all.
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      env: config.env,
      ai: providerInfo(),
      realtimeClients: hub.clientCount,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );

  // Readiness: is it actually able to serve. A degraded change stream means the
  // dashboard would show stale data, so it is reported rather than hidden - an
  // orchestrator can pull this instance out of rotation.
  app.get('/api/ready', (_req, res) => {
    const degraded = hub.degradedTopics();
    res.status(degraded.length === 0 ? 200 : 503).json({
      ready: degraded.length === 0,
      degradedTopics: degraded,
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/machines', machinesRouter);
  app.use('/api/ingest', ingestRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/runs', runsRouter);
  app.use('/api/ai', aiRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  mountClient(app);

  // Central error handler. Logs server-side, returns a message the client can
  // act on without leaking internals.
  app.use((err, req, res, _next) => {
    const status = err.status || (err.message?.startsWith('Origin not allowed') ? 403 : 500);
    log.error('request failed', {
      method: req.method,
      path: req.path,
      status,
      error: err.message,
      stack: isProduction() ? undefined : err.stack,
    });
    res.status(status).json({
      error: status === 500 ? 'Internal server error' : err.message,
    });
  });

  return app;
}

/**
 * Serve the built SPA, when there is one.
 *
 * This is what lets the whole app run as a single process and a single
 * container. Without it there is no deployment story at all - only two dev
 * servers side by side.
 */
function mountClient(app) {
  const dist =
    config.clientDist ||
    path.resolve(process.cwd(), '../client/dist');

  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    log.debug('no built client found, API only', { lookedIn: dist });
    return;
  }

  // Hashed asset filenames are immutable, so they can be cached hard. index.html
  // must not be, or a deploy never reaches a returning visitor.
  app.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.set('Cache-Control', 'no-cache');
        else res.set('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );

  // SPA fallback: any non-API route serves index.html so client-side routing
  // survives a hard refresh.
  app.get(/.*/, (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(dist, 'index.html'));
  });

  log.info('serving built client', { dist });
}

async function main() {
  const { warnings } = validateConfig();
  for (const warning of warnings) log.warn(warning);

  await connect();
  log.info('MongoDB connected', { replicaSet: true, autoIndex: config.autoIndex });

  const app = createApp();
  const server = http.createServer(app);
  hub.attach(server);

  // Offline detection is the absence of telemetry, so it cannot be driven by an
  // incoming request - it runs on a timer.
  const sweep = setInterval(async () => {
    try {
      const raised = await sweepOfflineMachines(Machine);
      if (raised.length > 0) log.info('machines went offline', { count: raised.length });
    } catch (err) {
      log.error('offline sweep failed', { error: err.message });
    }
  }, 30_000);
  sweep.unref();

  server.listen(config.port, () => {
    log.info('Coilworks API listening', {
      port: config.port,
      env: config.env,
      ai: providerInfo().provider,
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    clearInterval(sweep);
    await hub.close();
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // An unhandled rejection has already corrupted whatever it was doing; log it
  // loudly rather than letting Node's default terminate silently in a container.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { error: reason?.message ?? String(reason) });
  });
}

// Only boot when run directly, so tests and the smoke script can import createApp.
// pathToFileURL normalises the Windows path separators and drive letter that a
// naive string compare against import.meta.url would get wrong.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error('boot failed', { error: err.message });
    process.exit(1);
  });
}
