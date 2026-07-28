// routes/gate.js
import express from 'express';
import prisma from '../lib/prisma.js';
import { identifyFace, getSimilarityThreshold, isMockMode } from '../lib/papago.js';
import { verifyGateQrToken, QR_TTL_MS } from '../lib/qrToken.js';
import { broadcastOccupancy } from '../lib/occupancy.js';
import { memberHasSignedBiometricsConsent, assertMemberSignedNewMemberContract } from '../lib/memberContract.js';
import { assertMemberNotOnLeave } from '../lib/memberLeave.js';
import { assertMemberBoundGateAccess } from '../lib/memberBranch.js';
import { resolveGateContext, serializeGateDevice } from '../lib/gateDevice.js';
import {
  processCheckOut,
  broadcastCheckOut,
  checkOutSuccessPayload,
} from '../lib/gateCheckout.js';
import { formatGateAccessNo } from '../lib/gateAccessNo.js';

const router = express.Router();
const MIN_BALANCE_FOR_TIMED = 10;

function httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sendGateError(res, error, fallbackMessage) {
  console.error(error);
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({
    status: 'error',
    message: error.statusCode ? error.message : fallbackMessage,
  });
}

// ==========================================
// 身分解析：QR / FACE（進出場共用，嚴禁前端直傳 memberId）
// ==========================================
async function resolveMemberFromQr(qrToken) {
  const { memberId, deviceId: tokenDeviceId } = verifyGateQrToken(qrToken);

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) throw httpError('無此會員', 404);

  // 門禁不自動綁裝置（避免遞增 dav 讓 App 內 JWT 失效）；須先在會員端完成綁定
  if (!member.deviceId) {
    throw httpError(
      '⛔ 尚未綁定手機裝置：請先於會員 App 完成登入／裝置綁定後再掃碼進場。',
      403,
    );
  }
  if (tokenDeviceId && member.deviceId !== tokenDeviceId) {
    throw httpError(
      '⛔ 門禁阻擋：檢測到更換手機裝置！請洽櫃檯解除綁定，嚴禁共用帳號。',
      403,
    );
  }

  return member;
}

async function resolveMemberFromFace(faceImage) {
  if (!faceImage) throw httpError('缺少人臉影像', 400);

  let identification;
  try {
    identification = await identifyFace({ imageBase64: faceImage });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '人臉辨識服務異常';
    if (msg.includes('PAPAGO Mock')) throw httpError(msg, 400);
    throw err;
  }

  if (!identification.livenessPassed) {
    throw httpError('⛔ 活體檢測失敗：請以真實人臉面對鏡頭，禁止使用照片或影片。', 403);
  }

  if (!identification.faceId) {
    throw httpError(
      `⛔ 人臉辨識失敗：無法匹配已註冊會員 (信心度: ${(identification.confidence * 100).toFixed(1)}%，門檻: ${(getSimilarityThreshold() * 100).toFixed(0)}%)`,
      403
    );
  }

  const member = await prisma.member.findUnique({
    where: { papagoFaceId: identification.faceId },
  });

  if (!member) {
    throw httpError('⛔ 辨識到人臉但未綁定會員帳號，請至櫃檯重新註冊。', 403);
  }

  if (!(await memberHasSignedBiometricsConsent(member.id))) {
    throw httpError('⚖️ 拒絕開啟：會員未臨櫃簽署「生物辨識同意書」，依法系統不得處理其人臉特徵。', 403);
  }

  return member;
}

function assertQrNotBlockedByAlert(member) {
  if (member.isAlert) {
    throw httpError(
      '🚨 警示帳號：動態 QR Code 已失效！強制要求人工查驗或限用實名生物辨識進出場。',
      403
    );
  }
}

// ==========================================
// 進場：防卡單 / 自動降級 / 跨夜快照
// ==========================================
async function processCheckIn(memberId, entryMethod, branchId, gateDeviceId = null) {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const member = await tx.member.findUnique({ where: { id: memberId } });
    if (!member) throw httpError('無此會員', 404);

    // 會員契約（入會）必簽：未簽不得進場
    await assertMemberSignedNewMemberContract(memberId, tx);

    if (member.isAlert && entryMethod === 'QR') {
      throw httpError(
        '🚨 警示帳號：動態 QR Code 已失效！強制要求人工查驗或限用實名生物辨識進場。',
        403
      );
    }

    if (entryMethod === 'FACE') {
      if (!(await memberHasSignedBiometricsConsent(memberId))) {
        throw httpError(
          '⚖️ 拒絕開啟：會員未臨櫃簽署「生物辨識同意書」，依法系統不得處理其人臉特徵。',
          403
        );
      }
      if (!member.papagoFaceId) {
        throw httpError('⛔ 此會員尚未完成 PAPAGO 人臉註冊，請至櫃檯辦理綁定。', 403);
      }
    }

    const unfinishedLog = await tx.checkInLog.findFirst({
      where: { memberId, checkOutAt: null, status: 'ACTIVE' },
    });
    if (unfinishedLog) {
      throw httpError('⛔ 防卡單：會員已在場內，請先完成出場結算。', 400);
    }

    // 請假中不可用無限／月費通行；期滿自動清 leaveUntil
    let memberForGate = member;
    try {
      memberForGate = await assertMemberNotOnLeave(member, { now, tx });
    } catch (leaveErr) {
      throw leaveErr;
    }

    let currentPlan = memberForGate.plan;
    let downgraded = false;
    if (memberForGate.expireDate && now > memberForGate.expireDate) {
      await tx.member.update({
        where: { id: memberId },
        data: { plan: '計時會員', expireDate: null },
      });
      currentPlan = '計時會員';
      downgraded = true;
    }

    let appliedBillingMode = '計時扣款';
    if (currentPlan === '月費會員' || currentPlan === '無限會員') {
      appliedBillingMode = '月費通行';
    }

    if (appliedBillingMode === '計時扣款') {
      const totalAvailable = memberForGate.cashWallet + memberForGate.bonusWallet;
      if (totalAvailable < MIN_BALANCE_FOR_TIMED) {
        throw httpError(
          `方案已過期或為計時制，餘額不足無法進場！(總額: ${totalAvailable})`,
          403
        );
      }
    }

    // 進出場：必須為會員綁定場館（含 AC↔HP 共享）
    if (!branchId) {
      throw httpError('閘機未設定分店，無法進場', 400);
    }
    await assertMemberBoundGateAccess(memberId, branchId, tx);

    const log = await tx.checkInLog.create({
      data: {
        memberId,
        billingMode: appliedBillingMode,
        branchId,
        ...(gateDeviceId ? { gateDeviceId } : {}),
      },
    });

    return { member: memberForGate, log, appliedBillingMode, downgraded, entryMethod };
  });
}

function sendCheckInSuccess(res, result) {
  const { member, appliedBillingMode, downgraded, entryMethod, log } = result;
  broadcastOccupancy({ type: 'check-in', memberId: member.id }).catch(() => {});
  return res.json({
    status: 'success',
    message: `【體育客】歡迎進場！本次以 [${appliedBillingMode}] 授權`,
    memberName: member.name,
    memberId: member.id,
    entryMethod,
    billingMode: appliedBillingMode,
    downgraded,
    checkInAt: log.checkInAt,
    gateLogId: log.id,
    gateAccessNo: formatGateAccessNo(log.checkInAt),
  });
}

// ==========================================
// 出場：依進場快照結算（絕對禁止再讀 Member.plan）→ lib/gateCheckout.js
// ==========================================
function sendCheckOutSuccess(res, result) {
  broadcastCheckOut(result);
  return res.json(checkOutSuccessPayload(result));
}

// ==========================================
// 【門禁端】進場：QR 掃碼 / 人臉
// （動態 QR 產生已歸位 → GET|POST /api/member/qr-code）
// POST /api/gate/check-in
// Body: { qrToken, branchId? } | { entryMethod: "FACE", faceImage, branchId? }
// ==========================================
router.post('/check-in', async (req, res) => {
  const { qrToken, entryMethod = 'QR', faceImage, memberId } = req.body;

  if (memberId !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 嚴禁前端傳遞 memberId。請掃 QR Code 或刷臉進場。',
    });
  }

  if (entryMethod === 'FACE') {
    return handleFaceCheckIn(faceImage, res, req.body);
  }

  if (entryMethod === 'BIOMETRIC') {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 已停用：請改用 POST /api/gate/check-in/face',
    });
  }

  if (entryMethod !== 'QR') {
    return res.status(400).json({ status: 'error', message: '不支援的進場方式' });
  }

  try {
    const ctx = await resolveGateContext(req.body);
    const member = await resolveMemberFromQr(qrToken);
    assertQrNotBlockedByAlert(member);
    const result = await processCheckIn(member.id, 'QR', ctx.branchId, ctx.gateDeviceId);
    return sendCheckInSuccess(res, result);
  } catch (error) {
    if (error.code === 'QR_MISSING') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    if (error.code === 'QR_EXPIRED' || error.code === 'QR_INVALID') {
      return res.status(403).json({ status: 'error', message: error.message });
    }
    return sendGateError(res, error, '進場故障');
  }
});

async function handleFaceCheckIn(faceImage, res, body) {
  try {
    const ctx = await resolveGateContext(body || {});
    const member = await resolveMemberFromFace(faceImage);
    const result = await processCheckIn(member.id, 'FACE', ctx.branchId, ctx.gateDeviceId);
    return sendCheckInSuccess(res, result);
  } catch (error) {
    if (error.statusCode) return sendGateError(res, error, '進場故障');
    console.error('人臉進場失敗:', error);
    return res.status(500).json({
      status: 'error',
      message: error.message || '人臉辨識服務異常',
    });
  }
}

router.post('/check-in/face', async (req, res) => {
  return handleFaceCheckIn(req.body.faceImage, res, req.body);
});

// ==========================================
// 【門禁端】出場：必須掃 QR 或刷臉（與進場同標準）
// POST /api/gate/check-out
// Body: { qrToken, deviceCode?, deviceKey? } | { exitMethod: "FACE", faceImage, ... }
// ==========================================
router.post('/check-out', async (req, res) => {
  const { qrToken, exitMethod = 'QR', entryMethod, faceImage, memberId } = req.body;
  const method = exitMethod || entryMethod || 'QR';

  // 資安：舊版直傳 memberId 一律拒絕
  if (memberId !== undefined) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 嚴禁前端傳遞 memberId。出場必須掃 QR Code 或刷臉。',
    });
  }

  if (method === 'FACE') {
    return handleFaceCheckOut(faceImage, res, req.body);
  }

  if (method === 'BIOMETRIC') {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 已停用：請改用 POST /api/gate/check-out/face',
    });
  }

  if (method !== 'QR') {
    return res.status(400).json({ status: 'error', message: '不支援的出場方式' });
  }

  try {
    const ctx = await resolveGateContext(req.body);
    const member = await resolveMemberFromQr(qrToken);
    assertQrNotBlockedByAlert(member);
    const result = await processCheckOut({
      memberId: member.id,
      exitMethod: 'QR',
      branchId: ctx.branchId,
    });
    return sendCheckOutSuccess(res, result);
  } catch (error) {
    if (error.code === 'QR_MISSING') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    if (error.code === 'QR_EXPIRED' || error.code === 'QR_INVALID') {
      return res.status(403).json({ status: 'error', message: error.message });
    }
    return sendGateError(res, error, '出場結算失敗');
  }
});

async function handleFaceCheckOut(faceImage, res, body) {
  try {
    const ctx = await resolveGateContext(body || {});
    const member = await resolveMemberFromFace(faceImage);
    const result = await processCheckOut({
      memberId: member.id,
      exitMethod: 'FACE',
      branchId: ctx.branchId,
    });
    return sendCheckOutSuccess(res, result);
  } catch (error) {
    if (error.statusCode) return sendGateError(res, error, '出場結算失敗');
    console.error('人臉出場失敗:', error);
    return res.status(500).json({
      status: 'error',
      message: error.message || '人臉辨識服務異常',
    });
  }
}

router.post('/check-out/face', async (req, res) => {
  return handleFaceCheckOut(req.body.faceImage, res, req.body);
});

router.get('/face/status', (req, res) => {
  res.json({
    status: 'success',
    data: {
      provider: 'PAPAGO Face8',
      mockMode: isMockMode(),
      similarityThreshold: getSimilarityThreshold(),
      qrTtlMs: QR_TTL_MS,
    },
  });
});

/** 閘機配對驗證：回傳裝置名稱／分店（不含金鑰） */
router.post('/device/pair', async (req, res) => {
  try {
    const ctx = await resolveGateContext({
      deviceCode: req.body?.deviceCode,
      deviceKey: req.body?.deviceKey,
    });
    if (!ctx.device) {
      return res.status(400).json({
        status: 'error',
        message: '請提供 deviceCode 與 deviceKey',
      });
    }
    res.json({
      status: 'success',
      message: `已配對 ${ctx.device.code}`,
      data: serializeGateDevice(ctx.device),
    });
  } catch (error) {
    return sendGateError(res, error, '裝置配對失敗');
  }
});

/** 閘機設定用：啟用中分店清單（僅 id／名稱；相容舊流程） */
router.get('/branches', async (_req, res) => {
  try {
    const branches = await prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: branches });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取分店失敗' });
  }
});

export default router;
