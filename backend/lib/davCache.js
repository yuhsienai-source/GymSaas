// lib/davCache.js — memberId → { deviceId, deviceAuthVersion } 短 TTL 快取（降 Neon 連線壓）
const DEFAULT_TTL_MS = Number(process.env.DAV_CACHE_TTL_MS) || 4 * 60 * 1000;
const MAX_ENTRIES = Number(process.env.DAV_CACHE_MAX) || 5_000;

/** @type {Map<number, { deviceId: string|null, deviceAuthVersion: number, expiresAt: number }>} */
const cache = new Map();

function touch(memberId, entry) {
  cache.delete(memberId);
  cache.set(memberId, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

export function getCachedMemberDav(memberId) {
  const id = Number(memberId);
  const hit = cache.get(id);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(id);
    return null;
  }
  // LRU：再讀一次放到尾端
  touch(id, hit);
  return {
    deviceId: hit.deviceId,
    deviceAuthVersion: hit.deviceAuthVersion,
  };
}

export function setCachedMemberDav(memberId, { deviceId, deviceAuthVersion }, ttlMs = DEFAULT_TTL_MS) {
  const id = Number(memberId);
  touch(id, {
    deviceId: deviceId == null ? null : String(deviceId),
    deviceAuthVersion: Number(deviceAuthVersion) || 0,
    expiresAt: Date.now() + Math.max(30_000, ttlMs),
  });
}

/** 換機／臨櫃重置／改綁後必須驅逐 */
export function invalidateMemberDav(memberId) {
  if (memberId == null) return;
  cache.delete(Number(memberId));
}

export function davCacheStats() {
  return { size: cache.size, max: MAX_ENTRIES, ttlMs: DEFAULT_TTL_MS };
}
