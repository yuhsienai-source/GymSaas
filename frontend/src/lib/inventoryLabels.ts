// 進銷存／電子發票顯示用標籤（狀態與金額一律以後端回傳為準）

export function money(n: number | null | undefined) {
  return `$${Math.round(Number(n) || 0).toLocaleString('zh-TW')}`;
}

export function fmtDate(v: string | null | undefined) {
  return v ? new Date(v).toLocaleDateString('zh-TW') : '—';
}

export function fmtDateTime(v: string | null | undefined) {
  return v ? new Date(v).toLocaleString('zh-TW') : '—';
}

export const TAX_TYPE_LABEL: Record<string, string> = {
  TAXABLE: '應稅 5%',
  ZERO: '零稅率',
  FREE: '免稅',
};

export const PRODUCT_KIND_LABEL: Record<string, string> = {
  PHYSICAL: '實體',
  SERVICE: '服務類',
};

export const MOVEMENT_LABEL: Record<string, string> = {
  OPENING: '期初',
  RECEIPT: '驗收入庫',
  SALE: '銷貨',
  SALE_CANCEL: '銷貨取消',
  SALE_RETURN: '銷貨退回',
  SALE_RETURN_ABORT: '退貨中止沖回',
  REFUND: '退貨',
  LOSS: '盤損',
  GAIN: '盤盈',
  STOCKTAKE: '盤點校正',
  TRANSFER_IN: '調撥入',
  TRANSFER_OUT: '調撥出',
};

export const PO_STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' }> = {
  DRAFT: { label: '草稿', tone: 'neutral' },
  ORDERED: { label: '已採購', tone: 'info' },
  PARTIAL: { label: '部分到貨', tone: 'warning' },
  RECEIVED: { label: '已到齊', tone: 'success' },
  CLOSED: { label: '短交結案', tone: 'neutral' },
  CANCELLED: { label: '已取消', tone: 'danger' },
};

export const PAYABLE_STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' }> = {
  OPEN: { label: '未付', tone: 'warning' },
  PARTIAL: { label: '部分付', tone: 'info' },
  PAID: { label: '已付清', tone: 'success' },
  VOID: { label: '作廢', tone: 'neutral' },
};

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  TRANSFER: '匯款',
  CASH: '現金',
  CHECK: '支票',
};

export const PAYMENT_TERM_LABEL: Record<string, string> = {
  NET: '進貨後 N 天',
  EOM: '月結 N 天',
  COD: '貨到付款',
};

export const EINVOICE_STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' }> = {
  PENDING: { label: '待開立', tone: 'info' },
  ISSUING: { label: '開立中', tone: 'info' },
  ISSUED: { label: '已開立', tone: 'success' },
  FAILED: { label: '開立失敗', tone: 'danger' },
  VOIDED: { label: '已作廢', tone: 'neutral' },
  CANCELLED: { label: '取消開立', tone: 'neutral' },
};

export const CARRIER_LABEL: Record<string, string> = {
  '0': '手機條碼',
  '1': '自然人憑證',
  '2': 'ezPay 載具',
};
