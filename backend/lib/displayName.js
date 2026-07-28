// lib/displayName.js — 員工／教練對外顯示名稱（預設匿名）
export const DEFAULT_DISPLAY_NAME = '匿名';

/**
 * @param {{ displayName?: string|null, name?: string|null }|null|undefined} person
 * @returns {string}
 */
export function resolveDisplayName(person) {
  const dn = String(person?.displayName ?? '').trim();
  if (dn) return dn;
  return DEFAULT_DISPLAY_NAME;
}

/**
 * 正規化寫入用顯示名稱；空字串→預設匿名
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeDisplayName(raw) {
  const s = String(raw ?? '').trim();
  return s || DEFAULT_DISPLAY_NAME;
}
