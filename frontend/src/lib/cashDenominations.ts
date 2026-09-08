/** 台幣面額點鈔（超商式交接班） */
export const CASH_DENOMINATIONS = [1000, 500, 200, 100, 50, 10, 5, 1] as const;

export type CashDenom = (typeof CASH_DENOMINATIONS)[number];

export type DenomCounts = Record<string, number>;

export function emptyDenomCounts(): DenomCounts {
  return Object.fromEntries(CASH_DENOMINATIONS.map((d) => [String(d), 0]));
}

export function sumDenomCounts(counts: DenomCounts): number {
  let total = 0;
  for (const d of CASH_DENOMINATIONS) {
    const n = Math.max(0, Math.floor(Number(counts[String(d)]) || 0));
    total += n * d;
  }
  return total;
}

export function denomRows(counts: DenomCounts) {
  return CASH_DENOMINATIONS.map((d) => {
    const count = Math.max(0, Math.floor(Number(counts[String(d)]) || 0));
    return { denom: d, count, subtotal: count * d };
  });
}

export const CLOSE_CHECKLIST = [
  { key: 'cashCounted', label: '錢櫃現金已逐面額清點' },
  { key: 'cardSettled', label: '刷卡／乙禾 EDC 日結單已核對（筆數＋金額）' },
  { key: 'voucherChecked', label: '抵用券／禮券已清點' },
  { key: 'drawerReady', label: '錢櫃已歸位、交班單已確認' },
] as const;

export type ChecklistState = Record<string, boolean>;

export function emptyChecklist(): ChecklistState {
  return Object.fromEntries(CLOSE_CHECKLIST.map((c) => [c.key, false]));
}

export function allChecklistDone(state: ChecklistState): boolean {
  return CLOSE_CHECKLIST.every((c) => state[c.key] === true);
}
