// lib/memberIdentityQr.js — 臨櫃查詢用靜態會員碼（非門禁動態 QR）
import { isValidMemberNo } from './memberNo.js';

export const MEMBER_ID_QR_PREFIX = 'GYMSAAS:MEMBER:';

/** 產生查詢用 QR 內容（固定；含會員編號） */
export function buildMemberIdentityQrPayload(memberNo) {
  const no = String(memberNo || '').trim().toUpperCase();
  if (!isValidMemberNo(no)) {
    const err = new Error('會員編號尚未就緒，無法產生查詢碼');
    err.statusCode = 400;
    throw err;
  }
  return `${MEMBER_ID_QR_PREFIX}${no}`;
}

/**
 * 從掃描字串解析會員編號
 * 支援：GYMSAAS:MEMBER:XXXXXX、純 6 碼、大小寫
 * @returns {string|null}
 */
export function parseMemberIdentityQrPayload(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  const upper = s.toUpperCase();
  if (upper.startsWith(MEMBER_ID_QR_PREFIX)) {
    const no = upper.slice(MEMBER_ID_QR_PREFIX.length).trim();
    return isValidMemberNo(no) ? no : null;
  }

  // 純會員編號（6 碼）
  if (isValidMemberNo(upper)) return upper;

  return null;
}
