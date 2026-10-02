// routes/weekPlans.js — 週班表審核：教練 → FM／該分店店長；店長／GM／FM → ADMIN（權限由 coachScheduleService 判定）
// GET  /?status=SUBMITTED|APPROVED|REJECTED|ALL&kind=COACH|MANAGER&branchId=&from=
// POST /:id/approve · /:id/reject { reason } · /:id/reopen { reason }
import express from 'express';
import { verifyStaff } from '../middleware/jwtAuth.js';
import {
  approveCoachPlan,
  canReviewAnyWeekPlan,
  listWeekPlansForReview,
  rejectCoachPlan,
  reopenCoachPlan,
} from '../lib/coachScheduleService.js';

function sendErr(res, error, fallback) {
  if (error.statusCode) {
    return res
      .status(error.statusCode)
      .json({ status: 'error', code: error.code || undefined, message: error.message, data: error.data });
  }
  console.error(error);
  return res.status(500).json({ status: 'error', message: fallback });
}

function planIdOf(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('班表 ID 無效');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

export const weekPlanReviewRouter = express.Router();
weekPlanReviewRouter.use(verifyStaff, (req, res, next) => {
  if (!canReviewAnyWeekPlan(req.user)) {
    return res.status(403).json({
      status: 'error',
      code: 'WEEK_PLAN_REVIEW_FORBIDDEN',
      message: '⛔ 週班表審核限店長、教練部主管（FM）或總公司',
    });
  }
  next();
});

weekPlanReviewRouter.get('/', async (req, res) => {
  try {
    const status = req.query.status === 'ALL' ? null : String(req.query.status || 'SUBMITTED').toUpperCase();
    const kind = req.query.kind ? String(req.query.kind).toUpperCase() : null;
    const branchId = req.query.branchId ? parseInt(req.query.branchId, 10) || null : null;
    const data = await listWeekPlansForReview(req.user, {
      status,
      kind,
      branchId,
      from: req.query.from ? String(req.query.from) : null,
    });
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取週班表失敗');
  }
});

weekPlanReviewRouter.post('/:id/approve', async (req, res) => {
  try {
    await approveCoachPlan(planIdOf(req), req.user);
    res.json({ status: 'success', message: '已核准，班表生效' });
  } catch (error) {
    sendErr(res, error, '核准週班表失敗');
  }
});

weekPlanReviewRouter.post('/:id/reject', async (req, res) => {
  try {
    await rejectCoachPlan(planIdOf(req), req.user, req.body?.reason);
    res.json({ status: 'success', message: '已退回，提報人修正後可重新送審' });
  } catch (error) {
    sendErr(res, error, '退回週班表失敗');
  }
});

weekPlanReviewRouter.post('/:id/reopen', async (req, res) => {
  try {
    await reopenCoachPlan(planIdOf(req), req.user, req.body?.reason);
    res.json({ status: 'success', message: '已撤回核准，班表回到草稿' });
  } catch (error) {
    sendErr(res, error, '撤回核准失敗');
  }
});
