// routes/auth.js — LINE OAuth 2.0 Authorization Code Flow
import express from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { memberAuthRedirect } from '../lib/frontendUrl.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import {
  issueMemberToken,
  verifyLineBindState,
} from '../lib/onboardingAuth.js';
import {
  assertMemberReadyForLineLogin,
  assertMemberReadyToBind,
} from '../lib/memberOnboardingGate.js';
import {
  deviceBindUpdateData,
  memberTokenDeviceOpts,
} from '../lib/memberDevice.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CALLBACK_URL = process.env.LINE_CALLBACK_URL;

const LINE_AUTH_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 90 * 1000;
const loginStateStore = new Map();
const authCodeStore = new Map();
/** 已兌換 auth_code 短時重放（防前端 Strict Mode 雙次換票） */
const authCodeReplayStore = new Map();

const lineExchangeLimiter = createRateLimiter({
  keyPrefix: 'line-exchange',
  windowMs: 60 * 1000,
  max: 20,
  keyFn: (req) => req.ip || 'unknown',
  message: 'LINE 驗證過於頻繁，請稍後再試',
});
const lineLoginUrlLimiter = createRateLimiter({
  keyPrefix: 'line-login-url',
  windowMs: 60 * 1000,
  max: 40,
  keyFn: (req) => req.ip || 'unknown',
  message: '請求過於頻繁，請稍後再試',
});

function sweepStore(store) {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (!v?.expiresAt || v.expiresAt <= now) store.delete(k);
  }
}

function issueLoginState() {
  sweepStore(loginStateStore);
  const state = crypto.randomBytes(24).toString('hex');
  loginStateStore.set(state, { expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
  return state;
}

function consumeLoginState(state) {
  if (!state || typeof state !== 'string') {
    const err = new Error('OAuth state 缺失');
    err.statusCode = 400;
    throw err;
  }
  sweepStore(loginStateStore);
  const row = loginStateStore.get(state);
  if (!row || row.expiresAt <= Date.now()) {
    loginStateStore.delete(state);
    const err = new Error('OAuth state 無效或已過期');
    err.statusCode = 401;
    throw err;
  }
  loginStateStore.delete(state);
  return true;
}

function issueAuthCode(payload) {
  sweepStore(authCodeStore);
  sweepStore(authCodeReplayStore);
  const authCode = crypto.randomBytes(24).toString('hex');
  authCodeStore.set(authCode, {
    ...payload,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  return authCode;
}

function consumeAuthCode(authCode) {
  if (!authCode || typeof authCode !== 'string') {
    const err = new Error('缺少 authCode');
    err.statusCode = 400;
    throw err;
  }
  sweepStore(authCodeStore);
  sweepStore(authCodeReplayStore);

  const fresh = authCodeStore.get(authCode);
  if (fresh && fresh.expiresAt > Date.now()) {
    authCodeStore.delete(authCode);
    authCodeReplayStore.set(authCode, {
      ...fresh,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return fresh;
  }

  const replay = authCodeReplayStore.get(authCode);
  if (replay && replay.expiresAt > Date.now()) {
    return replay;
  }

  authCodeStore.delete(authCode);
  authCodeReplayStore.delete(authCode);
  const err = new Error('authCode 無效或已過期');
  err.statusCode = 401;
  throw err;
}

function assertLineConfig() {
  if (!LINE_CHANNEL_ID || !LINE_CHANNEL_SECRET || !LINE_CALLBACK_URL) {
    const err = new Error('LINE OAuth 環境變數未設定（LINE_CHANNEL_ID / SECRET / CALLBACK_URL）');
    err.statusCode = 500;
    throw err;
  }
  if (!JWT_SECRET) {
    const err = new Error('JWT_SECRET 未設定');
    err.statusCode = 500;
    throw err;
  }
}

async function exchangeCodeForTokens(code) {
  assertLineConfig();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: LINE_CALLBACK_URL,
    client_id: LINE_CHANNEL_ID,
    client_secret: LINE_CHANNEL_SECRET,
  });

  const tokenResponse = await fetch(LINE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.id_token) {
    const err = new Error(
      tokenData.error_description || tokenData.error || '無法以 code 換取 LINE ID Token',
    );
    err.statusCode = 401;
    throw err;
  }

  return tokenData;
}

async function verifyLineIdToken(idToken) {
  const verifyBody = new URLSearchParams({
    id_token: idToken,
    client_id: LINE_CHANNEL_ID,
  });

  const verifyRes = await fetch(LINE_VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: verifyBody,
  });

  const claims = await verifyRes.json();

  if (!verifyRes.ok || !claims.sub) {
    const err = new Error(claims.error_description || claims.error || 'LINE ID Token 驗證失敗');
    err.statusCode = 401;
    throw err;
  }

  if (claims.aud !== LINE_CHANNEL_ID) {
    const err = new Error('ID Token aud 與 CHANNEL_ID 不符');
    err.statusCode = 401;
    throw err;
  }

  if (claims.iss !== 'https://access.line.me') {
    const err = new Error('ID Token iss 無效');
    err.statusCode = 401;
    throw err;
  }

  if (claims.exp * 1000 < Date.now()) {
    const err = new Error('ID Token 已過期');
    err.statusCode = 401;
    throw err;
  }

  return {
    sub: claims.sub,
    name: claims.name || claims.displayName || null,
    picture: claims.picture || null,
  };
}

/**
 * 將 LINE 綁到既有會員（自助註冊／登入流程）；可同時寫入本機 deviceId
 */
async function bindLineToMemberAndIssueJwt(lineProfile, bind, deviceId = null) {
  const lineId = lineProfile.sub;
  const memberId = bind.memberId;

  const taken = await prisma.member.findUnique({ where: { lineId } });
  if (taken && taken.id !== memberId) {
    const err = new Error('此 LINE 帳號已綁定其他會員，請洽櫃檯');
    err.statusCode = 409;
    throw err;
  }

  let member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) {
    const err = new Error('找不到待綁定的會員');
    err.statusCode = 404;
    throw err;
  }
  if (bind.phone && member.phone !== bind.phone) {
    const err = new Error('手機與會員資料不符，請重新驗證');
    err.statusCode = 403;
    throw err;
  }
  if (member.lineId && member.lineId !== lineId) {
    const err = new Error('此會員已綁定其他 LINE，請洽櫃檯');
    err.statusCode = 409;
    throw err;
  }

  // 自助綁定 LINE：必須已完成人臉偏好＋必簽契約
  await assertMemberReadyToBind(member);

  const patch = {};
  if (!member.lineId) patch.lineId = lineId;
  const did = deviceId ? String(deviceId).trim() : '';
  if (did.length >= 8) {
    if (!member.deviceId) {
      Object.assign(patch, deviceBindUpdateData({ deviceId: did }));
    } else if (member.deviceId !== did) {
      const err = new Error('此帳號已綁定其他裝置，請洽櫃檯解除後再綁定');
      err.statusCode = 403;
      throw err;
    }
  }

  if (Object.keys(patch).length) {
    member = await prisma.member.update({
      where: { id: memberId },
      data: patch,
    });
  }

  const accessToken = issueMemberToken(member.id, memberTokenDeviceOpts(member));
  return { member, accessToken, bound: true };
}

/**
 * 既有 LINE 會員登入（不再自動開新帳；新客請走手機註冊）
 * 若本機尚未綁裝置且帶 deviceId，一併寫入（LINE 登入＝完成裝置綁定）
 */
async function loginExistingLineMember(lineProfile, deviceId = null) {
  const lineId = lineProfile.sub;
  let member = await prisma.member.findUnique({ where: { lineId } });
  if (!member) {
    const err = new Error('尚未註冊：請先以手機號碼完成會員註冊與驗證後再綁定 LINE');
    err.statusCode = 404;
    throw err;
  }
  // LINE 快速登入：契約未簽完不得發 JWT（須改走手機驗證完成簽署）
  await assertMemberReadyForLineLogin(member);
  const did = deviceId ? String(deviceId).trim() : '';
  if (did.length >= 8) {
    if (!member.deviceId) {
      member = await prisma.member.update({
        where: { id: member.id },
        data: deviceBindUpdateData({ deviceId: did }),
      });
    } else if (member.deviceId !== did) {
      const err = new Error('此帳號已綁定其他裝置，請洽櫃檯解除後再以此裝置登入');
      err.statusCode = 403;
      throw err;
    }
  }
  const accessToken = issueMemberToken(member.id, memberTokenDeviceOpts(member));
  return { member, accessToken, bound: false };
}

async function completeLineLoginWithCode(code, state, deviceId = null) {
  const tokenData = await exchangeCodeForTokens(code);
  const profile = await verifyLineIdToken(tokenData.id_token);
  const bind = verifyLineBindState(state);
  if (bind) {
    return bindLineToMemberAndIssueJwt(profile, bind, deviceId);
  }
  consumeLoginState(state);
  return loginExistingLineMember(profile, deviceId);
}

// GET /api/auth/line/login-url
// 可選 query.onboardingState：已由 /api/onboarding/line-login-url 產生的 state
router.get('/line/login-url', lineLoginUrlLimiter, (req, res) => {
  try {
    assertLineConfig();

    let state;
    if (typeof req.query.state === 'string' && req.query.state) {
      // 僅允許 onboarding 發出的 bind state，避免任意注入
      const bindState = verifyLineBindState(String(req.query.state));
      if (!bindState) {
        return res.status(400).json({ status: 'error', message: '無效的 state' });
      }
      state = String(req.query.state);
    } else {
      state = issueLoginState();
    }
    const loginUrl =
      `${LINE_AUTH_URL}?response_type=code` +
      `&client_id=${encodeURIComponent(LINE_CHANNEL_ID)}` +
      `&redirect_uri=${encodeURIComponent(LINE_CALLBACK_URL)}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent('profile openid')}`;

    res.json({
      status: 'success',
      data: {
        url: loginUrl,
        state,
        exchangeEndpoint: '/api/auth/line/token',
      },
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || '無法產生 LINE 登入網址',
    });
  }
});

// POST /api/auth/line/token  Body: { code, state? }
router.post('/line/token', lineExchangeLimiter, async (req, res) => {
  const { code, state, deviceId } = req.body || {};

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ status: 'error', message: '缺少 LINE authorization code' });
  }

  try {
    const { member, accessToken, bound } = await completeLineLoginWithCode(
      code,
      state || null,
      deviceId || null,
    );

    res.json({
      status: 'success',
      message: bound
        ? 'LINE 帳號已綁定（本機裝置一併綁定）'
        : 'LINE 登入成功',
      data: {
        token: accessToken,
        member: {
          id: member.id,
          name: member.name,
          plan: member.plan,
          hasDeviceBound: Boolean(member.deviceId),
          hasLineBound: Boolean(member.lineId),
        },
      },
    });
  } catch (error) {
    console.error('LINE code 換票失敗:', error);
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || 'LINE 登入驗證失敗',
    });
  }
});

// POST /api/auth/exchange-auth-code  Body: { authCode, deviceId? }
// deviceId：瀏覽器端本機碼；LINE callback 無法帶 device，於換票時一併綁定
router.post('/exchange-auth-code', lineExchangeLimiter, async (req, res) => {
  try {
    const authCode = String(req.body?.authCode || '').trim();
    const deviceId = req.body?.deviceId ? String(req.body.deviceId).trim() : '';
    const row = consumeAuthCode(authCode);

    let accessToken = row.token;
    let memberSnapshot = {
      ...row.member,
      hasDeviceBound: Boolean(row.member?.hasDeviceBound),
      hasLineBound: row.member?.hasLineBound !== false,
    };

    if (row.member?.id) {
      let member = await prisma.member.findUnique({ where: { id: row.member.id } });
      if (member) {
        if (deviceId.length >= 8) {
          if (member.deviceId && member.deviceId !== deviceId) {
            return res.status(403).json({
              status: 'error',
              message: '此帳號已綁定其他裝置，請洽櫃檯解除後再以此裝置登入',
            });
          }
          if (!member.deviceId) {
            member = await prisma.member.update({
              where: { id: member.id },
              data: deviceBindUpdateData({ deviceId }),
            });
          }
        }
        // 換票時重簽 JWT（含目前 deviceId／dav），避免 callback 舊票在改綁後仍可用
        accessToken = issueMemberToken(member.id, memberTokenDeviceOpts(member));
        memberSnapshot = {
          id: member.id,
          name: member.name,
          plan: member.plan,
          hasDeviceBound: Boolean(member.deviceId),
          hasLineBound: Boolean(member.lineId),
        };
      }
    }

    res.json({
      status: 'success',
      message: '登入成功',
      data: {
        token: accessToken,
        member: memberSnapshot,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || 'authCode 交換失敗',
    });
  }
});

// GET /api/auth/line/callback?code=...&state=...
router.get('/line/callback', async (req, res) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error || !code) {
      return res.redirect(
        memberAuthRedirect({ loginError: errorDescription || error || '登入被拒絕' }),
      );
    }

    const { accessToken, member } = await completeLineLoginWithCode(
      String(code),
      state ? String(state) : null,
    );
    // 瀏覽器 callback 尚無本機 deviceId；前端換 auth_code 時再綁裝置
    const authCode = issueAuthCode({
      token: accessToken,
      member: {
        id: member.id,
        name: member.name,
        plan: member.plan,
        hasDeviceBound: Boolean(member.deviceId),
        hasLineBound: Boolean(member.lineId),
      },
    });

    return res.redirect(
      memberAuthRedirect({
        authCode,
        needDevice: !member.deviceId,
      }),
    );
  } catch (err) {
    console.error('LINE callback 失敗:', err);
    try {
      return res.redirect(memberAuthRedirect({ loginError: err.message || '伺服器驗證失敗' }));
    } catch {
      return res.status(500).json({
        status: 'error',
        message: err.message || 'LINE 登入失敗且 FRONTEND_URL 未設定，無法導向前端',
      });
    }
  }
});

export default router;
