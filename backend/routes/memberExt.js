// routes/memberExt.js — 會員自助延伸（profile、課程請假、訂閱、紀錄）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyMember, verifyMemberDevice } from '../middleware/jwtAuth.js';
import { attachLeaveProof, listMemberLeaves, submitLeaveApplication, toLeaveView } from '../lib/memberLeave.js';
import { maybeLeaveProofUpload, requestHasLeaveProof, withStoredLeaveProof } from '../lib/leaveProof.js';
import { validateLeaveApplication } from '../lib/memberLeaveRules.js';
import { settleCancelSubscription } from '../lib/subscriptionSettle.js';
import { PT_FREE_LATE_LEAVES, PT_LEAVE_NOTICE_HOURS, lateLeaveChargeFor, ptUnitPrice } from '../lib/refundRules.js';
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
    return res.status(error.statusCode).json({ status: 'error', code: error.code, message: error.message });
  }
  console.error(error);
  return res.status(500).json({ status: 'error', message: fallback });
}

/** 諮詢課請假：開課前 24 小時內視為逾期；私教依契約第六條第五款（PT_LEAVE_NOTICE_HOURS）；團課請假走 /api/member/group */
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
    if (reservation.class.type === 'GROUP') {
      return res.status(409).json({
        status: 'error',
        code: 'USE_GROUP_LEAVE',
        message: '團課請假請改用 POST /api/member/group/reservations/:id/leave（開課前 24 小時取得補課權）',
      });
    }
    if (!['CONFIRMED', 'PENDING'].includes(reservation.status)) {
      throw httpError('此預約狀態不可請假');
    }

    const isPrivate = reservation.class.type === 'PRIVATE';
    const hoursUntil =
      (new Date(reservation.class.startAt) - Date.now()) / (3600 * 1000);
    const policyHours = isPrivate ? PT_LEAVE_NOTICE_HOURS : CLASS_LEAVE_POLICY_HOURS;
    const withinPolicy = hoursUntil >= policyHours;
    let compensationFee = 0;

    const row = await prisma.$transaction(async (tx) => {
      let ptContractId = null;
      compensationFee = 0;
      if (isPrivate) {
        const pt = reservation.class.ptContractId
          ? await tx.pTContract.findUnique({ where: { id: reservation.class.ptContractId } })
          : await tx.pTContract.findFirst({
              where: { memberId, isActive: true, trainerId: reservation.class.trainerId },
              orderBy: { createdAt: 'desc' },
            });
        if (pt && pt.memberId === memberId) {
          ptContractId = pt.id;
          if (!withinPolicy) {
            // 鎖合約列後計次，防並發臨時請假同時落在免收額度內
            await tx.$queryRaw`SELECT id FROM "PTContract" WHERE id = ${pt.id} FOR UPDATE`;
            const prior = await tx.classLeave.count({ where: { ptContractId: pt.id, withinPolicy: false } });
            compensationFee = lateLeaveChargeFor(prior, ptUnitPrice(pt.pricePaid, pt.totalSessions));
          }
          // 綁合約之課堂於預約時已扣堂；請假（含臨時請假）未上課，一律還堂
          if (reservation.class.ptContractId && !pt.refundedAt) {
            const restored = await tx.pTContract.updateMany({
              where: { id: pt.id, refundedAt: null, usedSessions: { gt: 0 } },
              data: { usedSessions: { decrement: 1 } },
            });
            if (restored.count && !pt.isActive && (!pt.expiresAt || pt.expiresAt > new Date())) {
              await tx.pTContract.update({ where: { id: pt.id }, data: { isActive: true } });
            }
          }
        }
      }
      const leave = await tx.classLeave.create({
        data: {
          memberId,
          reservationId,
          reason: req.body?.reason ? String(req.body.reason).slice(0, 200) : null,
          status: 'APPROVED',
          withinPolicy,
          deductedSessions: 0,
          deductedPoints: 0,
          ptContractId,
          compensationFee,
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
      : compensationFee > 0
        ? `請假已核准（臨時請假已逾每期 ${PT_FREE_LATE_LEAVES} 次免收額度，依契約記補償 $${compensationFee}，不扣堂）`
        : isPrivate
          ? `請假已核准（臨時請假，本期前 ${PT_FREE_LATE_LEAVES} 次免收補償，第 ${PT_FREE_LATE_LEAVES + 1} 次起收課程單價 20%）`
          : `請假已核准（未於開課 ${policyHours} 小時前請假）`;
    res.json({ status: 'success', message: msg, data: row });
  } catch (error) {
    sendErr(res, error, '課程請假失敗');
  }
});

// 舊版免費補課名額已停用：團課改為付費期班，補課一律走 /api/member/group（請假取得補課權）
function makeupRetired(req, res) {
  res.status(410).json({
    status: 'error',
    code: 'USE_GROUP_MAKEUP',
    message: '團課補課改為「請假取得補課權 → 同課程其他期班補課」，請至團課頁操作',
  });
}
router.get('/makeup-slots', makeupRetired);
router.post('/makeup-register', makeupRetired);

router.post('/subscription-leave', verifyMemberDevice, (_req, res) => {
  res.status(410).json({
    status: 'error',
    code: 'USE_LEAVE_APPLICATION',
    message: '會籍暫停須選擇事由並檢附證明，請改用 POST /api/member/leave-application 送審',
  });
});

/**
 * POST /api/member/leave-application（契約第十二條，送審後由門市 DUTY+ 於七工作日內審核）
 * JSON：{ category, startDate, endDate, reason?, subscriptionId?, proofImage?, proofFileName? }
 * multipart/form-data：同上欄位，proof=<file>
 * 身分只從 JWT；不收 memberId。
 */
router.post(
  '/leave-application',
  verifyMemberDevice,
  maybeLeaveProofUpload,
  async (req, res) => {
    try {
      const memberId = req.user.memberId;
      const input = {
        category: req.body?.category,
        startDate: req.body?.startDate,
        endDate: req.body?.endDate,
      };
      validateLeaveApplication({ ...input, hasProof: requestHasLeaveProof(req) });
      const leave = await withStoredLeaveProof(memberId, req, (proof) =>
        submitLeaveApplication({
          ...input,
          memberId,
          reason: req.body?.reason,
          subscriptionId: req.body?.subscriptionId ? String(req.body.subscriptionId).trim() : undefined,
          proof,
          source: 'MEMBER',
        }),
      );
      res.json({
        status: 'success',
        message: leave.proofStorageKey
          ? '已送出暫停申請，門市將於 7 個工作日內審核；核准後效期才順延'
          : '已送出暫停申請；請於 30 日內補附證明，補齊後門市於 7 個工作日內審核',
        data: toLeaveView(leave),
      });
    } catch (error) {
      sendErr(res, error, '會籍暫停申請失敗');
    }
  },
);

/** GET /api/member/leave-applications：本人暫停申請紀錄 */
router.get('/leave-applications', async (req, res) => {
  try {
    const rows = await listMemberLeaves({ memberId: req.user.memberId, take: 20 });
    res.json({ status: 'success', data: rows.map((r) => toLeaveView(r)) });
  } catch (error) {
    sendErr(res, error, '讀取暫停申請失敗');
  }
});

/** POST /api/member/leave-applications/:id/proof：傷病／疫情先送件者補附證明 */
router.post('/leave-applications/:id/proof', verifyMemberDevice, maybeLeaveProofUpload, async (req, res) => {
  try {
    const memberId = req.user.memberId;
    if (!requestHasLeaveProof(req)) throw httpError('請上傳證明檔案');
    const leave = await withStoredLeaveProof(memberId, req, (proof) =>
      attachLeaveProof({ leaveId: req.params.id, memberId, proof }),
    );
    res.json({ status: 'success', message: '已補附證明，門市將於 7 個工作日內審核', data: toLeaveView(leave) });
  } catch (error) {
    sendErr(res, error, '補附證明失敗');
  }
});

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
    // 課程分期停扣須同時解約結算（契約未繳期數），不得自助只停扣而續用堂數
    if (sub.coursePlanId) {
      return res.status(409).json({
        status: 'error',
        code: 'COURSE_SUB_COUNTER_ONLY',
        message: '課程分期付款之解約須臨櫃辦理（依契約結算已上堂數與未繳期數）',
      });
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
