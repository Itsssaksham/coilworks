/**
 * Fixed-window rate limiter, in-process.
 *
 * Telemetry ingest is the one endpoint the whole fleet hits continuously, so it
 * gets a per-machine budget: a controller stuck in a reboot loop degrades only
 * its own bucket instead of the ingest path for every other machine.
 *
 * In-process state is the right scope for a single-node deployment. Behind more
 * than one instance this would need to move to Redis - noted rather than
 * pretended otherwise.
 */
const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 120, keyFn } = {}) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    next();
  };
}

/** Drop expired buckets so the map does not grow without bound. */
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key);
}, 60_000);
sweep.unref();
