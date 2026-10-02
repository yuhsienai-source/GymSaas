// routes/opsTransactions.js — 櫃檯交易異動：退費查詢、取消進出場；舊退費端點已移除（410）
// 掛在 /api/ops（ops.js 之前）；不使用 router.use，避免攔截 ops.js 的公開金流回流路由
// 退費／折讓一律走 routes/opsRefunds.js（lib/refundService.js）
import express from 'express';
import { verifyStaff, requirePermission, requireDutyOrAbove } from '../middleware/jwtAuth.js';
import { cancelGateLog, lookupRefundOrder } from '../lib/transactionChanges.js';

const router = express.Router();
const dutyOnly = [verifyStaff, requireDutyOrAbove];

function rejectIllegalFields(res, body, allowed) {
  const illegal = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  if (!illegal.length) return false;
  res.status(400).json({
    status: 'error',
    message: `⛔ 非法參數：只允許 ${allowed.join('、')}，已拒絕 [${illegal.join(', ')}]`,
  });
  return true;
}

function handle(fallbackMessage, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({
          status: 'error',
          ...(error.code ? { code: error.code } : {}),
          message: error.message,
        });
      }
      console.error(`${fallbackMessage}:`, error);
      res.status(500).json({ status: 'error', message: fallbackMessage });
    }
  };
}

function gone(code, message) {
  return (_req, res) => res.status(410).json({ status: 'error', code, message, data: null });
}

router.post('/refund', gone('USE_TOPUP_CANCEL', '此端點已停用：儲值取消請改用 POST /api/ops/topups/:id/cancel'));
router.post('/cancel-sale', gone('USE_SUB_ORDER_REFUND', '此端點已停用：請改用 POST /api/ops/sub-orders/:subOrderId/refund'));
router.post('/cancel-pt-purchase', gone('USE_SUB_ORDER_REFUND', '此端點已停用：請改用 POST /api/ops/sub-orders/:subOrderId/refund'));
router.get('/allowances/:allowanceNo', gone('USE_PRINT_PAYLOAD', '此端點已停用：請改用 GET /api/ops/allowances/:id/print-payload'));

// GET /api/ops/refund-lookup?invoiceNumber=&orderId=
router.get(
  '/refund-lookup',
  ...dutyOnly,
  handle('查詢失敗', async (req, res) => {
    const data = await lookupRefundOrder({
      user: req.user,
      orderId: req.query.orderId,
      invoiceNumber: req.query.invoiceNumber,
    });
    res.json({ status: 'success', message: '查詢成功', data });
  }),
);

// POST /api/ops/cancel-gate  { logId, reason? }
// 在場取消開放櫃檯模組；已出場退費於 service 內要求 DUTY+
router.post(
  '/cancel-gate',
  verifyStaff,
  requirePermission('ops'),
  handle('取消進出場失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['logId', 'reason'])) return;
    const { logId, reason } = req.body || {};
    const { message, data } = await cancelGateLog({ user: req.user, logId, reason });
    res.json({ status: 'success', message, data });
  }),
);

export default router;
