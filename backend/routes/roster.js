// routes/roster.js — 場務四週變形排班（店長以上；非跨店職位限本店＋隸屬分店）
// GET  /meta · /configs · PUT /configs/:branchId
// GET  /?branchId=&date=           含 date 之 28 日週期檢視
// POST /periods { branchId, startDate }
// POST /periods/:id/generate · PUT /periods/:id/cells { staffId, date, value }
// POST /periods/:id/publish · POST /periods/:id/unpublish { reason }
import express from 'express';
import { verifyStaff, requireManagerOrAbove } from '../middleware/jwtAuth.js';
import { assertBranchAccess, isCrossBranchUser, staffBranchIds } from '../lib/staffAccess.js';
import {
  ROSTER_META,
  createRosterPeriod,
  generateRosterPeriod,
  getRosterView,
  listRosterConfigs,
  publishRosterPeriod,
  rosterPeriodBranchId,
  setRosterCell,
  unpublishRosterPeriod,
  upsertRosterConfig,
} from '../lib/rosterService.js';

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sendErr(res, error, fallback) {
  if (error.statusCode) {
    return res
      .status(error.statusCode)
      .json({ status: 'error', code: error.code || undefined, message: error.message, data: error.data });
  }
  console.error(error);
  return res.status(500).json({ status: 'error', message: fallback });
}

function parseBranchId(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) throw httpError('請提供 branchId');
  return n;
}

function scopedBranch(req, raw) {
  const branchId = parseBranchId(raw);
  assertBranchAccess(req, branchId);
  return branchId;
}

async function scopedPeriod(req) {
  const periodId = parseInt(req.params.id, 10);
  assertBranchAccess(req, await rosterPeriodBranchId(periodId));
  return periodId;
}

export const rosterRouter = express.Router();
rosterRouter.use(verifyStaff, requireManagerOrAbove);

rosterRouter.get('/meta', (_req, res) => {
  res.json({ status: 'success', data: ROSTER_META });
});

rosterRouter.get('/configs', async (req, res) => {
  try {
    const data = await listRosterConfigs(isCrossBranchUser(req.user) ? null : staffBranchIds(req.user));
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取排班設定失敗');
  }
});

rosterRouter.put('/configs/:branchId', async (req, res) => {
  try {
    const data = await upsertRosterConfig(scopedBranch(req, req.params.branchId), req.body || {});
    res.json({ status: 'success', message: '已更新排班設定', data });
  } catch (error) {
    sendErr(res, error, '更新排班設定失敗');
  }
});

rosterRouter.get('/', async (req, res) => {
  try {
    const branchId = scopedBranch(req, req.query.branchId);
    const data = await getRosterView(branchId, req.query.date ? String(req.query.date) : undefined);
    res.json({ status: 'success', data });
  } catch (error) {
    sendErr(res, error, '讀取排班失敗');
  }
});

rosterRouter.post('/periods', async (req, res) => {
  try {
    const branchId = scopedBranch(req, req.body?.branchId);
    const data = await createRosterPeriod(branchId, String(req.body?.startDate || ''), req.user.id);
    res.json({ status: 'success', message: '已建立排班期（草稿）', data });
  } catch (error) {
    sendErr(res, error, '建立排班期失敗');
  }
});

rosterRouter.post('/periods/:id/generate', async (req, res) => {
  try {
    const data = await generateRosterPeriod(await scopedPeriod(req));
    res.json({
      status: 'success',
      message: data.summary.errors ? `已自動排班，尚有 ${data.summary.errors} 項待處理` : '已自動排班，符合人力與四週變形規定',
      data,
    });
  } catch (error) {
    sendErr(res, error, '自動排班失敗');
  }
});

rosterRouter.put('/periods/:id/cells', async (req, res) => {
  try {
    const data = await setRosterCell(await scopedPeriod(req), {
      staffId: req.body?.staffId,
      date: String(req.body?.date || ''),
      value: req.body?.value ?? null,
    });
    res.json({ status: 'success', message: '已更新', data });
  } catch (error) {
    sendErr(res, error, '更新排班失敗');
  }
});

rosterRouter.post('/periods/:id/publish', async (req, res) => {
  try {
    const data = await publishRosterPeriod(await scopedPeriod(req), req.user.id);
    res.json({ status: 'success', message: '排班已發布', data });
  } catch (error) {
    sendErr(res, error, '發布排班失敗');
  }
});

rosterRouter.post('/periods/:id/unpublish', async (req, res) => {
  try {
    const data = await unpublishRosterPeriod(await scopedPeriod(req), req.user.id, req.body?.reason);
    res.json({ status: 'success', message: '已撤回發布，排班回到草稿', data });
  } catch (error) {
    sendErr(res, error, '撤回發布失敗');
  }
});

