// routes/memberGroup.js — 會員團課（付費期班）：瀏覽／報名付款／候補／請假補課；身分只認 JWT
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyMember, verifyMemberDevice } from '../middleware/jwtAuth.js';
import {
  listSellableSeries,
  getSeriesDetail,
  createEnrollmentHold,
  releaseEnrollmentHold,
  getMemberGroupOverview,
  joinWaitlist,
  cancelWaitlist,
  requestGroupLeave,
  listMakeupOptions,
  bookMakeup,
  processWaitlist,
} from '../lib/groupClassService.js';
import { requestLinePayOnlinePayment } from '../lib/linepay.js';
import { buildCardCheckoutRequest } from '../lib/payuni.js';
import { normalizeInvoiceOptions } from '../lib/ezpay.js';

const router = express.Router();
router.use(verifyMember);

function parseId(raw, label) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error(`${label} 無效`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function sendErr(res, error, fallback) {
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      status: 'error',
      ...(error.code ? { code: error.code } : {}),
      message: error.message,
    });
  }
  console.error(error);
  return res.status(500).json({ status: 'error', message: fallback });
}

// GET /api/member/group/series?branchId=
router.get('/series', async (req, res) => {
  try {
    const branchIds = req.query.branchId ? [parseId(req.query.branchId, 'branchId')] : null;
    const data = await listSellableSeries({ memberId: req.user.memberId, branchIds });
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取團課期班失敗');
  }
});

// GET /api/member/group/series/:id
router.get('/series/:id', async (req, res) => {
  try {
    const data = await getSeriesDetail({
      seriesId: parseId(req.params.id, 'seriesId'),
      memberId: req.user.memberId,
    });
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取期班失敗');
  }
});

// GET /api/member/group/me — 我的報名／候補／補課權
router.get('/me', async (req, res) => {
  try {
    const data = await getMemberGroupOverview(req.user.memberId);
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取我的團課失敗');
  }
});

// POST /api/member/group/enroll  Body: { seriesId, kind: TERM|DROP_IN, classId?, payMethod: CARD|LINEPAY, carrierNum?, buyerUbn?, loveCode? }
// 金額由後端依剩餘堂數計價；禁止 amount／memberId
router.post('/enroll', verifyMemberDevice, async (req, res) => {
  const memberId = req.user.memberId;
  const { seriesId, kind, classId, payMethod, carrierNum, buyerUbn, loveCode, ...rest } = req.body || {};
  if (Object.keys(rest).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 非法參數：團課報名只允許 seriesId、kind、classId、payMethod、carrierNum、buyerUbn、loveCode；金額由後端計價、身分只認 JWT',
    });
  }
  const method = String(payMethod || 'CARD').toUpperCase();
  if (!['CARD', 'LINEPAY'].includes(method)) {
    return res.status(400).json({ status: 'error', message: 'payMethod 僅支援 CARD（PayUNi）或 LINEPAY' });
  }
  try {
    const invoiceOpts = normalizeInvoiceOptions({ carrierNum, buyerUbn, loveCode });
    const hold = await prisma.$transaction(async (tx) => {
      const h = await createEnrollmentHold(tx, {
        memberId,
        seriesId: parseId(seriesId, 'seriesId'),
        kind,
        classId: classId != null ? parseId(classId, 'classId') : null,
        source: 'ONLINE',
        payMethod: method,
        invoiceOpts,
      });
      await tx.order.update({
        where: { id: h.orderId },
        data: {
          payBreakdown: { [method]: h.quote.price },
          cardAmount: method === 'CARD' ? h.quote.price : 0,
        },
      });
      return h;
    });

    if (method === 'LINEPAY') {
      let lp;
      try {
        lp = await requestLinePayOnlinePayment({
          orderId: hold.orderId,
          amount: hold.quote.price,
          productName: hold.itemDesc,
          client: 'member',
        });
      } catch (lpErr) {
        await prisma.$transaction((tx) => releaseEnrollmentHold(tx, hold.enrollment.id, 'CANCELLED'));
        processWaitlist(hold.enrollment.seriesId).catch(() => {});
        throw lpErr;
      }
      await prisma.order.update({
        where: { id: hold.orderId },
        data: { merchantNo: `LP:${lp.transactionId}` },
      });
      return res.json({
        status: 'success',
        message: '已保留名額，請於 30 分鐘內完成 LINE Pay 付款',
        data: {
          payMethod: 'LINEPAY',
          paymentUrl: lp.paymentUrl,
          orderId: hold.orderId,
          enrollmentId: hold.enrollment.id,
          amount: hold.quote.price,
          sessions: hold.quote.sessions,
          prorated: hold.quote.prorated,
          holdExpiresAt: hold.enrollment.holdExpiresAt,
        },
      });
    }

    const { actionUrl, payload } = buildCardCheckoutRequest({
      id: hold.orderId,
      amount: hold.quote.price,
      itemDesc: hold.itemDesc,
      cardMode: 'LUMP',
      channel: 'online',
    });
    return res.json({
      status: 'success',
      message: '已保留名額，請於 30 分鐘內完成刷卡付款',
      data: {
        payMethod: 'CARD',
        actionUrl,
        payload,
        orderId: hold.orderId,
        enrollmentId: hold.enrollment.id,
        amount: hold.quote.price,
        sessions: hold.quote.sessions,
        prorated: hold.quote.prorated,
        holdExpiresAt: hold.enrollment.holdExpiresAt,
      },
    });
  } catch (error) {
    sendErr(res, error, '團課報名失敗');
  }
});

// POST /api/member/group/waitlist  Body: { seriesId }
router.post('/waitlist', verifyMemberDevice, async (req, res) => {
  try {
    const row = await joinWaitlist({
      memberId: req.user.memberId,
      seriesId: parseId(req.body?.seriesId, 'seriesId'),
      source: 'MEMBER',
    });
    res.status(201).json({
      status: 'success',
      message: `已登記候補（第 ${row.position} 順位）；有名額時將通知您限時報名`,
      data: row,
    });
  } catch (error) {
    sendErr(res, error, '登記候補失敗');
  }
});

// POST /api/member/group/waitlist/:id/cancel
router.post('/waitlist/:id/cancel', verifyMemberDevice, async (req, res) => {
  try {
    const data = await cancelWaitlist({
      memberId: req.user.memberId,
      waitlistId: parseId(req.params.id, 'id'),
    });
    res.json({ status: 'success', message: '已取消候補', data });
  } catch (error) {
    sendErr(res, error, '取消候補失敗');
  }
});

// POST /api/member/group/reservations/:id/leave  Body: { reason? } — 開課前 ≥24h 取得補課權
router.post('/reservations/:id/leave', verifyMemberDevice, async (req, res) => {
  try {
    const data = await requestGroupLeave({
      memberId: req.user.memberId,
      reservationId: parseId(req.params.id, 'reservationId'),
      reason: req.body?.reason,
    });
    res.json({
      status: 'success',
      message:
        data.kind === 'MAKEUP_RESTORED'
          ? '已取消補課預約，補課權已退回'
          : '請假成功，已取得 1 次補課權（同課程其他期班有空位之堂次）',
      data,
    });
  } catch (error) {
    sendErr(res, error, '請假失敗');
  }
});

// GET /api/member/group/makeup-credits/:id/options
router.get('/makeup-credits/:id/options', async (req, res) => {
  try {
    const data = await listMakeupOptions({
      memberId: req.user.memberId,
      creditId: parseId(req.params.id, 'creditId'),
    });
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取補課堂次失敗');
  }
});

// POST /api/member/group/makeup  Body: { creditId, classId }
router.post('/makeup', verifyMemberDevice, async (req, res) => {
  try {
    const data = await bookMakeup({
      memberId: req.user.memberId,
      creditId: parseId(req.body?.creditId, 'creditId'),
      classId: parseId(req.body?.classId, 'classId'),
    });
    res.json({ status: 'success', message: '補課預約成功', data });
  } catch (error) {
    sendErr(res, error, '補課預約失敗');
  }
});

export default router;
