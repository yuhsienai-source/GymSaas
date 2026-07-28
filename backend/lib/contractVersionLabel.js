/** 合約版本標籤：初版為 versionBase（預設 V1），其後為 V1.1、V1.2… */

export const DEFAULT_VERSION_BASE = 'V1';

export function normalizeVersionBase(raw) {
  const s = String(raw ?? '').trim();
  return s || DEFAULT_VERSION_BASE;
}

/**
 * @param {string} versionBase
 * @param {number} versionInt 內部序號（1=初版，2=第一次修訂…）
 */
export function buildVersionLabel(versionBase, versionInt) {
  const base = normalizeVersionBase(versionBase);
  const n = Number(versionInt);
  if (!Number.isInteger(n) || n <= 1) return base;
  return `${base}.${n - 1}`;
}
