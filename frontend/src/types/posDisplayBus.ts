/**
 * 折讓單客顯預覽＋顧客親簽：BroadcastChannel('pos_display_bus') 事件（Discriminated Union，鍵＝type）。
 *
 * - 金額／稅額／品項只來自後端 `POST /ops/refunds/:id/signature-preview`，以 `requestId`＋`previewToken` 綁定；
 *   主機與客顯皆不得自行計算或改寫。
 * - 簽名一律以原生 `Blob`（image/png）經 BroadcastChannel 結構化複製於記憶體直傳；
 *   **禁止**轉 Base64、**禁止**寫入 localStorage／sessionStorage（本流程不走 storage 備援）。
 */

export const ALLOWANCE_BUS_VERSION = 1 as const;

export const ALLOWANCE_BUS_TYPES = {
  SIGN_REQUEST: 'ALLOWANCE_SIGN_REQUEST',
  VIEW_ACK: 'ALLOWANCE_VIEW_ACK',
  SIGN_COMPLETE: 'ALLOWANCE_SIGN_COMPLETE',
  SIGN_CANCEL: 'ALLOWANCE_SIGN_CANCEL',
  SIGN_FINALIZED: 'ALLOWANCE_SIGN_FINALIZED',
} as const;

export type AllowanceBusType = (typeof ALLOWANCE_BUS_TYPES)[keyof typeof ALLOWANCE_BUS_TYPES];

/** 單張折讓單（後端產生） */
export interface AllowanceSignDoc {
  allowanceNo: string;
  invoiceNumber: string;
  invoiceTrack: string;
  invoiceNo: string;
  invoiceDate: string | null;
  sellerName: string;
  /** B2B：買受人名稱（統編）；B2C 為 null */
  buyerLabel: string | null;
  taxTypeLabel: string;
  items: { name: string; qty: number; unit: string; amount: number; taxAmt: number }[];
  untaxed: number;
  tax: number;
  total: number;
}

/** `POST /ops/refunds/:id/signature-preview` 回傳；整包原樣推送客顯 */
export interface AllowanceSignPreview {
  requestId: string;
  previewToken: string;
  expiresAt: string;
  refundId: string;
  subOrderId: string;
  /** SAL／TYK／CRS…（子單號前綴） */
  subOrderType: string;
  branch: { name: string | null; code: string | null };
  memberName: string | null;
  signatureRequired: boolean;
  statement: string;
  docs: AllowanceSignDoc[];
  totals: { untaxed: number; tax: number; total: number };
  refund: { grossAmount: number; feeAmount: number; payoutAmount: number };
  /** 雙錢包回滾（儲值取消扣回運動金／本金、退回零錢包）；無則 null */
  wallet: { bonusReversed: number; cashReversed: number; cashCredited: number } | null;
}

interface AllowanceBusBase {
  v: typeof ALLOWANCE_BUS_VERSION;
  requestId: string;
  ts: number;
}

/** 主機 → 客顯：推送預覽 */
export interface AllowanceSignRequestMsg extends AllowanceBusBase {
  type: typeof ALLOWANCE_BUS_TYPES.SIGN_REQUEST;
  from: 'host';
  preview: AllowanceSignPreview;
}

/** 客顯 → 主機：已收到並顯示（主機 3 秒內未收到 → 提示未開啟客顯） */
export interface AllowanceViewAckMsg extends AllowanceBusBase {
  type: typeof ALLOWANCE_BUS_TYPES.VIEW_ACK;
  from: 'display';
}

/** 客顯 → 主機：顧客完成簽名（已壓浮水印之 PNG Blob） */
export interface AllowanceSignCompleteMsg extends AllowanceBusBase {
  type: typeof ALLOWANCE_BUS_TYPES.SIGN_COMPLETE;
  from: 'display';
  previewToken: string;
  signatureBlob: Blob;
  signedAt: string;
  strokePoints: number;
}

/** 任一端取消（主機撤回／顧客有疑問） */
export interface AllowanceSignCancelMsg extends AllowanceBusBase {
  type: typeof ALLOWANCE_BUS_TYPES.SIGN_CANCEL;
  from: 'host' | 'display';
  reason?: string;
}

/** 主機 → 客顯：後端歸檔結果（失敗時客顯可重送或重簽；訊息不得含敏感資料） */
export interface AllowanceSignFinalizedMsg extends AllowanceBusBase {
  type: typeof ALLOWANCE_BUS_TYPES.SIGN_FINALIZED;
  from: 'host';
  ok: boolean;
  /** 失敗是否需重新推送（預覽逾時／內容變動），客顯應停止重送 */
  restartRequired?: boolean;
  message?: string;
}

export type AllowanceBusMessage =
  | AllowanceSignRequestMsg
  | AllowanceViewAckMsg
  | AllowanceSignCompleteMsg
  | AllowanceSignCancelMsg
  | AllowanceSignFinalizedMsg;

/** 依 type 取出對應訊息型別（不含共通欄位，供 post 使用） */
export type AllowanceBusOutgoing<T extends AllowanceBusMessage = AllowanceBusMessage> = T extends AllowanceBusMessage
  ? Omit<T, 'v' | 'ts'>
  : never;

const TYPES = new Set<string>(Object.values(ALLOWANCE_BUS_TYPES));

/** 執行期守門：同頻道上其他訊息（CART／CONSENT／PING…）一律略過 */
export function isAllowanceBusMessage(x: unknown): x is AllowanceBusMessage {
  if (!x || typeof x !== 'object') return false;
  const m = x as Partial<AllowanceBusMessage>;
  if (m.v !== ALLOWANCE_BUS_VERSION || typeof m.type !== 'string' || !TYPES.has(m.type)) return false;
  if (typeof m.requestId !== 'string' || !m.requestId) return false;
  if (m.type === ALLOWANCE_BUS_TYPES.SIGN_COMPLETE) {
    const c = m as Partial<AllowanceSignCompleteMsg>;
    return c.signatureBlob instanceof Blob && typeof c.previewToken === 'string';
  }
  if (m.type === ALLOWANCE_BUS_TYPES.SIGN_REQUEST) {
    const r = m as Partial<AllowanceSignRequestMsg>;
    return !!r.preview && r.preview.requestId === m.requestId && Array.isArray(r.preview.docs);
  }
  return true;
}
