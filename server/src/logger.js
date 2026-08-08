import { config, isProduction } from './config.js';

/**
 * Minimal structured logger.
 *
 * Production emits one JSON object per line, which is what every log aggregator
 * expects and what makes a field greppable instead of regex-parsed out of prose.
 * Development stays human-readable, because JSON in a terminal is miserable.
 *
 * No dependency: pino or winston would be the right call in a larger service,
 * but this is ~40 lines and the app has no other logging requirements.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return;

  if (isProduction()) {
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...fields }) + '\n',
    );
    return;
  }

  const extra = Object.keys(fields).length
    ? ' ' + Object.entries(fields).map(([k, v]) => `${k}=${format(v)}`).join(' ')
    : '';
  const tag = { debug: '[debug]', info: '[info] ', warn: '[warn] ', error: '[error]' }[level];
  process.stdout.write(`${tag} ${message}${extra}\n`);
}

function format(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
