/**
 * Query-building helpers for user- and model-supplied input.
 */

/**
 * Escape every regex metacharacter so a search string is matched literally.
 *
 * Without this, `?site=` goes straight into a MongoDB `$regex` and the caller
 * controls the pattern. That is a denial-of-service primitive: a pattern like
 * `(a+)+$` backtracks catastrophically and pins a CPU core for as long as the
 * engine keeps trying. It also lets a caller probe with patterns the API never
 * meant to expose.
 *
 * This matters twice over here, because one caller of the search path is the AI
 * assistant passing model-generated input.
 */
export function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a safe case-insensitive "contains" filter.
 * Length-capped as well: an escaped pattern cannot backtrack, but an enormous
 * one still costs the matcher work on every document.
 */
export function containsFilter(input, maxLength = 80) {
  return { $regex: escapeRegex(String(input).slice(0, maxLength)), $options: 'i' };
}

/**
 * Parse limit/offset from a query string with hard ceilings.
 *
 * Unbounded list endpoints are fine at 16 machines and a problem at 10,000 -
 * the response balloons, the client stalls parsing it, and the server holds the
 * whole result set in memory.
 */
export function parsePaging(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(maxLimit, Math.max(1, Math.trunc(rawLimit))) : defaultLimit,
    offset: Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0,
  };
}
