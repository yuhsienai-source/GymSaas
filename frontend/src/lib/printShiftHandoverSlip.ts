import { denomRows, type DenomCounts } from './cashDenominations';

export type ShiftHandoverSlip = {
  shiftId: string;
  branchName: string;
  slotLabel: string;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  openedByName: string;
  closedByName?: string | null;
  operatorLabel?: string;
  openingFloat: number;
  cashIn: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
  payColumns: { label: string; amount: number }[];
  totals?: {
    checkoutCount?: number;
    checkoutAmount?: number;
    salesCount?: number;
    salesAmount?: number;
    topupCount?: number;
    topupAmount?: number;
    paidTxnCount?: number;
    paidTxnAmount?: number;
  };
  denominations?: DenomCounts | null;
  note?: string | null;
};

function money(n: number | null | undefined) {
  return `$${Math.round(Number(n) || 0).toLocaleString('zh-TW')}`;
}

function fmtDt(v?: string | null) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('zh-TW');
  } catch {
    return String(v);
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function varianceText(v: number) {
  if (v === 0) return '相符 ±0';
  if (v > 0) return `溢收 +${money(v)}`;
  return `短缺 ${money(v)}`;
}

/** 開啟新視窗列印交接班結算單（超商式） */
export function printShiftHandoverSlip(slip: ShiftHandoverSlip) {
  const w = window.open('', '_blank', 'noopener,noreferrer,width=860,height=960');
  if (!w) {
    throw new Error('無法開啟列印視窗，請允許瀏覽器彈出視窗');
  }

  const payRows = slip.payColumns
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.label)}</td><td class="num">${escapeHtml(money(c.amount))}</td></tr>`,
    )
    .join('');

  const denom = slip.denominations
    ? denomRows(slip.denominations)
        .filter((r) => r.count > 0)
        .map(
          (r) =>
            `<tr><td>$${r.denom.toLocaleString('zh-TW')}</td><td class="num">${r.count}</td><td class="num">${escapeHtml(money(r.subtotal))}</td></tr>`,
        )
        .join('')
    : '';

  const t = slip.totals || {};

  w.document.write(`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <title>交接班結算單 ${escapeHtml(slip.shiftId)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; color: #111; margin: 0; padding: 20px 24px; font-size: 13px; }
    h1 { font-size: 20px; margin: 0 0 2px; letter-spacing: 0.12em; }
    .sub { color: #555; margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; margin-bottom: 14px; }
    .grid div { border-bottom: 1px dotted #ccc; padding: 4px 0; }
    .grid b { display: inline-block; min-width: 7em; color: #444; font-weight: 600; }
    h2 { font-size: 14px; margin: 16px 0 6px; border-left: 3px solid #111; padding-left: 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #bbb; padding: 6px 8px; }
    th { background: #f3f3f3; text-align: left; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .compare { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0 4px; }
    .box { border: 1px solid #999; padding: 10px; text-align: center; }
    .box .lab { font-size: 11px; color: #555; }
    .box .val { font-size: 18px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .var { font-size: 15px; font-weight: 700; margin: 8px 0 12px; }
    .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 28px; }
    .sign .line { border-bottom: 1px solid #333; height: 36px; margin-top: 28px; }
    .foot { margin-top: 18px; color: #666; font-size: 11px; }
    @media print { body { padding: 0; } .noprint { display: none; } }
  </style>
</head>
<body>
  <h1>交接班結算單</h1>
  <div class="sub">${escapeHtml(slip.branchName)} · ${escapeHtml(slip.slotLabel)} · ${escapeHtml(slip.shiftId)}</div>
  <div class="grid">
    <div><b>開班</b>${escapeHtml(fmtDt(slip.startedAt))}</div>
    <div><b>交班</b>${escapeHtml(fmtDt(slip.endedAt))}</div>
    <div><b>開班人員</b>${escapeHtml(slip.openedByName)}</div>
    <div><b>交班人員</b>${escapeHtml(slip.closedByName || slip.operatorLabel || '—')}</div>
  </div>

  <div class="compare">
    <div class="box"><div class="lab">系統帶入（應有）</div><div class="val">${escapeHtml(money(slip.expectedCash))}</div></div>
    <div class="box"><div class="lab">現場實收（實點）</div><div class="val">${escapeHtml(money(slip.countedCash))}</div></div>
    <div class="box"><div class="lab">差額</div><div class="val">${escapeHtml(varianceText(slip.variance))}</div></div>
  </div>
  <div class="var">底金 ${escapeHtml(money(slip.openingFloat))} ＋ 班內現金 ${escapeHtml(money(slip.cashIn))} ＝ 應有 ${escapeHtml(money(slip.expectedCash))}</div>

  <h2>支付方式分欄（系統帶入）</h2>
  <table>
    <thead><tr><th>支付方式</th><th class="num">金額</th></tr></thead>
    <tbody>${payRows || '<tr><td colspan="2">—</td></tr>'}</tbody>
  </table>

  ${
    denom
      ? `<h2>現金面額點鈔明細</h2>
  <table>
    <thead><tr><th>面額</th><th class="num">張／枚</th><th class="num">小計</th></tr></thead>
    <tbody>${denom}</tbody>
  </table>`
      : ''
  }

  <h2>營業摘要</h2>
  <table>
    <tbody>
      <tr><th>合併結帳</th><td>${t.checkoutCount ?? 0} 筆／${escapeHtml(money(t.checkoutAmount))}</td></tr>
      <tr><th>銷貨</th><td>${t.salesCount ?? 0} 筆／${escapeHtml(money(t.salesAmount))}</td></tr>
      <tr><th>儲值</th><td>${t.topupCount ?? 0} 筆／${escapeHtml(money(t.topupAmount))}</td></tr>
      <tr><th>已付合計</th><td>${t.paidTxnCount ?? 0} 筆／${escapeHtml(money(t.paidTxnAmount))}</td></tr>
    </tbody>
  </table>

  ${slip.note ? `<h2>備註</h2><p>${escapeHtml(slip.note)}</p>` : ''}

  <div class="sign">
    <div>交班人員簽核<div class="line"></div></div>
    <div>接班／店長簽核<div class="line"></div></div>
  </div>
  <p class="foot">列印時間 ${escapeHtml(fmtDt(new Date().toISOString()))} · 體育客 GymSaaS 交接班結算</p>
  <p class="noprint"><button onclick="window.print()">列印</button></p>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 200); };</script>
</body>
</html>`);
  w.document.close();
}
