// routes/member.js — 會員專屬 API（一律從 JWT 取 memberId，不信前端傳 ID）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyMember, verifyMemberDevice } from '../middleware/jwtAuth.js';
import { signGateQrToken, QR_TTL_MS } from '../lib/qrToken.js';
import { buildCardCheckoutRequest, parseCardPayOptions } from '../lib/payuni.js';
import { assertPromotionSellable, promotionSellablePrismaWhere, buildTopupItemDesc } from '../lib/promotion.js';
import {
  assertMemberSignedPromotionContracts,
  assertMemberSignedNewMemberContract,
  buildMembersContractBoard,
  serializeSignature,
} from '../lib/memberContract.js';
import { assertMemberReadyToBind } from '../lib/memberOnboardingGate.js';
import { normalizePhone } from '../lib/memberIdentify.js';
import { listTrainerTimeOffs, assertTrainerNotOnTimeOff } from '../lib/trainerTimeOff.js';
import { notifyClassBooked } from '../lib/lineNotify.js';
import { memberBranchLabel } from '../lib/branchLabel.js';
import { resolveDisplayName } from '../lib/displayName.js';
import {
  assertGroupClassVenueAllowed,
  assertPrivateVenueAllowed,
  isClassVenueAllowed,
  isPrivateVenueAllowed,
  resolveMemberFacilityBranches,
  resolvePrivateVenueBranchIds,
} from '../lib/branchShare.js';
import { resolveTopupOrderId } from '../lib/orderIds.js';
import { issueMemberToken } from '../lib/onboardingAuth.js';
import {
  deviceBindUpdateIfChanged,
  memberTokenDeviceOpts,
  readRequestDeviceId,
} from '../lib/memberDevice.js';

const router = express.Router();

function serializeMemberProfile(member) {
  const branches = (member.branches || [])
    .filter((row) => row.branch && row.branch.isActive !== false)
    .map((row) => ({
      branchId: row.branchId,
      name: memberBranchLabel(row.branch) || row.branch.name || `#${row.branchId}`,
    }));
  return {
    id: member.id,
    memberNo: member.memberNo || null,
    name: member.name,
    phone: member.phone,
    emergencyContact: member.emergencyContact || null,
    emergencyContactPhone: member.emergencyContactPhone || null,
    plan: member.plan,
    expireDate: member.expireDate,
    cashWallet: member.cashWallet,
    bonusWallet: member.bonusWallet,
    allowBiometrics: member.allowBiometrics,
    isAlert: member.isAlert,
    hasFaceBound: Boolean(member.papagoFaceId),
    hasLineBound: Boolean(member.lineId),
    hasDeviceBound: Boolean(member.deviceId),
    createdAt: member.createdAt,
    /** 綁定分店（正式名稱，會員端顯示） */
    branches,
    branchLabel: branches.length ? branches.map((b) => b.name).join('、') : null,
  };
}

const PROFILE_SELECT = {
  id: true,
  memberNo: true,
  name: true,
  phone: true,
  emergencyContact: true,
  emergencyContactPhone: true,
  plan: true,
  expireDate: true,
  cashWallet: true,
  bonusWallet: true,
  allowBiometrics: true,
  isAlert: true,
  papagoFaceId: true,
  lineId: true,
  deviceId: true,
  createdAt: true,
  branches: {
    include: {
      branch: { select: { id: true, name: true, code: true, isActive: true } },
    },
  },
};

// 整包海關：以下所有路由必須持有 type: 'member' JWT，且本機裝置須吻合綁定
router.use(verifyMember);
router.use(verifyMemberDevice);

// ==========================================
// 1. 會員個人檔案
// GET /api/member/me
// ==========================================
router.get('/me', async (req, res) => {
  const memberId = req.user.memberId;

  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: PROFILE_SELECT,
    });

    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到該會員' });
    }

    res.json({
      status: 'success',
      data: serializeMemberProfile(member),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取會員資料失敗' });
  }
});

// PATCH /api/member/me — 會員自助更新個人資料（不可改錢包／方案／綁定）
// Body: { name?, emergencyContact?, emergencyContactPhone? }
router.patch('/me', async (req, res) => {
  const memberId = req.user.memberId;
  const body = req.body || {};

  const forbidden = [
    'cashWallet',
    'bonusWallet',
    'plan',
    'expireDate',
    'phone',
    'lineId',
    'deviceId',
    'allowBiometrics',
    'isAlert',
    'memberId',
    'id',
    'memberNo',
  ];
  const hit = forbidden.filter((k) => body[k] !== undefined);
  if (hit.length) {
    return res.status(400).json({
      status: 'error',
      message: `⛔ 不可自行修改：${hit.join(', ')}（手機／LINE／裝置請洽櫃檯或走綁定流程）`,
    });
  }

  const data = {};
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (name.length < 2) {
      return res.status(400).json({ status: 'error', message: '姓名至少 2 字' });
    }
    data.name = name;
  }
  if (body.emergencyContact !== undefined) {
    const value = String(body.emergencyContact || '').trim();
    data.emergencyContact = value || null;
  }
  if (body.emergencyContactPhone !== undefined) {
    const raw = String(body.emergencyContactPhone || '').trim();
    if (!raw) {
      data.emergencyContactPhone = null;
    } else {
      const phone = normalizePhone(raw);
      if (!/^09\d{8}$/.test(phone)) {
        return res.status(400).json({
          status: 'error',
          message: '緊急聯絡人手機須為 09 開頭 10 碼',
        });
      }
      data.emergencyContactPhone = phone;
    }
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ status: 'error', message: '沒有可更新的欄位' });
  }

  try {
    const member = await prisma.member.update({
      where: { id: memberId },
      data,
      select: PROFILE_SELECT,
    });
    res.json({
      status: 'success',
      message: '個人資料已更新',
      data: serializeMemberProfile(member),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '更新個人資料失敗' });
  }
});

// POST /api/member/bind-device { deviceId } — 自助綁定本機（僅尚未綁定或相同裝置）
router.post('/bind-device', async (req, res) => {
  const memberId = req.user.memberId;
  const deviceId = String(req.body?.deviceId || '').trim();
  if (!deviceId || deviceId.length < 8) {
    return res.status(400).json({ status: 'error', message: '裝置識別碼無效' });
  }

  try {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到該會員' });
    }
    await assertMemberReadyToBind(member);
    if (!member.lineId) {
      return res.status(400).json({
        status: 'error',
        message: '請先綁定 LINE（綁定 LINE 時會一併綁定本機裝置）',
      });
    }
    if (member.deviceId && member.deviceId !== deviceId) {
      return res.status(403).json({
        status: 'error',
        message: '此帳號已綁定其他裝置，請洽櫃檯解除後再綁定',
      });
    }
    const bindPatch = deviceBindUpdateIfChanged(member.deviceId, deviceId);
    const updated = bindPatch
      ? await prisma.member.update({
          where: { id: memberId },
          data: bindPatch,
          select: { id: true, name: true, plan: true, deviceId: true, deviceAuthVersion: true },
        })
      : {
          id: member.id,
          name: member.name,
          plan: member.plan,
          deviceId: member.deviceId,
          deviceAuthVersion: member.deviceAuthVersion,
        };
    const token = issueMemberToken(updated.id, memberTokenDeviceOpts(updated));
    res.json({
      status: 'success',
      message: bindPatch ? '裝置已綁定' : '裝置已綁定（本機）',
      data: { ...updated, token },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        code: error.code,
        message: error.message,
      });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '綁定裝置失敗' });
  }
});

// ==========================================
// 2. 查詢雙錢包與方案
// GET /api/member/wallet
// ==========================================
router.get('/wallet', async (req, res) => {
  const memberId = req.user.memberId;

  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        name: true,
        plan: true,
        expireDate: true,
        cashWallet: true,
        bonusWallet: true,
        isAlert: true,
      },
    });

    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到該會員' });
    }

    res.json({ status: 'success', data: member });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取錢包失敗' });
  }
});

// ==========================================
// 3. 產生 30 秒動態門禁 QR（正式歸位於會員端）
// GET /api/member/qr-code?deviceId=xxx
// POST /api/member/qr-code  Body: { deviceId }
// ==========================================
async function handleGenerateQr(req, res) {
  const memberId = req.user.memberId;
  const deviceId = readRequestDeviceId(req);

  try {
    if (!deviceId || deviceId.length < 8) {
      return res.status(400).json({
        status: 'error',
        message: '缺少裝置識別碼 (deviceId)，無法產生門禁碼',
      });
    }

    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { isAlert: true, name: true, deviceId: true },
    });

    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到該會員' });
    }

    if (!member.deviceId) {
      return res.status(403).json({
        status: 'error',
        code: 'DEVICE_REQUIRED',
        message: '請先完成本機裝置綁定後再產生門禁碼',
      });
    }

    if (String(member.deviceId).trim() !== deviceId) {
      return res.status(403).json({
        status: 'error',
        code: 'DEVICE_MISMATCH',
        message: '⛔ 此帳號已改綁其他裝置，無法以此裝置產生門禁碼',
      });
    }

    if (member.isAlert) {
      return res.status(403).json({
        status: 'error',
        message: '🚨 警示帳號：動態 QR Code 已停用，請洽櫃檯或使用人臉辨識進場。',
      });
    }

    await assertMemberSignedNewMemberContract(memberId);

    const { qrToken, expiresInMs } = signGateQrToken({
      memberId,
      deviceId: String(member.deviceId),
    });

    res.json({
      status: 'success',
      message: `動態門禁碼已生成，有效時間 ${expiresInMs / 1000} 秒`,
      qrToken,
      expiresInMs,
      ttlSeconds: QR_TTL_MS / 1000,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        status: 'error',
        message: error.message,
      });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: 'QR Code 產生失敗' });
  }
}

router.get('/qr-code', handleGenerateQr);
router.post('/qr-code', handleGenerateQr);

// ==========================================
// 4. 我的私教合約（只看自己的）
// GET /api/member/pt-contracts
// ==========================================
router.get('/pt-contracts', async (req, res) => {
  const memberId = req.user.memberId;

  try {
    const contracts = await prisma.pTContract.findMany({
      where: { memberId },
      include: {
        trainer: { select: { id: true, name: true, displayName: true } },
        coursePlan: { select: { id: true, name: true, kind: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      status: 'success',
      data: contracts.map((c) => ({
        id: c.id,
        trainer: c.trainer
          ? { id: c.trainer.id, name: resolveDisplayName(c.trainer) }
          : null,
        source: c.source || 'PURCHASE',
        coursePlanId: c.coursePlanId ?? null,
        coursePlanName: c.coursePlan?.name || null,
        totalSessions: c.totalSessions,
        usedSessions: c.usedSessions,
        remainingSessions: c.totalSessions - c.usedSessions,
        isActive: c.isActive,
        expiresAt: c.expiresAt,
        createdAt: c.createdAt,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取私教合約失敗' });
  }
});

// GET /api/member/trainers/:trainerId/time-offs — 會員查看所屬教練排休（避開預約）
router.get('/trainers/:trainerId/time-offs', async (req, res) => {
  const memberId = req.user.memberId;
  const trainerId = parseInt(req.params.trainerId, 10);
  if (!Number.isInteger(trainerId) || trainerId <= 0) {
    return res.status(400).json({ status: 'error', message: '教練編號無效' });
  }

  try {
    const linked = await prisma.pTContract.findFirst({
      where: { memberId, trainerId, isActive: true },
      select: { id: true },
    });
    if (!linked) {
      return res.status(403).json({
        status: 'error',
        message: '僅能查看自己私教合約所屬教練的排休',
      });
    }

    const now = new Date();
    const data = await listTrainerTimeOffs({
      trainerId,
      from: req.query.from || now.toISOString(),
      to:
        req.query.to ||
        new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      take: parseInt(req.query.take, 10) || 60,
    });

    res.json({
      status: 'success',
      data,
      meta: {
        trainerId,
        note: '請避開教練排休時段預約／排課',
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取教練排休失敗' });
  }
});

// GET /api/member/contracts — 已簽署 + 應簽署未簽署契約（唯讀）
router.get('/contracts', async (req, res) => {
  const memberId = req.user.memberId;

  try {
    const { boardByMember } = await buildMembersContractBoard([memberId]);
    const board = (boardByMember.get(memberId) || []).filter(
      (item) => item.status !== 'UNSIGNED' || item.required,
    );

    const versionIds = [
      ...new Set(board.map((b) => b.versionId).filter((id) => Number.isInteger(id))),
    ];
    const signatureIds = [
      ...new Set(board.map((b) => b.signatureId).filter((id) => Number.isInteger(id))),
    ];

    const [versions, signatures] = await Promise.all([
      versionIds.length
        ? prisma.membershipContractVersion.findMany({
            where: { id: { in: versionIds } },
            select: { id: true, body: true, changeNote: true },
          })
        : Promise.resolve([]),
      signatureIds.length
        ? prisma.memberContractSignature.findMany({
            where: { memberId, id: { in: signatureIds } },
            include: {
              contract: {
                select: {
                  id: true,
                  title: true,
                  shortName: true,
                  status: true,
                  versionBase: true,
                  purpose: true,
                },
              },
              contractVersion: {
                select: { id: true, version: true, body: true, changeNote: true },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const bodyByVersion = new Map(versions.map((v) => [v.id, v]));
    const sigById = new Map(signatures.map((s) => [s.id, serializeSignature(s)]));

    const items = board.map((item) => {
      const sig = item.signatureId ? sigById.get(item.signatureId) : null;
      const versionMeta = item.versionId ? bodyByVersion.get(item.versionId) : null;
      return {
        contractId: item.contractId,
        title: item.title,
        shortName: item.shortName,
        displayName: item.displayName,
        purpose: item.purpose,
        versionId: item.versionId,
        version: item.version,
        versionLabel: item.versionLabel,
        signatureId: item.signatureId,
        status: item.status,
        required: item.required,
        needsResign: item.needsResign,
        tone: item.tone,
        signedAt: item.signedAt || sig?.signedAt || null,
        body: sig?.body ?? versionMeta?.body ?? null,
        changeNote: sig?.changeNote ?? versionMeta?.changeNote ?? null,
        signatureData: sig?.status === 'SIGNED' ? sig.signatureData : null,
      };
    });

    // 未簽／需重簽優先，已簽在後
    items.sort((a, b) => {
      const rank = (s) => {
        if (s === 'NEEDS_RESIGN' || s === 'PENDING') return 0;
        if (s === 'UNSIGNED') return 1;
        return 2;
      };
      const d = rank(a.status) - rank(b.status);
      if (d !== 0) return d;
      const ta = a.signedAt ? new Date(a.signedAt).getTime() : 0;
      const tb = b.signedAt ? new Date(b.signedAt).getTime() : 0;
      return tb - ta;
    });

    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取契約清單失敗' });
  }
});

// ==========================================
// 5. 可線上購買的促銷商品（唯讀）
// GET /api/member/promotions
// ==========================================
router.get('/promotions', async (req, res) => {
  try {
    const promotions = await prisma.promotion.findMany({
      where: promotionSellablePrismaWhere(),
      select: {
        id: true,
        name: true,
        price: true,
        bonusGiven: true,
        usageType: true,
        planMode: true,
        saleStartAt: true,
        saleEndAt: true,
        durationDays: true,
        unitDays: true,
        periodCount: true,
        requiresMemberContract: true,
        enableCardRecurring: true,
        branchId: true,
        branch: { select: { id: true, name: true } },
      },
      orderBy: { id: 'asc' },
    });
    res.json({ status: 'success', data: promotions });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取促銷商品失敗' });
  }
});

// ==========================================
// 6. 會員自助線上儲值（PayUNi UPP）
// POST /api/member/orders  Body: { promotionId }
// 嚴禁任意 amount；memberId 只從 JWT 取
// ==========================================
router.post('/orders', async (req, res) => {
  const memberId = req.user.memberId;
  const {
    promotionId,
    cardMode,
    cardInst,
    periodType,
    periodTimes,
    amount,
    memberId: bodyMemberId,
    itemDesc,
    ...rest
  } = req.body || {};

  if (
    amount !== undefined ||
    itemDesc !== undefined ||
    bodyMemberId !== undefined ||
    Object.keys(rest).length > 0
  ) {
    return res.status(400).json({
      status: 'error',
      message:
        '⛔ 非法參數：線上訂單只允許 promotionId、cardMode、cardInst、periodType、periodTimes；金額由後端查 Promotion 決定，身分只認 JWT',
    });
  }

  if (promotionId === undefined) {
    return res.status(400).json({ status: 'error', message: '參數錯誤：必須提供 promotionId' });
  }

  try {
    const promotion = await prisma.promotion.findUnique({
      where: { id: parseInt(promotionId, 10) },
    });

    if (!promotion) {
      return res.status(400).json({ status: 'error', message: '促銷商品不存在或已下架' });
    }

    assertPromotionSellable(promotion);

    if (promotion.requiresMemberContract) {
      await assertMemberSignedPromotionContracts(memberId, promotion.id);
    }

    const member = await prisma.member.findUnique({ where: { id: memberId } });
    if (!member) {
      return res.status(404).json({ status: 'error', message: '找不到該會員' });
    }

    let cardOpts;
    try {
      cardOpts = parseCardPayOptions(
        { cardMode, cardInst, periodType, periodTimes },
        { allowRecurring: Boolean(promotion.enableCardRecurring) },
      );
    } catch (error) {
      return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
    }

    const orderId = resolveTopupOrderId({
      cardMode: cardOpts.cardMode,
      promotion,
    });
    const newOrder = await prisma.order.create({
      data: {
        id: orderId,
        memberId,
        amount: promotion.price,
        itemDesc: buildTopupItemDesc(promotion, '線上'),
        payMethod: 'CARD',
        cardAmount: promotion.price,
        cardMode: cardOpts.cardMode,
        cardInst: cardOpts.cardInst,
        periodType: cardOpts.periodType,
        periodTimes: cardOpts.periodTimes,
        status: 'PENDING',
      },
    });

    const { actionUrl, payload: payuniPayload } = buildCardCheckoutRequest({
      id: newOrder.id,
      amount: newOrder.amount,
      itemDesc: newOrder.itemDesc,
      cardMode: cardOpts.cardMode,
      cardInst: cardOpts.cardInst,
      periodType: cardOpts.periodType,
      periodTimes: cardOpts.periodTimes,
      periodAmt: newOrder.amount,
      recurringAmount: newOrder.amount,
    });

    res.json({
      status: 'success',
      message: '訂單建立成功，準備導向金流',
      data: {
        actionUrl,
        payload: payuniPayload,
        orderId: newOrder.id,
        promotionId: promotion.id,
        amount: promotion.price,
        bonusGiven: promotion.bonusGiven,
        cardMode: cardOpts.cardMode,
        cardInst: cardOpts.cardInst,
        periodType: cardOpts.periodType,
        periodTimes: cardOpts.periodTimes,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error(error);
    res.status(500).json({ status: 'error', message: '訂單建立失敗' });
  }
});

// ==========================================
// 7. 會員自助約課（LINE Login 後於 SPA；成功推播 LINE）
// ==========================================
function serializeMemberClass(row, memberId) {
  const active = (row.reservations || []).filter((r) =>
    ['PENDING', 'CONFIRMED'].includes(r.status),
  );
  const mine = active.find((r) => r.memberId === memberId) || null;
  const booked = active.length;
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    startAt: row.startAt,
    endAt: row.endAt,
    capacity: row.capacity,
    booked,
    remaining: Math.max(0, (row.capacity || 0) - booked),
    trainerId: row.trainerId,
    trainerName: row.trainer ? resolveDisplayName(row.trainer) : null,
    venueName: row.venue?.name || null,
    branchName: memberBranchLabel(row.venue?.branch),
    stationName: row.station?.name || null,
    myReservationId: mine?.id ?? null,
    canBook: !mine && booked < (row.capacity || 0),
  };
}

// GET /api/member/classes — 可預約課程（團課＋自己私教／諮詢；受購買分店限制）
router.get('/classes', async (req, res) => {
  const memberId = req.user.memberId;
  try {
    const now = new Date();
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
    const horizon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const [ptRows, facilityBranches] = await Promise.all([
      prisma.pTContract.findMany({
        where: { memberId, isActive: true },
        select: {
          trainerId: true,
          branchId: true,
          totalSessions: true,
          usedSessions: true,
          branch: { select: { id: true, name: true, code: true } },
        },
      }),
      resolveMemberFacilityBranches(memberId),
    ]);

    const activePts = ptRows.filter(
      (p) => (p.usedSessions || 0) < (p.totalSessions || 0),
    );
    const ptTrainerIds = [...new Set(activePts.map((p) => p.trainerId))];

    const privateBranchIdSet = new Set();
    for (const p of activePts) {
      if (!p.branchId) continue;
      const ids = await resolvePrivateVenueBranchIds(p.branchId);
      for (const id of ids) privateBranchIdSet.add(id);
    }
    const facilityBranchIds = new Set(facilityBranches.map((b) => b.id));

    const classes = await prisma.class.findMany({
      where: {
        startAt: { gte: now, lte: horizon },
        OR: [
          { type: 'GROUP' },
          ...(ptTrainerIds.length
            ? [{ type: { in: ['PRIVATE', 'CONSULT'] }, trainerId: { in: ptTrainerIds } }]
            : []),
        ],
      },
      include: {
        trainer: { select: { id: true, name: true, displayName: true } },
        venue: { include: { branch: { select: { id: true, name: true, code: true } } } },
        station: { select: { id: true, name: true } },
        reservations: {
          where: { status: { in: ['PENDING', 'CONFIRMED'] } },
          select: { id: true, status: true, memberId: true },
        },
      },
      orderBy: { startAt: 'asc' },
      take: 80,
    });

    const filtered = classes.filter((c) => {
      const venueBranch = c.venue?.branch;
      if (!venueBranch) return false;
      if (c.type === 'GROUP') {
        if (facilityBranchIds.size === 0) return true; // 無購案紀錄：相容舊資料
        return isClassVenueAllowed(facilityBranches, venueBranch);
      }
      if (c.type === 'PRIVATE' || c.type === 'CONSULT') {
        const ptsForTrainer = activePts.filter((p) => p.trainerId === c.trainerId);
        if (ptsForTrainer.length === 0) return false;
        // 無 branchId 的舊合約：不擋
        if (ptsForTrainer.every((p) => !p.branchId)) return true;
        return ptsForTrainer.some((p) => {
          if (!p.branch) return privateBranchIdSet.has(venueBranch.id);
          return isPrivateVenueAllowed(p.branch, venueBranch);
        });
      }
      return false;
    });

    res.json({
      status: 'success',
      data: filtered.map((c) => serializeMemberClass(c, memberId)),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取課程失敗' });
  }
});

// GET /api/member/reservations — 我的預約
router.get('/reservations', async (req, res) => {
  const memberId = req.user.memberId;
  try {
    const includePast = String(req.query.includePast || '') === '1';
    const now = new Date();
    const rows = await prisma.reservation.findMany({
      where: {
        memberId,
        status: { in: ['PENDING', 'CONFIRMED', ...(includePast ? ['COMPLETED', 'CANCELLED', 'NO_SHOW'] : [])] },
        ...(includePast ? {} : { class: { startAt: { gte: now } } }),
      },
      include: {
        class: {
          include: {
            trainer: { select: { id: true, name: true, displayName: true } },
            venue: { include: { branch: { select: { id: true, name: true, code: true } } } },
            station: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { bookedAt: 'desc' },
      take: Math.min(parseInt(req.query.take, 10) || 40, 100),
    });

    res.json({
      status: 'success',
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        source: r.source,
        bookedAt: r.bookedAt,
        class: r.class
          ? {
              id: r.class.id,
              title: r.class.title,
              type: r.class.type,
              startAt: r.class.startAt,
              endAt: r.class.endAt,
              trainerName: r.class.trainer ? resolveDisplayName(r.class.trainer) : null,
              venueName: r.class.venue?.name || null,
              branchName: memberBranchLabel(r.class.venue?.branch),
              stationName: r.class.station?.name || null,
            }
          : null,
        canCancel:
          ['PENDING', 'CONFIRMED'].includes(r.status) &&
          r.class &&
          new Date(r.class.startAt) > now,
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取預約失敗' });
  }
});

// POST /api/member/book-class  Body: { classId }
router.post('/book-class', async (req, res) => {
  const memberId = req.user.memberId;
  const { classId, memberId: bodyMemberId, ...rest } = req.body || {};

  if (bodyMemberId !== undefined || Object.keys(rest).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 非法參數：會員約課只允許 classId；身分只認 JWT',
    });
  }
  if (!classId) {
    return res.status(400).json({ status: 'error', message: '需提供 classId' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const member = await tx.member.findUnique({
        where: { id: memberId },
        select: { id: true, name: true, lineId: true, isAlert: true },
      });
      if (!member) {
        const err = new Error('找不到該會員');
        err.statusCode = 404;
        throw err;
      }
      if (member.isAlert) {
        const err = new Error('警示帳號無法自助約課，請洽櫃檯');
        err.statusCode = 403;
        throw err;
      }

      const targetClass = await tx.class.findUnique({
        where: { id: parseInt(classId, 10) },
        include: {
          reservations: { where: { status: { in: ['PENDING', 'CONFIRMED'] } } },
          venue: {
            include: { branch: { select: { id: true, name: true, code: true } } },
          },
          station: { select: { id: true, name: true } },
          trainer: { select: { id: true, name: true, displayName: true } },
        },
      });
      if (!targetClass) {
        const err = new Error('找不到該課程');
        err.statusCode = 404;
        throw err;
      }
      if (new Date(targetClass.startAt) <= new Date()) {
        const err = new Error('課程已開始或已結束，無法預約');
        err.statusCode = 400;
        throw err;
      }

      if (targetClass.type === 'GROUP') {
        const facilityBranches = await resolveMemberFacilityBranches(memberId, tx);
        if (facilityBranches.length > 0) {
          assertGroupClassVenueAllowed(facilityBranches, targetClass.venue?.branch);
        }
      } else if (targetClass.type === 'PRIVATE' || targetClass.type === 'CONSULT') {
        const pt = await tx.pTContract.findFirst({
          where: {
            memberId,
            trainerId: targetClass.trainerId,
            isActive: true,
          },
          include: { branch: { select: { id: true, name: true, code: true } } },
        });
        if (!pt) {
          const err = new Error('私教／諮詢課僅限該教練的合約學員自約');
          err.statusCode = 403;
          throw err;
        }
        if (pt.usedSessions >= pt.totalSessions) {
          const err = new Error('私教堂數已用罄，請洽櫃檯續購');
          err.statusCode = 400;
          throw err;
        }
        if (pt.branch && targetClass.venue?.branch) {
          assertPrivateVenueAllowed(pt.branch, targetClass.venue.branch);
        }
      } else {
        const err = new Error('此課程類型不支援自助預約');
        err.statusCode = 400;
        throw err;
      }

      await assertTrainerNotOnTimeOff(
        tx,
        targetClass.trainerId,
        targetClass.startAt,
        targetClass.endAt,
      );

      if (targetClass.reservations.length >= targetClass.capacity) {
        const err = new Error(`名額已滿（上限 ${targetClass.capacity}）`);
        err.statusCode = 400;
        throw err;
      }

      const already = targetClass.reservations.find((r) => r.memberId === memberId);
      if (already) {
        const err = new Error('您已預約過這堂課');
        err.statusCode = 400;
        throw err;
      }

      const reservation = await tx.reservation.create({
        data: {
          memberId,
          classId: targetClass.id,
          status: 'CONFIRMED',
          source: 'LINE',
        },
      });

      return { reservation, member, targetClass };
    });

    const { reservation, member, targetClass } = result;
    const notify = await notifyClassBooked({
      lineId: member.lineId,
      memberName: member.name,
      classTitle: targetClass.title,
      startAt: targetClass.startAt,
      endAt: targetClass.endAt,
      branchName: memberBranchLabel(targetClass.venue?.branch),
      venueName: targetClass.venue?.name || null,
      stationName: targetClass.station?.name || null,
      trainerName: targetClass.trainer ? resolveDisplayName(targetClass.trainer) : null,
      bookedBy: 'member',
    });

    let message = '預約成功';
    if (notify.ok) message += '，已透過 LINE 通知您';
    else if (notify.skipped) message += `（未推播：${notify.reason}）`;
    else message += `（LINE 通知失敗：${notify.reason || '未知'}）`;

    res.json({
      status: 'success',
      message,
      data: {
        id: reservation.id,
        classId: targetClass.id,
        status: reservation.status,
        notify: {
          ok: Boolean(notify.ok),
          skipped: Boolean(notify.skipped),
          reason: notify.reason || null,
        },
      },
    });
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    res.status(500).json({ status: 'error', message: '預約失敗' });
  }
});

// POST /api/member/reservations/:id/cancel
router.post('/reservations/:id/cancel', async (req, res) => {
  const memberId = req.user.memberId;
  try {
    const id = parseInt(req.params.id, 10);
    const row = await prisma.reservation.findFirst({
      where: { id, memberId },
      include: { class: { select: { startAt: true, title: true } } },
    });
    if (!row) {
      return res.status(404).json({ status: 'error', message: '找不到預約' });
    }
    if (!['PENDING', 'CONFIRMED'].includes(row.status)) {
      return res.status(400).json({ status: 'error', message: '此預約狀態無法取消' });
    }
    if (new Date(row.class.startAt) <= new Date()) {
      return res.status(400).json({ status: 'error', message: '課程已開始，無法取消' });
    }
    const updated = await prisma.reservation.update({
      where: { id: row.id },
      data: { status: 'CANCELLED' },
    });
    res.json({
      status: 'success',
      message: `已取消「${row.class.title}」預約`,
      data: { id: updated.id, status: updated.status },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '取消預約失敗' });
  }
});

export default router;
