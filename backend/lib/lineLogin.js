// lib/lineLogin.js — LINE Login（OAuth 2.0 Authorization Code）共用：會員登入與員工推播綁定
/**
 * 會員與員工共用同一 LINE Login Channel（LINE_CHANNEL_ID／SECRET），以不同 redirect_uri 區分；
 * Messaging API 推播之 userId 以 Provider 為範圍，故 Login 與 Messaging Channel 必須在同一 Provider。
 */

export const LINE_AUTH_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

function channelId() {
  return String(process.env.LINE_CHANNEL_ID || '').trim();
}

function channelSecret() {
  return String(process.env.LINE_CHANNEL_SECRET || '').trim();
}

function httpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

export function lineLoginConfigured() {
  return Boolean(channelId() && channelSecret());
}

export function assertLineLoginConfig(redirectUri) {
  if (!lineLoginConfigured() || !redirectUri) {
    throw httpError(
      'LINE OAuth 環境變數未設定（LINE_CHANNEL_ID / SECRET / CALLBACK_URL）',
      500,
      'LINE_NOT_CONFIGURED',
    );
  }
}

/** @param {{ redirectUri: string, state: string, scope?: string }} opts */
export function buildLineAuthorizeUrl({ redirectUri, state, scope = 'profile openid' }) {
  assertLineLoginConfig(redirectUri);
  return (
    `${LINE_AUTH_URL}?response_type=code` +
    `&client_id=${encodeURIComponent(channelId())}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scope)}`
  );
}

/** redirect_uri 必須與產生授權網址時完全一致 */
export async function exchangeLineCode(code, redirectUri) {
  assertLineLoginConfig(redirectUri);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: channelId(),
    client_secret: channelSecret(),
  });

  const tokenResponse = await fetch(LINE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.id_token) {
    throw httpError(
      tokenData.error_description || tokenData.error || '無法以 code 換取 LINE ID Token',
      401,
    );
  }
  return tokenData;
}

export async function verifyLineIdToken(idToken) {
  const verifyRes = await fetch(LINE_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId() }),
  });
  const claims = await verifyRes.json();

  if (!verifyRes.ok || !claims.sub) {
    throw httpError(claims.error_description || claims.error || 'LINE ID Token 驗證失敗', 401);
  }
  if (claims.aud !== channelId()) throw httpError('ID Token aud 與 CHANNEL_ID 不符', 401);
  if (claims.iss !== 'https://access.line.me') throw httpError('ID Token iss 無效', 401);
  if (claims.exp * 1000 < Date.now()) throw httpError('ID Token 已過期', 401);

  return {
    sub: claims.sub,
    name: claims.name || claims.displayName || null,
    picture: claims.picture || null,
  };
}

/** code → 已驗證之 LINE profile */
export async function lineProfileFromCode(code, redirectUri) {
  const tokenData = await exchangeLineCode(code, redirectUri);
  return verifyLineIdToken(tokenData.id_token);
}
