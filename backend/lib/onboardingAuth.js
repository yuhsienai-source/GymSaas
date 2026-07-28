// lib/onboardingAuth.js — 會員自助註冊／登入暫用 JWT
import jwt from 'jsonwebtoken';

const JWT_SECRET = () => {
  const s = process.env.JWT_SECRET;
  if (!s) {
    const err = new Error('JWT_SECRET 未設定');
    err.statusCode = 500;
    throw err;
  }
  return s;
};

/** @returns {string} */
export function issueOnboardingToken({ phone, memberId, purpose }) {
  return jwt.sign(
    {
      type: 'onboarding',
      phone,
      memberId: memberId ?? null,
      purpose: purpose === 'LOGIN' ? 'LOGIN' : 'REGISTER',
    },
    JWT_SECRET(),
    { expiresIn: '30m' },
  );
}

export function verifyOnboardingToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET());
    if (decoded.type !== 'onboarding' || !decoded.phone) {
      const err = new Error('無效的註冊／登入憑證');
      err.statusCode = 403;
      throw err;
    }
    return decoded;
  } catch (error) {
    if (error.statusCode) throw error;
    const err = new Error('註冊／登入憑證已過期，請重新驗證手機');
    err.statusCode = 403;
    throw err;
  }
}

export function issueMemberToken(memberId, { deviceId, deviceAuthVersion } = {}) {
  const payload = { memberId, role: 'MEMBER', type: 'member' };
  const did = deviceId != null ? String(deviceId).trim() : '';
  if (did.length >= 8) payload.deviceId = did;
  const ver = Number(deviceAuthVersion);
  if (Number.isFinite(ver) && ver >= 0) payload.dav = ver;
  return jwt.sign(payload, JWT_SECRET(), { expiresIn: '7d' });
}

/** LINE 綁定用 state（放在 OAuth state） */
export function issueLineBindState({ memberId, phone }) {
  return jwt.sign(
    { type: 'line_bind', memberId, phone },
    JWT_SECRET(),
    { expiresIn: '15m' },
  );
}

export function verifyLineBindState(state) {
  try {
    const decoded = jwt.verify(String(state || ''), JWT_SECRET());
    if (decoded.type !== 'line_bind' || !decoded.memberId) return null;
    return decoded;
  } catch {
    return null;
  }
}
