// routes/payroll.js — 總部薪資系統 /api/hq/payroll（限 ADMIN；金額一律後端計算）
// GET/PUT  /config                               費率設定
// GET      /profiles · PUT/DELETE /profiles/:staffId  員工薪資設定
// GET/POST /runs { month } · GET/DELETE /runs/:id
// POST     /runs/:id/recalculate · /finalize · /reopen { reason }
// PUT      /runs/:id/overtime { mode }               整批未核定加班依建議／不計
// PUT      /runs/:id/items/:itemId/overtime { decisions?, mode? }
// POST     /runs/:id/items/:itemId/adjustments · DELETE …/adjustments/:adjId
import express from 'express';
import { verifyStaff, requireAdmin } from '../middleware/jwtAuth.js';
import {
  addAdjustment,
  createPayrollRun,
  decideOvertime,
  decideRunOvertime,
  deletePayProfile,
  deletePayrollRun,
  finalizePayrollRun,
  getPayrollConfig,
  getPayrollRun,
  listPayProfiles,
  listPayrollRuns,
  recalculatePayrollRun,
  removeAdjustment,
  reopenPayrollRun,
  updatePayrollConfig,
  upsertPayProfile,
} from '../lib/payrollService.js';

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function parseId(value, field = 'id') {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${field} 無效`);
  return n;
}

function actorId(req) {
  const n = parseInt(req.user?.staffId ?? req.user?.id, 10);
  if (!Number.isInteger(n) || n <= 0) throw httpError('⛔ 憑證缺少員工 id', 403);
  return n;
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

/** @param {(req: import('express').Request) => Promise<unknown>} fn */
function handle(message, fallback, fn) {
  return async (req, res) => {
    try {
      res.json({ status: 'success', message, data: await fn(req) });
    } catch (error) {
      sendErr(res, error, fallback);
    }
  };
}

export const payrollAdminRouter = express.Router();
payrollAdminRouter.use(verifyStaff, requireAdmin);

payrollAdminRouter.get('/config', handle('薪資費率', '讀取費率失敗', () => getPayrollConfig()));
payrollAdminRouter.put('/config', handle('已更新費率', '更新費率失敗', (req) => updatePayrollConfig(req.body, actorId(req))));

payrollAdminRouter.get('/profiles', handle('員工薪資設定', '讀取薪資設定失敗', () => listPayProfiles()));
payrollAdminRouter.put(
  '/profiles/:staffId',
  handle('已儲存薪資設定', '儲存薪資設定失敗', (req) => upsertPayProfile(parseId(req.params.staffId, 'staffId'), req.body, actorId(req))),
);
payrollAdminRouter.delete(
  '/profiles/:staffId',
  handle('已刪除薪資設定', '刪除薪資設定失敗', (req) => deletePayProfile(parseId(req.params.staffId, 'staffId'))),
);

payrollAdminRouter.get('/runs', handle('薪資批次', '讀取薪資批次失敗', () => listPayrollRuns()));
payrollAdminRouter.post(
  '/runs',
  handle('已建立薪資批次', '建立薪資批次失敗', (req) => createPayrollRun(String(req.body?.month || ''), actorId(req))),
);
payrollAdminRouter.get('/runs/:id', handle('薪資批次', '讀取薪資批次失敗', (req) => getPayrollRun(parseId(req.params.id))));
payrollAdminRouter.delete('/runs/:id', handle('已刪除薪資批次', '刪除薪資批次失敗', (req) => deletePayrollRun(parseId(req.params.id))));
payrollAdminRouter.post(
  '/runs/:id/recalculate',
  handle('已重新計算', '重新計算失敗', (req) => recalculatePayrollRun(parseId(req.params.id), actorId(req))),
);
payrollAdminRouter.post(
  '/runs/:id/finalize',
  handle('已結算並通知員工', '結算失敗', (req) => finalizePayrollRun(parseId(req.params.id), actorId(req))),
);
payrollAdminRouter.post(
  '/runs/:id/reopen',
  handle('已撤銷結算', '撤銷結算失敗', (req) => reopenPayrollRun(parseId(req.params.id), req.body?.reason, actorId(req))),
);
payrollAdminRouter.put(
  '/runs/:id/overtime',
  handle('已核定加班', '核定加班失敗', (req) => decideRunOvertime(parseId(req.params.id), req.body?.mode, actorId(req))),
);
payrollAdminRouter.put(
  '/runs/:id/items/:itemId/overtime',
  handle('已核定加班', '核定加班失敗', (req) =>
    decideOvertime(parseId(req.params.id), parseId(req.params.itemId, 'itemId'), req.body, actorId(req)),
  ),
);
payrollAdminRouter.post(
  '/runs/:id/items/:itemId/adjustments',
  handle('已新增手動項', '新增手動項失敗', (req) =>
    addAdjustment(parseId(req.params.id), parseId(req.params.itemId, 'itemId'), req.body, actorId(req)),
  ),
);
payrollAdminRouter.delete(
  '/runs/:id/items/:itemId/adjustments/:adjId',
  handle('已刪除手動項', '刪除手動項失敗', (req) =>
    removeAdjustment(parseId(req.params.id), parseId(req.params.itemId, 'itemId'), String(req.params.adjId)),
  ),
);
