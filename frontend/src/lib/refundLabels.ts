/** 退費單顯示用標籤（狀態判定以後端為準） */
import type {
  RefundLookupInvoice,
  RefundMethod,
  RefundOrderKind,
  RefundPaymentStatus,
  RefundStatus,
} from '../types/api';

/** retry-gateway 的 stepSummary：只顯示後端給的步驟代碼，不自行判斷成敗 */
export const GATEWAY_PAYMENT_STEP_LABEL: Record<string, string> = {
  NOT_APPLICABLE: '此步不適用',
  SKIPPED_ALREADY_COMPLETED: '已跳過：金流先前已退成，未再打 LINE Pay／PayUNi',
  HEALED_FROM_EXISTING_TRADE_NO: '已修復：沿用既有退款序號，未再打金流',
  EXECUTED_AND_COMPLETED: '已呼叫金流並完成退刷',
};

export const GATEWAY_INVOICE_STEP_LABEL: Record<string, string> = {
  NOT_APPLICABLE: '此步不適用',
  SKIPPED_INVOICE_ALREADY_VOIDED: '已跳過：發票先前已作廢',
  SKIPPED_ALLOWANCE_ALREADY_ISSUED: '已跳過：折讓先前已開立',
  HEALED_VOID_FROM_EZPAY_REMOTE_QUERY: '遠端對帳：藍新已作廢，只同步本地',
  EXECUTED_EZPAY_VOID: '已呼叫藍新作廢發票',
  EXECUTED_EZPAY_ALLOWANCE: '已呼叫藍新開立折讓',
};

export const REFUND_STATUS_LABEL: Record<RefundStatus, string> = {
  PAYMENT_PENDING: '退款處理中',
  AWAITING_TERMINAL: '待乙禾端末退貨',
  PAYMENT_FAILED: '退款失敗',
  INVOICE_PENDING: '發票處理中',
  INVOICE_FAILED: '退款已完成｜發票待重試',
  SIGNATURE_PENDING: '待顧客簽名',
  GATEWAY_RETRYING: '正在同步金流／發票',
  COMPLETED: '已完成',
  ABORTED: '已中止',
};

export function refundStatusTone(s: RefundStatus): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (s === 'COMPLETED') return 'success';
  if (s === 'ABORTED') return 'neutral';
  if (s === 'PAYMENT_FAILED') return 'danger';
  if (s === 'AWAITING_TERMINAL' || s === 'SIGNATURE_PENDING' || s === 'INVOICE_FAILED' || s === 'GATEWAY_RETRYING') return 'warning';
  return 'info';
}

export const REFUND_METHOD_LABEL: Record<RefundMethod, string> = {
  CASH: '現金',
  WALLET_CASH: '零錢包',
  VOUCHER: '抵用券（註銷不退現）',
  LINEPAY: 'LINE Pay',
  PAYUNI: 'PayUNi 刷卡',
  YIPAY: '乙禾刷卡',
};

export const REFUND_PAYMENT_STATUS_LABEL: Record<RefundPaymentStatus, string> = {
  PENDING: '待處理',
  PROCESSING: '處理中',
  AWAITING_TERMINAL: '待端末退貨',
  REFUNDED: '已退款',
  FAILED: '失敗',
  FORFEITED: '已註銷',
  REVERSED: '已沖回',
  CANCELLED: '已改其他方式',
};

export const ORDER_KIND_LABEL: Record<RefundOrderKind, string> = {
  SALE: '商品銷售',
  TOPUP: '計時儲值',
  MEMBERSHIP: '月卡／無限使用',
  PT: '私教課程',
  GROUP: '團課報名',
  COURSE_SUB: '課程定期定額',
  OTHER: '其他',
};

export const INVOICE_ACTION_LABEL: Record<string, string> = {
  NONE: '不需處理',
  CANCEL_UNISSUED: '取消未開立發票',
  CANCEL: '取消未開立發票',
  VOID: '作廢發票',
  ALLOWANCE: '開立折讓',
};

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** 發票顯示狀態：已開立／已折讓（部分或全額）／已作廢…；僅依後端 status 與 allowanceTotal 標示，不計算稅額 */
export function invoiceDisplayStatus(inv: Pick<RefundLookupInvoice, 'status' | 'totalAmount' | 'allowanceTotal'>): {
  label: string;
  tone: Tone;
} {
  const allowed = Number(inv.allowanceTotal) || 0;
  switch (inv.status) {
    case 'ISSUED':
      if (allowed > 0 && allowed >= (Number(inv.totalAmount) || 0)) return { label: '已全額折讓', tone: 'neutral' };
      if (allowed > 0) return { label: '已部分折讓', tone: 'warning' };
      return { label: '已開立', tone: 'success' };
    case 'VOIDED':
      return { label: '已作廢', tone: 'neutral' };
    case 'CANCELLED':
      return { label: '已取消（未開立）', tone: 'neutral' };
    case 'FAILED':
      return { label: '開立失敗', tone: 'danger' };
    case 'ISSUING':
      return { label: '開立中', tone: 'info' };
    case 'PENDING':
      return { label: '待開立', tone: 'info' };
    default:
      return { label: inv.status || '—', tone: 'neutral' };
  }
}
