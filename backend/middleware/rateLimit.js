// middleware/rateLimit.js — 簡易記憶體限流（單機）
const buckets = new Map();

function nowMs() {
  return Date.now();
}

function sweepExpired(ts) {
  const cutoff = nowMs() - ts.windowMs;
  while (ts.hits.length && ts.hits[0] <= cutoff) ts.hits.shift();
}

/**
 * @param {{
 *  keyPrefix: string,
 *  windowMs: number,
 *  max: number,
 *  keyFn?: (req:any)=>string,
 *  message?: string
 * }} opts
 */
export function createRateLimiter(opts) {
  const keyPrefix = String(opts?.keyPrefix || 'rl');
  const windowMs = Number(opts?.windowMs) || 60_000;
  const max = Number(opts?.max) || 30;
  const message = opts?.message || '請稍後再試';
  const keyFn =
    opts?.keyFn ||
    ((req) => req.ip || req.headers['x-forwarded-for'] || 'unknown');

  return function rateLimit(req, res, next) {
    const key = `${keyPrefix}:${String(keyFn(req) || 'unknown')}`;
    const cur = buckets.get(key) || { hits: [] };
    sweepExpired({ hits: cur.hits, windowMs });
    cur.hits.push(nowMs());
    buckets.set(key, cur);

    if (cur.hits.length > max) {
      const retryAfterSec = Math.max(1, Math.ceil(windowMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        status: 'error',
        message,
      });
    }
    return next();
  };
}
