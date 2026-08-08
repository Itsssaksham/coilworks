import 'dotenv/config';

const bool = (v, fallback) => (v == null ? fallback : /^(1|true|yes|on)$/i.test(v));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

const DEFAULT_JWT_SECRET = 'coilworks-dev-secret-change-me';

export const config = {
  env: process.env.NODE_ENV || 'development',

  // Port resolution, in order: API_PORT, then PORT but only in production,
  // then 4000.
  //
  // PORT is deliberately ignored in development: the Vite dev server and the
  // harnesses that launch it also read it, and an inherited value silently
  // binds the API on top of the web server, leaving the proxy nothing to
  // forward to.
  //
  // In production that reasoning does not hold and the opposite is true - every
  // container platform (Render, Fly, Cloud Run, Heroku) assigns a port via PORT
  // and health-checks it. Ignoring it there means the platform probes a port
  // nothing is listening on and marks the deploy failed.
  port: Number(
    process.env.API_PORT ||
      (process.env.NODE_ENV === 'production' ? process.env.PORT : '') ||
      4000,
  ),

  // directConnection keeps the driver talking to this one node instead of trying
  // to discover replica set members by their advertised hostnames.
  mongoUri:
    process.env.MONGO_URI ||
    'mongodb://127.0.0.1:27018/coilworks?replicaSet=rs0&directConnection=true',

  jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS || 60 * 60 * 12),

  // Origins allowed to call the API. Empty in development means "reflect the
  // request origin"; in production an empty list is a boot failure (see below).
  corsOrigins: list(process.env.CORS_ORIGINS),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  },

  // How long raw telemetry is retained before MongoDB expires it automatically.
  // Only applied when the collection is first created - see db.js.
  telemetryRetentionSeconds: Number(process.env.TELEMETRY_RETENTION_SECONDS || 60 * 60 * 24 * 30),

  // Index builds block startup and can take minutes on a large collection, so
  // production syncs them deliberately (`npm run sync-indexes`) rather than on
  // every boot.
  autoIndex: bool(process.env.MONGO_AUTO_INDEX, process.env.NODE_ENV !== 'production'),

  // Directory holding the built client. When present, Express serves the SPA
  // and the whole app runs as one process.
  clientDist: process.env.CLIENT_DIST || '',

  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
};

export const isProduction = () => config.env === 'production';

/** True when a real Claude key is configured; false means the offline analyzer runs. */
export const hasClaudeKey = () => Boolean(config.anthropic.apiKey);

/**
 * Fail fast on configuration that is safe in development and dangerous in
 * production.
 *
 * The motivating case: JWT_SECRET falls back to a constant that is committed to
 * this repository. Deployed without the env var set, the app would happily sign
 * and accept tokens anyone could forge. Silently defaulting is the wrong
 * behaviour for a secret - refusing to boot is the right one.
 *
 * @throws {Error} listing every problem at once, so a deploy is fixed in one pass
 */
export function validateConfig() {
  if (!isProduction()) {
    // Development: warn but never block.
    return { ok: true, warnings: developmentWarnings() };
  }

  // Errors are things that are unsafe or certainly broken. Warnings are things
  // that are usually wrong but have legitimate cases - blocking a valid deploy
  // is its own kind of failure, so those only get flagged.
  const problems = [];
  const warnings = [];

  if (config.jwtSecret === DEFAULT_JWT_SECRET) {
    problems.push('JWT_SECRET is the built-in development default, which is public in this repository.');
  } else if (config.jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters.');
  }

  if (config.corsOrigins.length === 0) {
    problems.push('CORS_ORIGINS must list the allowed origins explicitly (comma-separated).');
  }
  if (config.corsOrigins.includes('*')) {
    problems.push('CORS_ORIGINS may not be "*" - credentials are sent with API requests.');
  }

  if (!process.env.MONGO_URI) {
    warnings.push(
      'MONGO_URI is unset, falling back to the local development default. ' +
        'That will not resolve from inside a container.',
    );
  } else if (/127\.0\.0\.1|localhost/.test(config.mongoUri)) {
    // Legitimate on a single host running MongoDB alongside the app; wrong in
    // a container that expects a service name. Warn, do not block.
    warnings.push('MONGO_URI points at localhost - correct only if MongoDB runs on this same host.');
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with unsafe configuration:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  return { ok: true, warnings };
}

function developmentWarnings() {
  const warnings = [];
  if (config.jwtSecret === DEFAULT_JWT_SECRET) {
    warnings.push('Using the default JWT secret. Fine locally; the app will refuse to boot with it in production.');
  }
  if (!hasClaudeKey()) {
    warnings.push('No ANTHROPIC_API_KEY - AI features run on the offline rule-based analyzer.');
  }
  return warnings;
}
