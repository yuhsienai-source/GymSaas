// lib/frontendUrl.js — 獨立前端網域回流（本專案不託管任何 UI）
const DEFAULT_AUTH_PATH = '/auth/callback';
const DEFAULT_PAY_RETURN_PATH = '/pay/return';

export function getFrontendBaseUrl() {
  const base = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
  if (!base) {
    const err = new Error('FRONTEND_URL 未設定：無法將瀏覽器導向獨立前端');
    err.statusCode = 500;
    throw err;
  }
  return base;
}

/**
 * 組出獨立前端完整 URL（path 可用 env 覆寫，禁止寫死本機 .html）
 */
export function buildFrontendRedirect(path, query = {}) {
  const base = getFrontendBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(normalizedPath, `${base}/`);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

export function memberAuthRedirect({ authCode, token, loginError, needDevice } = {}) {
  const path = (process.env.FRONTEND_AUTH_CALLBACK_PATH || DEFAULT_AUTH_PATH).trim() || DEFAULT_AUTH_PATH;
  if (loginError) {
    return buildFrontendRedirect(path, { login_error: loginError });
  }
  return buildFrontendRedirect(path, {
    auth_code: authCode,
    // backward compatible（逐步淘汰）
    token,
    ...(needDevice ? { needDevice: '1' } : {}),
  });
}

export function payReturnRedirect(extraQuery = {}) {
  const path =
    (process.env.FRONTEND_PAY_RETURN_PATH || DEFAULT_PAY_RETURN_PATH).trim() ||
    DEFAULT_PAY_RETURN_PATH;
  return buildFrontendRedirect(path, { pay: 'done', ...extraQuery });
}

/** 櫃檯 POS 刷卡回流（可帶 saleId） */
export function posPayReturnRedirect({ saleId } = {}) {
  const path = (process.env.FRONTEND_POS_RETURN_PATH || '/staff/ops').trim() || '/staff/ops';
  return buildFrontendRedirect(path, {
    pay: 'done',
    ...(saleId ? { saleId } : {}),
  });
}

/** 櫃檯購案／儲值刷卡回流（可帶 orderId） */
export function topupPayReturnRedirect({ orderId } = {}) {
  const path = (process.env.FRONTEND_POS_RETURN_PATH || '/staff/ops').trim() || '/staff/ops';
  return buildFrontendRedirect(path, {
    pay: 'done',
    ...(orderId ? { orderId } : {}),
  });
}

/** 臨櫃合併結帳刷卡回流（可帶 checkoutId） */
export function checkoutPayReturnRedirect({ checkoutId } = {}) {
  const path = (process.env.FRONTEND_POS_RETURN_PATH || '/staff/ops').trim() || '/staff/ops';
  return buildFrontendRedirect(path, {
    pay: 'done',
    ...(checkoutId ? { checkoutId } : {}),
  });
}
