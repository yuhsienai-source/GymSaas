// routes/groupOps.js — 櫃檯團課：可售期班（POS 選購）、會員團課查詢、代登候補、退費（DUTY+）
import express from 'express';
import prisma from '../lib/prisma.js';
import { verifyStaff, requirePermission, requireDutyOrAbove } from '../middleware/jwtAuth.js';
import { assertBranchAccess, isCrossBranchUser, staffBranchIds } from '../lib/staffAccess.js';
import {
  listSellableSeries,
  getSeriesDetail,
  getMemberGroupForStaff,
  joinWaitlist,
  previewGroupRefund,
  refundGroupEnrollment,
} from '../lib/groupClassService.js';

const router = express.Router();
router.use(verifyStaff, requirePermission('ops'));

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

async function assertSeriesBranch(req, seriesId) {
  const s = await prisma.classSeries.findUnique({
    where: { id: seriesId },
    select: { venue: { select: { branchId: true } } },
  });
  if (!s) {
    const err = new Error('找不到此期班');
    err.statusCode = 404;
    throw err;
  }
  assertBranchAccess(req, s.venue.branchId);
}

async function assertEnrollmentBranch(req, enrollmentId) {
  const e = await prisma.groupEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { seriesId: true },
  });
  if (!e) {
    const err = new Error('找不到報名');
    err.statusCode = 404;
    throw err;
  }
  await assertSeriesBranch(req, e.seriesId);
}

// GET /api/ops/group/sellable?branchId=&memberId=
router.get('/sellable', async (req, res) => {
  try {
    let branchIds = null;
    if (req.query.branchId) {
      const bid = parseId(req.query.branchId, 'branchId');
      assertBranchAccess(req, bid);
      branchIds = [bid];
    } else if (!isCrossBranchUser(req.user)) {
      branchIds = staffBranchIds(req.user);
    }
    const memberId = req.query.memberId ? parseId(req.query.memberId, 'memberId') : null;
    const data = await listSellableSeries({ memberId, branchIds });
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取可售團課失敗');
  }
});

// GET /api/ops/group/series/:id?memberId=
router.get('/series/:id', async (req, res) => {
  try {
    const seriesId = parseId(req.params.id, 'seriesId');
    await assertSeriesBranch(req, seriesId);
    const memberId = req.query.memberId ? parseId(req.query.memberId, 'memberId') : null;
    res.json({ status: 'success', data: await getSeriesDetail({ seriesId, memberId }) });
  } catch (error) {
    sendErr(res, error, '讀取期班失敗');
  }
});

// GET /api/ops/group/members/:memberId
router.get('/members/:memberId', async (req, res) => {
  try {
    const data = await getMemberGroupForStaff(parseId(req.params.memberId, 'memberId'));
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取會員團課失敗');
  }
});

// POST /api/ops/group/waitlist  Body: { memberId, seriesId }
router.post('/waitlist', async (req, res) => {
  try {
    const seriesId = parseId(req.body?.seriesId, 'seriesId');
    await assertSeriesBranch(req, seriesId);
    const row = await joinWaitlist({
      memberId: parseId(req.body?.memberId, 'memberId'),
      seriesId,
      source: 'STAFF',
      staffId: req.user?.id ?? null,
    });
    res.status(201).json({ status: 'success', message: `已代登候補（第 ${row.position} 順位）`, data: row });
  } catch (error) {
    sendErr(res, error, '代登候補失敗');
  }
});

// GET /api/ops/group/enrollments/:id/refund-preview
router.get('/enrollments/:id/refund-preview', requireDutyOrAbove, async (req, res) => {
  try {
    const id = parseId(req.params.id, 'enrollmentId');
    await assertEnrollmentBranch(req, id);
    res.json({ status: 'success', data: await previewGroupRefund(id) });
  } catch (error) {
    sendErr(res, error, '退費試算失敗');
  }
});

// POST /api/ops/group/enrollments/:id/refund  Body: { reason } — 金額由後端依消保公式計算
router.post('/enrollments/:id/refund', requireDutyOrAbove, async (req, res) => {
  const { reason, ...rest } = req.body || {};
  if (Object.keys(rest).length > 0) {
    return res.status(400).json({
      status: 'error',
      message: '⛔ 非法參數：退費只接受 reason；退費金額由後端計算',
    });
  }
  try {
    const id = parseId(req.params.id, 'enrollmentId');
    await assertEnrollmentBranch(req, id);
    const r = await refundGroupEnrollment({ enrollmentId: id, staffId: req.user?.id ?? null, reason });
    const manual = r.channels.MANUAL > 0 ? `；臨櫃人工退 $${r.channels.MANUAL}` : '';
    res.json({
      status: 'success',
      message: `退費完成：應退 $${r.refundAmount}（手續費 $${r.fee}）${manual}`,
      data: r,
    });
  } catch (error) {
    sendErr(res, error, '團課退費失敗');
  }
});

export default router;
