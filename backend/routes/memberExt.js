// routes/memberExt.js — 會員自助延伸（profile、課程請假、訂閱、紀錄）
import express from 'express';
import multer from 'multer';
import prisma from '../lib/prisma.js';
import { verifyMember, verifyMemberDevice } from '../middleware/jwtAuth.js';
import { startMemberLeave } from '../lib/memberLeave.js';
import { storeLeaveProof, inclusiveLeaveDays } from '../lib/leaveProof.js';
import { settleCancelSubscription } from '../lib/subscriptionSettle.js';
import {
  buildSubscriptionRebindRequest,
  toRebindStatusView,
  repairPlaceholderNextChargeAts,
  syncPeriodNextChargeAtsFromPayuni,
} from '../lib/cardSubscription.js';
import {
  uploadMemberIdPhoto,
  readCurrentIdPhoto,
  normalizeIdPhotoSide,
  requestIdPhotoDelete,
  cancelIdPhotoDeleteRequest,
  getIdPhotoMetaForMember,
  logMemberView,
} from '../lib/idPhoto.js';

const router = express.Router();

router.use(verifyMember);

const leaveProofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (/^image\/(jpeg|png|webp)$/i.test(file.mimetype || '')) {
      cb(null, true);
      return;
    }
    cb(Object.assign(new Error('請假證明須為 JPG／PNG／WebP'), { statusCode: 400 }));
  },
});

function maybeLeaveProofUpload(req, res, next) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('multipart/form-data')) {
    next();
    return;
  }
  leaveProofUpload.single('proof')(req, res, (err) => {
    if (err) {
      sendErr(res, err, '上傳請假證明失敗');
      return;
    }
    next();
  });
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function parseDate(value, fieldName) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw httpError(`${fieldName} 無效`);
  return d;
}

function sendErr(res, error, fallback = '操作失敗') {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ status: 'error', message: error.message });
  }
  console.error(error);
  return res.status(500).json({ status: 'error', message: fallback });
}

/** 課程請假：開課前 24 小時內視為逾期（扣課／扣點） */
const CLASS_LEAVE_POLICY_HOURS = 24;

// PATCH /api/member/profile-ext
router.patch('/profile-ext', verifyMemberDevice, async (req, res) => {
  try {
    const memberId = req.user.memberId;
    const data = {};
    if (req.body?.email !== undefined) {
      const email = String(req.body.email || '').trim();
      data.email = email ? email.slice(0, 120) : null;
    }
    if (req.body?.gender !== undefined) {
      const g = String(req.body.gender || '').toUpperCase();
      if (g && !['M', 'F', 'OTHER'].includes(g)) throw httpError('gender 須為 M、F 或 OTHER');
      data.gender = g || null;
    }
    if (req.body?.birthDate !== undefined) {
      data.birthDate = req.body.birthDate ? parseDate(req.body.birthDate, 'birthDate') : null;
    }
    // 證件 URL 禁止由客戶端任意寫入；僅能經 POST /id-photo
    if (Object.keys(data).length === 0) throw httpError('請提供要更新的欄位');

    const member = await prisma.member.update({
      where: { id: memberId },
      data,
      select: {
        id: true,
        email: true,
        gender: true,
        birthDate: true,
        idPhotoUrl: true,
        idPhotoBackUrl: true,
      },
    });
    res.json({ status: 'success', message: '個人資料已更新', data: member });
  } catch (error) {
    sendErr(res, error, '更新個人資料失敗');
  }
});

// POST /api/member/id-photo — body: { image|dataUrl, side?: front|back, consent: true }
router.post('/id-photo', verifyMemberDevice, async (req, res) => {
  try {
    const memberId = req.user.memberId;
    if (req.body?.consent !== true && req.body?.consent !== 'true') {
      throw httpError('請確認已閱讀證件蒐集告知並同意後再上傳');
    }
    const side = normalizeIdPhotoSide(req.body?.side || 'front');
    const saved = await uploadMemberIdPhoto(
      memberId,
      req.body?.image || req.body?.dataUrl,
      side,
      req,
    );
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true, idPhotoUrl: true, idPhotoBackUrl: true },
    });
    res.json({
      status: 'success',
      message: side === 'back' ? '證件反面已上傳' : '證件正面已上傳',
      data: {
        ...member,
        side,
        bytes: saved.bytes,
        photoId: saved.photoId,
        retentionUntil: saved.retentionUntil,
      },
    });
  } catch (error) {
    sendErr(res, error, '上傳證件失敗');
  }
});

// GET /api/member/id-photo/meta — 現行檔與待核准清除申請
router.get('/id-photo/meta', verifyMemberDevice, async (req, res) => {
  try {
    const meta = await getIdPhotoMetaForMember(req.user.memberId);
    res.json({ status: 'success', data: meta });
  } catch (error) {
    sendErr(res, error, '讀取證件狀態失敗');
  }
});

// GET /api/member/id-photo?side=front|back — 認證後回傳影像
router.get('/id-photo', verifyMemberDevice, async (req, res) => {
  try {
    const side = normalizeIdPhotoSide(req.query?.side || 'front');
    const file = await readCurrentIdPhoto(req.user.memberId, side);
    if (!file) {
      return res.status(404).json({
        status: 'error',
        message: side === 'back' ? '尚未上傳證件反面' : '尚未上傳證件正面',
      });
    }
    await logMemberView(req.user.memberId, side, file.photoId, req);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(file.buf);
  } catch (error) {
    sendErr(res, error, '讀取證件失敗');
  }
});

// POST /api/member/id-photo/delete-request — 申請清除（櫃檯核准後才刪）
router.post('/id-photo/delete-request', verifyMemberDevice, async (req, res) => {
  try {
    const row = await requestIdPhotoDelete(
      req.user.memberId,
      req.body?.side || req.query?.side || 'front',
      req.body?.reason,
      req,
    );
    res.json({
      status: 'success',
      message: '已送出清除申請，待櫃檯核准後才會刪除存檔',
      data: row,
    });
  } catch (error) {
    sendErr(res, error, '送出清除申請失敗');
  }
});

// POST /api/member/id-photo/delete-request/:id/cancel
router.post('/id-photo/delete-request/:id/cancel', verifyMemberDevice, async (req, res) => {
  try {
    const row = await cancelIdPhotoDeleteRequest(req.user.memberId, req.params.id, req);
    res.json({ status: 'success', message: '已取消清除申請', data: row });
  } catch (error) {
    sendErr(res, error, '取消申請失敗');
  }
});

// DELETE 改為拒絕直接刪除（相容舊客戶端）
router.delete('/id-photo', verifyMemberDevice, async (_req, res) => {
  res.status(400).json({
    status: 'error',
    message: '證件清除須經櫃檯核准，請改呼叫 POST /member/id-photo/delete-request',
    code: 'ID_PHOTO_DELETE_REQUIRES_APPROVAL',
  });
});

// GET /api/member/orders-history
router.get('/orders-history', async (req, res) => {
  try {
    const memberId = req.user.memberId;
    const take = Math.min(100, parseInt(req.query.take, 10) || 50);
    const [orders, checkins] = await Promise.all([
      prisma.order.findMany({
        where: { memberId },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          amount: true,
          itemDesc: true,
          status: true,
          payMethod: true,
          createdAt: true,
        },
      }),
      prisma.checkInLog.findMany({
        where: { memberId, status: 'ACTIVE' },
        orderBy: { checkInAt: 'desc' },
        take,
        select: {
          id: true,
          checkInAt: true,
          checkOutAt: true,
          fee: true,
          billingMode: true,
          branchId: true,
        },
      }),
    ]);
    const items = [
      ...orders.map((o) => ({ kind: 'ORDER', at: o.createdAt, ...o })),
      ...checkins.map((c) => ({ kind: 'CHECKIN', at: c.checkInAt, ...c })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json({ status: 'success', data: items.slice(0, take) });
  } catch (error) {
    sendErr(res, error, '讀取消費紀錄失敗');
  }
});

// GET /api/member/class-records
router.get('/class-records', async (req, res) => {
  try {
    const memberId = req.user.memberId;
    const [reservations, attendances] = await Promise.all([
      prisma.reservation.findMany({
        where: { memberId },
        include: {
          class: {
            select: {
              id: true,
              title: true,
              type: true,
              startAt: true,
              endAt: true,
              trainer: { select: { id: true, name: true } },
            },
          },
          classLeave: true,
        },
        orderBy: { bookedAt: 'desc' },
        take: Math.min(100, parseInt(req.query.take, 10) || 50),
      }),
      prisma.classAttendance.findMany({
        where: { memberId },
        include: {
          class: {
            select: { id: true, title: true, type: true, startAt: true, endAt: true },
          },
        },
        orderBy: { checkedInAt: 'desc' },
        take: Math.min(100, parseInt(req.query.take, 10) || 50),
      }),
    ]);
    res.json({ status: 'success', data: { reservations, attendances } });
  } catch (error) {
    sendErr(res, error, '讀取課程紀錄失敗');
  }
});

router.get('/self-training-plans', async (req, res) => {
  try {
    const rows = await prisma.selfTrainingPlan.findMany({
      where: { memberId: req.user.memberId },
      include: { trainer: { select: { id: true, name: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取自主訓練課表失敗');
  }
});

router.get('/training-records', async (req, res) => {
  try {
    const rows = await prisma.trainingRecord.findMany({
      where: { memberId: req.user.memberId, sharedAt: { not: null } },
      include: { trainer: { select: { id: true, name: true } } },
      orderBy: { sharedAt: 'desc' },
    });
    res.json({ status: 'success', data: rows });
  } catch (error) {
    sendErr(res, error, '讀取訓練紀錄失敗');
  }
});

router.post('/class-leave', verifyMemberDevice, async (req, res) => {
  try {
    const memberId = req.user.memberId;
    const reservationId = parseInt(req.body?.reservationId, 10);
    if (!Number.isInteger(reservationId) || reservationId <= 0) {
      throw httpError('請提供 reservationId');
    }

    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { class: true, classLeave: true },
    });
    if (!reservation || reservation.memberId !== memberId) {
      return res.status(404).json({ status: 'error', message: '找不到預約' });
    }
    if (reservation.classLeave) throw httpError('此預約已申請請假');
    if (!['CONFIRMED', 'PENDING'].includes(reservation.status)) {
      throw httpError('此預約狀態不可請假');
    }

    const hoursUntil =
      (new Date(reservation.class.startAt) - Date.now()) / (3600 * 1000);
    const withinPolicy = hoursUntil >= CLASS_LEAVE_POLICY_HOURS;
    let deductedSessions = 0;
    let deductedPoints = 0;

    const row = await prisma.$transaction(async (tx) => {
      if (!withinPolicy && reservation.class.type === 'PRIVATE') {
        const pt = await tx.pTContract.findFirst({
          where: { memberId, isActive: true, trainerId: reservation.class.trainerId },
          orderBy: { createdAt: 'desc' },
        });
        if (pt && pt.usedSessions < pt.totalSessions) {
          await tx.pTContract.update({
            where: { id: pt.id },
            data: { usedSessions: pt.usedSessions + 1 },
          });
          deductedSessions = 1;
        }
      }
      if (!withinPolicy && reservation.class.type === 'GROUP') {
        const member = await tx.member.findUnique({ where: { id: memberId } });
        if (member && member.pointsBalance >= 1) {
          await tx.member.update({
            where: { id: memberId },
            data: { pointsBalance: member.pointsBalance - 1 },
          });
          await tx.memberPointsLedger.create({
            data: {
              memberId,
              delta: -1,
              balance: member.pointsBalance - 1,
              reason: '逾期請假扣點',
              refType: 'CLASS_LEAVE',
              refId: String(reservationId),
            },
          });
          deductedPoints = 1;
        }
      }

      const leave = await tx.classLeave.create({
        data: {
          memberId,
          reservationId,
          reason: req.body?.reason ? String(req.body.reason).slice(0, 200) : null,
          status: withinPolicy ? 'APPROVED' : 'APPROVED',
          withinPolicy,
          deductedSessions,
          deductedPoints,
        },
      });

      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'CANCELLED' },
      });

      return leave;
    });

    const msg = withinPolicy
      ? '請假已核准'
      : `請假已核准（未依規定，${deductedSessions ? `扣 ${deductedSessions} 堂` : ''}${deductedPoints ? `扣 ${deductedPoints} 點` : ''}）`.trim();
    res.json({ status: 'success', message: msg, data: row });
  } catch (error) {
    sendErr(res, error, '課程請假失敗');
  }
});

router.get('/makeup-slots', async (req, res) => {
  try {
    const memberId = req.user.memberId;
    const now = new Date();
    const slots = await prisma.makeupSlot.findMany({
      where: { class: { startAt: { gt: now } } },
      include: {
        class: {
          select: {
            id: true,
            title: true,
            startAt: true,
            endAt: true,
            trainer: { select: { id: true, name: true } },
          },
        },
        _count: { select: { registrations: true } },
      },
      orderBy: { class: { startAt: 'asc' } },
      take: 50,
    });
    const items = slots
      .filter((s) => s._count.registrations < s.capacity)
      .map((s) => ({
        id: s.id,
        classId: s.classId,
        capacity: s.capacity,
        registered: s._count.registrations,
        remaining: s.capacity - s._count.registrations,
        class: s.class,
      }));

    const myRegs = await prisma.makeupRegistration.findMany({
      where: { memberId },
      select: { makeupSlotId: true, status: true },
    });
    res.json({ status: 'success', data: { slots: items, myRegistrations: myRegs } });
  } catch (error) {
    sendErr(res, error, '讀取補課名額失敗');
  }
});

router.post('/makeup-register', verifyMemberDevice, async (req, res) => {
  try {
    const memberId = req.user.memberId;
    const makeupSlotId = parseInt(req.body?.makeupSlotId, 10);
    if (!Number.isInteger(makeupSlotId) || makeupSlotId <= 0) {
      throw httpError('請提供 makeupSlotId');
    }
    const slot = await prisma.makeupSlot.findUnique({
      where: { id: makeupSlotId },
      include: { _count: { select: { registrations: true } }, class: true },
    });
    if (!slot) return res.status(404).json({ status: 'error', message: '找不到補課名額' });
    if (slot._count.registrations >= slot.capacity) throw httpError('補課名額已滿');

    const row = await prisma.makeupRegistration.create({
      data: {
        memberId,
        makeupSlotId,
        originalReservationId: req.body?.originalReservationId
          ? parseInt(req.body.originalReservationId, 10)
          : null,
      },
    });
    res.json({ status: 'success', message: '補課登記成功', data: row });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ status: 'error', message: '您已登記此補課' });
    }
    sendErr(res, error, '補課登記失敗');
  }
});

router.post('/subscription-leave', verifyMemberDevice, async (req, res) => {
  try {
    const memberId = req.user.memberId;
    const result = await startMemberLeave({
      memberId,
      days: req.body?.days,
      reason: req.body?.reason,
      staffId: null,
      subscriptionId: req.body?.subscriptionId
        ? String(req.body.subscriptionId).trim()
        : undefined,
    });
    const payuniMsg =
      result.payuniStop && !result.payuniStop.skipped
        ? result.payuniStop.ok
          ? '；PayUNi 續期已暫停'
          : `；⚠ PayUNi 可能未停（${result.payuniStop.message || '請洽櫃檯'}）`
        : '';
    res.json({
      status: 'success',
      message: `已請假 ${result.leave.days} 天；效期已順延，定期定額已暫停${payuniMsg}`,
      data: result,
    });
  } catch (error) {
    sendErr(res, error, '會籍請假失敗');
  }
});

/**
 * POST /api/member/leave-application
 * JSON：{ startDate, endDate, reason?, subscriptionId?, proofImage?, proofFileName? }
 * multipart/form-data：startDate, endDate, reason?, subscriptionId?, proof=<file>
 * 身分只從 JWT；不收 memberId。
 */
router.post(
  '/leave-application',
  verifyMemberDevice,
  maybeLeaveProofUpload,
  async (req, res) => {
    try {
      const memberId = req.user.memberId;
      const startDate = String(req.body?.startDate || '').trim();
      const endDate = String(req.body?.endDate || '').trim();
      if (!startDate || !endDate) throw httpError('請提供請假起始日與結束日');

      const days = inclusiveLeaveDays(startDate, endDate);
      let proofStorageKey = null;
      let proofFileName = null;

      if (req.file?.buffer) {
        const stored = await storeLeaveProof(
          memberId,
          req.file.buffer,
          req.file.originalname,
        );
        proofStorageKey = stored.storageKey;
        proofFileName = stored.fileName;
      } else if (req.body?.proofImage || req.body?.proofDataUrl) {
        const stored = await storeLeaveProof(
          memberId,
          req.body.proofImage || req.body.proofDataUrl,
          req.body.proofFileName,
        );
        proofStorageKey = stored.storageKey;
        proofFileName = stored.fileName;
      }

      const result = await startMemberLeave({
        memberId,
        days,
        reason: req.body?.reason,
        staffId: null,
        subscriptionId: req.body?.subscriptionId
          ? String(req.body.subscriptionId).trim()
          : undefined,
        proofStorageKey,
        proofFileName,
      });

      const payuniMsg =
        result.payuniStop && !result.payuniStop.skipped
          ? result.payuniStop.ok
            ? '；PayUNi 續期已暫停'
            : `；⚠ PayUNi 可能未停（${result.payuniStop.message || '請洽櫃檯'}）`
          : '';

      res.json({
        status: 'success',
        message: `已請假 ${result.leave.days} 天；效期已順延，定期定額已暫停${payuniMsg}`,
        data: {
          ...result,
          hasProof: Boolean(proofStorageKey),
        },
      });
    } catch (error) {
      sendErr(res, error, '會籍請假失敗');
    }
  },
);

router.post('/subscription-cancel', verifyMemberDevice, async (req, res) => {
  try {
    const memberId = req.user.memberId;
    const subscriptionId = String(req.body?.subscriptionId || '').trim();
    if (!subscriptionId) throw httpError('請提供 subscriptionId');

    const sub = await prisma.cardSubscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!sub || sub.memberId !== memberId) {
      return res.status(404).json({ status: 'error', message: '找不到訂閱' });
    }

    const mode = String(req.body?.mode || 'KEEP').toUpperCase();
    const expirePolicy = mode === 'CUT' ? 'CUT_UNUSED' : 'KEEP';

    const result = await settleCancelSubscription(subscriptionId, {
      reason: req.body?.reason || '會員自助取消訂閱',
      expirePolicy,
      doAllowance: mode === 'CUT',
    });

    res.json({
      status: 'success',
      message:
        expirePolicy === 'KEEP'
          ? '已取消續扣；效期保留至到期'
          : '已取消訂閱並結算效期',
      data: result,
    });
  } catch (error) {
    sendErr(res, error, '取消訂閱失敗');
  }
});

router.get('/subscriptions', async (req, res) => {
  try {
    const rows = await prisma.cardSubscription.findMany({
      where: { memberId: req.user.memberId },
      include: {
        promotion: { select: { id: true, name: true, usageType: true, branchId: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const repaired = await repairPlaceholderNextChargeAts(rows);
    const synced = await syncPeriodNextChargeAtsFromPayuni(repaired);
    res.json({ status: 'success', data: synced });
  } catch (error) {
    sendErr(res, error, '讀取訂閱失敗');
  }
});

/**
 * 會員自助換卡：開 PayUNi 線上續期 Hash 頁僅約定
 * POST /api/member/subscriptions/:id/rebind
 */
router.post('/subscriptions/:id/rebind', verifyMemberDevice, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const sub = await prisma.cardSubscription.findUnique({ where: { id } });
    if (!sub || sub.memberId !== req.user.memberId) {
      throw httpError('找不到訂閱', 404);
    }
    const bind = await buildSubscriptionRebindRequest(id, { channel: 'online' });
    res.json({
      status: 'success',
      message: bind.messageHint || '請完成換卡約定',
      data: bind,
    });
  } catch (error) {
    sendErr(res, error, '開換卡頁失敗');
  }
});

/**
 * GET /api/member/subscriptions/:id/rebind-status
 */
router.get('/subscriptions/:id/rebind-status', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const sub = await prisma.cardSubscription.findUnique({ where: { id } });
    if (!sub || sub.memberId !== req.user.memberId) {
      throw httpError('找不到訂閱', 404);
    }
    res.json({ status: 'success', data: toRebindStatusView(sub) });
  } catch (error) {
    sendErr(res, error, '讀取換卡狀態失敗');
  }
});

export default router;
