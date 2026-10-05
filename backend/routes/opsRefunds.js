// routes/opsRefunds.js — 儲值原單取消、子單退費、退費單後續（乙禾回填／改現金／重試／核對發票結果／中止／簽名）、折讓單資料
// 掛在 /api/ops（ops.js 之前）；不使用 router.use，避免攔截 ops.js 的公開金流回流路由
// 金額一律由後端依子單／品項重算（lib/refundService.js）；前端只送 scope／items{orderItemId,qty}／reason
// 例外：clause（第十四條免手續費）與 overrideFeeAmount（主管調降，0～契約上限）僅調整手續費，由後端驗上限
import express from 'express';
import multer from 'multer';
import { verifyStaff, requireDutyOrAbove } from '../middleware/jwtAuth.js';
import { hasDutyRankOrAbove } from '../lib/staffAccess.js';
import {
  abortRefund,
  attachYipayOriginals,
  confirmYipayRefund,
  executeSubOrderRefund,
  executeTopupCancel,
  fallbackRefundToCash,
  getRefundForStaff,
  listRefundsForStaff,
  previewSubOrderRefund,
  previewTopupCancel,
  resolveInvoiceOutcome,
  retryGateway,
  retryRefund,
} from '../lib/refundService.js';
import { MAX_SIGNATURE_BYTES, attachRefundSignature, buildSignPreview } from '../lib/refundSignature.js';
import {
  ALLOWANCE_EXPORT_COLUMNS,
  ALLOWANCE_EXPORT_FILTERS,
  allowanceExportRows,
  exportAllowancesForAccounting,
  listAllowancesForStaff,
} from '../lib/invoiceAllowance.js';
import { getAllowancePrintPayload } from '../lib/allowancePrint.js';
import { cancelPendingPayment } from '../lib/pendingPaymentCancel.js';

const router = express.Router();
const dutyOnly = [verifyStaff, requireDutyOrAbove];

/** 重試端點的職權不足必須帶回 DUTY_ROLE_REQUIRED_FOR_RETRY，畫面才會顯示警示且不登出 */
const requireRetryDuty = (req, res, next) => {
  if (!hasDutyRankOrAbove(req.user)) {
    return res.status(403).json({
      status: 'error',
      code: 'DUTY_ROLE_REQUIRED_FOR_RETRY',
      message: '僅限值班主管（DUTY+）以上權限可執行異常退費單同步重試',
    });
  }
  next();
};
const retryDuty = [verifyStaff, requireRetryDuty];

function rejectIllegalFields(res, body, allowed) {
  const illegal = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  if (!illegal.length) return false;
  res.status(400).json({
    status: 'error',
    code: 'ILLEGAL_FIELDS',
    message: allowed.length
      ? `⛔ 非法參數：只允許 ${allowed.join('、')}，已拒絕 [${illegal.join(', ')}]`
      : `⛔ 此端點不接受任何參數，已拒絕 [${illegal.join(', ')}]`,
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
          data: error.data ?? null,
        });
      }
      console.error(`${fallbackMessage}:`, error);
      res.status(500).json({ status: 'error', message: fallbackMessage, data: null });
    }
  };
}

const STATUS_MESSAGE = {
  COMPLETED: '退費完成',
  PAYMENT_PENDING: '退款處理中',
  AWAITING_TERMINAL: '請於乙禾端末執行退貨，完成後回填 RRN／授權碼／卡號末四碼',
  GATEWAY_RETRYING: '正在與金流／ezPay 同步，請勿重複點擊',
  PAYMENT_FAILED: '線上退款失敗，請重試或改臨櫃現金',
  INVOICE_PENDING: '退款完成，發票處理中',
  INVOICE_FAILED: '退款已完成，發票作廢／折讓失敗，請稍後重試（已收退款不受影響）',
  SIGNATURE_PENDING: '已開立 B2B 折讓單，須顧客簽名後結案',
  ABORTED: '退費單已中止',
};

/** 退費單回應：發票失敗回 PARTIAL_INVOICE（退款不沖回）；同 Idempotency-Key 重送回 replayed */
async function sendRefund(res, data, prefix = '') {
  await attachYipayOriginals(data);
  const code = data?.status === 'INVOICE_FAILED' ? 'PARTIAL_INVOICE' : undefined;
  const lead = data?.replayed ? `重複送出，已回傳原退費單 ${data.id}；` : prefix;
  res.json({
    status: 'success',
    ...(code ? { code } : {}),
    message: `${lead}${STATUS_MESSAGE[data?.status] || '已處理'}`,
    data,
  });
}

// ── A：計時儲值原單取消 ──────────────────────────────────────

// GET /api/ops/topups/:id/cancel-preview — 回收本金／運動金與退款管道試算（不寫入）
router.get(
  '/topups/:id/cancel-preview',
  ...dutyOnly,
  handle('試算失敗', async (req, res) => {
    const data = await previewTopupCancel(req.user, req.params.id);
    res.json({ status: 'success', message: '試算完成', data });
  }),
);

// POST /api/ops/topups/:id/cancel  Header Idempotency-Key；{ quoteToken, reason, buyerEmail? }
router.post(
  '/topups/:id/cancel',
  ...dutyOnly,
  handle('儲值取消失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['quoteToken', 'reason', 'buyerEmail'])) return;
    const { quoteToken, reason, buyerEmail } = req.body || {};
    const idempotencyKey = req.get('Idempotency-Key');
    const data = await executeTopupCancel(req.user, req.params.id, { reason, buyerEmail, quoteToken, idempotencyKey }, req);
    await sendRefund(res, data, '儲值已原單取消；');
  }),
);

// POST /api/ops/pending-payments/:id/cancel  { reason, checked }
// 待付款（乙禾／PayUNi 未完成）之 CHK／SAL／儲值單作廢；回補預扣零錢包
router.post(
  '/pending-payments/:id/cancel',
  ...dutyOnly,
  handle('作廢待付款失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['reason', 'checked'])) return;
    const data = await cancelPendingPayment(req, req.params.id, req.body || {});
    const msg = data.walletRestored > 0
      ? `已作廢 ${data.id}，回補零錢包 $${data.walletRestored}`
      : `已作廢 ${data.id}`;
    res.json({ status: 'success', message: msg, data });
  }),
);

// ── B：子單退費（SAL／TYK／CRS／私教） ──────────────────────

// GET /api/ops/sub-orders/:subOrderId/refund-preview?scope=&items=[{"orderItemId":1,"qty":1}]&clause=VOLUNTARY|EXEMPT&overrideFeeAmount=
router.get(
  '/sub-orders/:subOrderId/refund-preview',
  ...dutyOnly,
  handle('試算失敗', async (req, res) => {
    let items;
    if (req.query.items) {
      try {
        items = JSON.parse(String(req.query.items));
      } catch {
        return res.status(400).json({ status: 'error', code: 'ORDER_ITEM_INVALID', message: 'items 格式錯誤', data: null });
      }
    }
    const data = await previewSubOrderRefund(req.user, req.params.subOrderId, {
      scope: req.query.scope,
      items,
      clause: req.query.clause,
      overrideFeeAmount: req.query.overrideFeeAmount,
    });
    res.json({ status: 'success', message: '試算完成', data });
  }),
);

// POST /api/ops/sub-orders/:subOrderId/refund  Header Idempotency-Key
// { quoteToken, scope, items?, reason, buyerEmail?, clause?, overrideFeeAmount?, shortfallResolution?, shortfallNote? }
// （clause／手續費須與試算相同，否則 QUOTE_STALE；shortfallResolution＝PAID_AT_POS｜FLAG_ALERT_FOR_RECOVERY）
router.post(
  '/sub-orders/:subOrderId/refund',
  ...dutyOnly,
  handle('子單退費失敗', async (req, res) => {
    const allowed = [
      'quoteToken', 'scope', 'items', 'reason', 'buyerEmail', 'clause', 'overrideFeeAmount', 'shortfallResolution', 'shortfallNote',
    ];
    if (rejectIllegalFields(res, req.body, allowed)) return;
    const { quoteToken, scope, items, reason, buyerEmail, clause, overrideFeeAmount, shortfallResolution, shortfallNote } = req.body || {};
    if (items != null) {
      const bad =
        !Array.isArray(items) ||
        items.some((it) => !it || typeof it !== 'object' || Object.keys(it).some((k) => !['orderItemId', 'qty'].includes(k)));
      if (bad) {
        return res.status(400).json({
          status: 'error',
          code: 'ORDER_ITEM_INVALID',
          message: '⛔ items 只允許 [{ orderItemId, qty }]，禁止自帶金額',
          data: null,
        });
      }
    }
    const idempotencyKey = req.get('Idempotency-Key');
    const data = await executeSubOrderRefund(
      req.user,
      req.params.subOrderId,
      { scope, items, reason, buyerEmail, quoteToken, idempotencyKey, clause, overrideFeeAmount, shortfallResolution, shortfallNote },
      req,
    );
    await sendRefund(res, data);
  }),
);

// ── 退費單後續 ─────────────────────────────────────────────

// GET /api/ops/refunds?status=OPEN|...&branchId=&subOrderId=&memberId=&take=
router.get(
  '/refunds',
  ...dutyOnly,
  handle('讀取退費單失敗', async (req, res) => {
    const data = await attachYipayOriginals(await listRefundsForStaff(req.user, req.query));
    res.json({ status: 'success', message: `共 ${data.length} 筆`, data });
  }),
);

router.get(
  '/refunds/:id',
  ...dutyOnly,
  handle('讀取退費單失敗', async (req, res) => {
    const data = await attachYipayOriginals(await getRefundForStaff(req.user, req.params.id));
    res.json({ status: 'success', message: STATUS_MESSAGE[data.status] || '讀取成功', data });
  }),
);

// POST /api/ops/refunds/:id/retry  { checked? } — 結果不明者須先至金流／ezPay 後台確認
router.post(
  '/refunds/:id/retry',
  ...retryDuty,
  handle('重試失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['checked', 'confirmGatewayNotRefunded'])) return;
    const data = await retryRefund(req.user, req.params.id, {
      checked: req.body?.checked === true,
      confirmGatewayNotRefunded: req.body?.confirmGatewayNotRefunded === true,
    }, req);
    await sendRefund(res, data);
  }),
);

// POST /api/ops/refunds/:id/retry-gateway  { checked?, retryNote? }
// 與 /retry 同一分段檢查點；另回傳金流／發票各步是跳過、對帳補齊或實際呼叫
router.post(
  '/refunds/:id/retry-gateway',
  ...retryDuty,
  handle('重試失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['checked', 'retryNote', 'confirmGatewayNotRefunded'])) return;
    const out = await retryGateway(
      req.user,
      req.params.id,
      {
        checked: req.body?.checked === true,
        retryNote: req.body?.retryNote,
        confirmGatewayNotRefunded: req.body?.confirmGatewayNotRefunded === true,
      },
      req,
    );
    await attachYipayOriginals(out.refund);
    const code = out.refund?.status === 'INVOICE_FAILED' ? 'PARTIAL_INVOICE' : undefined;
    const message = out.reconciledAction === 'ALREADY_COMPLETED'
      ? '該筆退費單先前已完成同步，無須重複執行'
      : '異常退費單重試同步已執行';
    res.json({
      status: 'success',
      ...(code ? { code } : {}),
      message,
      data: { reconciledAction: out.reconciledAction, stepSummary: out.stepSummary, refundOrder: out.refund },
    });
  }),
);

// POST /api/ops/refunds/:id/payments/:paymentId/yipay-confirm  { rrn, authCode, cardLast4, terminalRef? }
router.post(
  '/refunds/:id/payments/:paymentId/yipay-confirm',
  ...dutyOnly,
  handle('乙禾退貨確認失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['rrn', 'authCode', 'cardLast4', 'terminalRef'])) return;
    const data = await confirmYipayRefund(req.user, req.params.id, req.params.paymentId, req.body || {}, req);
    await sendRefund(res, data, '乙禾退貨已確認；');
  }),
);

// POST /api/ops/refunds/:id/payments/:paymentId/cash-fallback  { reason, checked? }
router.post(
  '/refunds/:id/payments/:paymentId/cash-fallback',
  ...dutyOnly,
  handle('改臨櫃現金失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['reason', 'checked', 'confirmGatewayNotRefunded'])) return;
    const data = await fallbackRefundToCash(
      req.user,
      req.params.id,
      req.params.paymentId,
      { reason: req.body?.reason, confirmGatewayNotRefunded: req.body?.confirmGatewayNotRefunded === true },
      req,
    );
    await sendRefund(res, data, '已改臨櫃現金退款；');
  }),
);

// POST /api/ops/refunds/:id/invoice-resolve  { einvoiceId, outcome: 'ISSUED'|'NOT_ISSUED', allowanceNo?, reason }
// ezPay 折讓結果不明（預占保留中）：核對藍新後台後補登折讓號，或確認未開立釋放預占並重開
router.post(
  '/refunds/:id/invoice-resolve',
  ...dutyOnly,
  handle('核對發票結果失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['einvoiceId', 'outcome', 'allowanceNo', 'ezPayAllowanceNo', 'reason', 'confirmEzPayNotIssued'])) return;
    const data = await resolveInvoiceOutcome(req.user, req.params.id, {
      einvoiceId: req.body?.einvoiceId,
      outcome: req.body?.outcome,
      allowanceNo: req.body?.allowanceNo,
      ezPayAllowanceNo: req.body?.ezPayAllowanceNo,
      reason: req.body?.reason,
      confirmEzPayNotIssued: req.body?.confirmEzPayNotIssued === true,
    }, req);
    const issued = String(req.body?.outcome || '').toUpperCase() === 'ISSUED';
    await sendRefund(res, data, issued ? '已補登折讓號；' : '已確認未開立並釋放預占；');
  }),
);

// POST /api/ops/refunds/:id/abort  { reason }
router.post(
  '/refunds/:id/abort',
  ...dutyOnly,
  handle('中止退費失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['reason'])) return;
    const data = await attachYipayOriginals(await abortRefund(req.user, req.params.id, { reason: req.body?.reason }, req));
    res.json({ status: 'success', message: '退費單已中止，權益與錢包已沖回', data });
  }),
);

// POST /api/ops/refunds/:id/signature-preview — 客顯折讓預覽（後端產生金額／稅額＋previewToken＋requestId）
router.post(
  '/refunds/:id/signature-preview',
  ...dutyOnly,
  handle('產生客顯預覽失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, [])) return;
    const data = await buildSignPreview(req.user, req.params.id, req);
    res.json({ status: 'success', message: '已產生客顯簽署預覽', data });
  }),
);

const signatureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIGNATURE_BYTES, files: 1, fields: 8 },
  fileFilter(_req, file, cb) {
    if (file.fieldname === 'signature' && file.mimetype === 'image/png') cb(null, true);
    else cb(Object.assign(new Error('簽名影像須為 PNG'), { statusCode: 400, code: 'SIGNATURE_REQUIRED' }));
  },
}).single('signature');

function parseSignatureUpload(req, res, next) {
  signatureUpload(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    res.status(400).json({
      status: 'error',
      code: 'SIGNATURE_REQUIRED',
      message: tooLarge ? '簽名影像過大' : err.statusCode ? err.message : '簽名上傳格式錯誤',
      data: null,
    });
  });
}

// POST /api/ops/refunds/:id/signature  multipart：previewToken、requestId、signature（PNG Blob，客顯 SignaturePad 記憶體直傳）
router.post(
  '/refunds/:id/signature',
  ...dutyOnly,
  parseSignatureUpload,
  handle('簽名儲存失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ['previewToken', 'requestId', 'payloadHash', 'pointCount', 'strokeCount', 'pathLength'])) return;
    const data = await attachRefundSignature(
      req.user,
      req.params.id,
      {
        previewToken: req.body?.previewToken,
        requestId: req.body?.requestId,
        payloadHash: req.body?.payloadHash,
        pointCount: req.body?.pointCount,
        strokeCount: req.body?.strokeCount,
        pathLength: req.body?.pathLength,
        signature: req.file?.buffer,
      },
      req,
    );
    await sendRefund(res, data, '簽名已歸檔；');
  }),
);

// ── D：折讓單資料（純 JSON；匯出／列印由前端排版） ─────────────

// GET /api/ops/allowances?from=&to=&branchId=&allowanceNo=&invoiceNumber=&memberId=&member=&subOrderId=&refundId=&source=&q=&take=
router.get(
  '/allowances',
  ...dutyOnly,
  handle('讀取折讓單失敗', async (req, res) => {
    const items = await listAllowancesForStaff(req.user, req.query);
    res.json({
      status: 'success',
      message: `共 ${items.length} 筆`,
      data: { items, columns: ALLOWANCE_EXPORT_COLUMNS, rows: allowanceExportRows(items) },
    });
  }),
);

// POST /api/ops/allowances/export  { from, to, branchId?, allowanceNo?, invoiceNumber?, member?, subOrderId?, q? }
// 會計匯出：回傳 columns／rows（前端排版 CSV／Excel），並對首次匯出者寫入 exportedToAcctAt
router.post(
  '/allowances/export',
  ...dutyOnly,
  handle('匯出折讓單失敗', async (req, res) => {
    if (rejectIllegalFields(res, req.body, ALLOWANCE_EXPORT_FILTERS)) return;
    const data = await exportAllowancesForAccounting(req.user, req.body || {}, req);
    const { total, firstTime, marked } = data.exported;
    res.json({
      status: 'success',
      message: marked
        ? `已下載並標記 ${total} 筆（首次結轉 ${firstTime} 筆${total - firstTime ? `、先前已結轉 ${total - firstTime} 筆` : ''}）`
        : `已下載 ${total} 筆對帳檔（未標記會計匯出，可重複下載）`,
      data,
    });
  }),
);

// GET /api/ops/allowances/:id/print-payload?purpose=print|display（id＝IAL… 或折讓號；僅 print 計列印次數）
router.get(
  '/allowances/:id/print-payload',
  ...dutyOnly,
  handle('讀取折讓單失敗', async (req, res) => {
    const data = await getAllowancePrintPayload(req.user, req.params.id, req, { purpose: req.query.purpose });
    res.json({ status: 'success', message: '讀取成功', data });
  }),
);

export default router;
