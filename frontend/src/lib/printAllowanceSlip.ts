/** 電子發票銷貨折讓單列印／預覽 */
export type AllowanceSlip = {
  id?: string | null;
  allowanceNo: string;
  invoiceNumber: string;
  merchantOrderNo?: string | null;
  orderId?: string | null;
  saleOrderId?: string | null;
  memberId?: number | null;
  memberName?: string | null;
  itemDesc?: string | null;
  untaxedAmt: number;
  taxAmt: number;
  totalAmt: number;
  remainAmt?: number | null;
  buyerEmail?: string | null;
  source?: string;
  issuedAt: string;
  sellerName: string;
  sellerUbn?: string | null;
  sellerAddress?: string | null;
  merchantId?: string | null;
};

function escapeHtml(s: string) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n: number | null | undefined) {
  const v = Math.round(Number(n) || 0);
  return `$${v.toLocaleString('zh-TW')}`;
}

function fmtDateTime(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return String(iso);
  }
}

function sourceLabel(source?: string | null) {
  const s = String(source || '').toUpperCase();
  if (s === 'REFUND') return '退費折讓';
  if (s === 'CANCEL_SALE') return '取消銷貨折讓';
  if (s === 'CANCEL_PT') return '私教退費折讓';
  if (s === 'SUB_CANCEL') return '月卡取消折讓';
  if (s === 'MANUAL') return '人工折讓';
  return s || '折讓';
}

function buildAllowancePrintHtml(slip: AllowanceSlip) {
  const no = String(slip.allowanceNo || '').trim();
  const orderRef = slip.orderId || slip.saleOrderId || '—';
  const buyer =
    slip.memberName || (slip.memberId != null ? `會員 #${slip.memberId}` : '—');

  const metaRows = [
    ['折讓單據號碼', no],
    ['原發票號碼', slip.invoiceNumber || '—'],
    ['商店自訂編號', slip.merchantOrderNo || '—'],
    ['關聯訂單／銷貨單', orderRef],
    ['開立時間', fmtDateTime(slip.issuedAt)],
    ['折讓來源', sourceLabel(slip.source)],
  ];

  const partyRows = [
    ['買受人', buyer],
    ['買受人 Email', slip.buyerEmail || '—'],
    ['品名／摘要', slip.itemDesc || '—'],
  ];

  const amtRows = [
    ['銷售額（未稅）', money(slip.untaxedAmt)],
    ['營業稅額（5%）', money(slip.taxAmt)],
    ['折讓總額（含稅）', money(slip.totalAmt)],
    [
      '折讓後原發票剩餘金額',
      slip.remainAmt != null ? money(slip.remainAmt) : '—',
    ],
  ];

  const metaHtml = metaRows
    .map(
      ([k, v]) =>
        `<tr><th>${escapeHtml(k)}</th><td class="mono">${escapeHtml(String(v))}</td></tr>`,
    )
    .join('');
  const partyHtml = partyRows
    .map(
      ([k, v]) =>
        `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`,
    )
    .join('');
  const amtHtml = amtRows
    .map(
      ([k, v], idx) =>
        `<tr class="${idx === 2 ? 'is-total' : ''}"><th>${escapeHtml(k)}</th><td class="num">${escapeHtml(String(v))}</td></tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <title>電子發票銷貨折讓單 ${escapeHtml(no)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
      color: #111;
      margin: 0;
      padding: 24px 28px 36px;
      background: #fff;
      font-size: 13px;
      line-height: 1.45;
    }
    .sheet { max-width: 780px; margin: 0 auto; }
    .toolbar { margin-bottom: 16px; }
    .toolbar button {
      padding: 8px 14px;
      cursor: pointer;
      font-size: 13px;
    }
    .head {
      text-align: center;
      border-bottom: 2px solid #111;
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .head h1 {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 4px;
      letter-spacing: 0.18em;
    }
    .head .sub { color: #555; font-size: 12px; }
    .head .allowance-no {
      margin-top: 10px;
      font-size: 15px;
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0.04em;
    }
    .parties {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    .box {
      border: 1px solid #ccc;
      padding: 10px 12px;
      min-height: 108px;
    }
    .box h2 {
      font-size: 12px;
      margin: 0 0 8px;
      letter-spacing: 0.08em;
      color: #333;
      border-bottom: 1px solid #ddd;
      padding-bottom: 4px;
    }
    .box .line { margin: 3px 0; }
    .box .label { color: #666; display: inline-block; min-width: 4.5em; }
    table.info {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 14px;
    }
    table.info th,
    table.info td {
      border: 1px solid #bbb;
      padding: 7px 10px;
      vertical-align: top;
      text-align: left;
    }
    table.info th {
      width: 28%;
      background: #f4f4f4;
      font-weight: 600;
      color: #222;
    }
    table.info td.mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0.02em;
    }
    table.info td.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    table.info tr.is-total th,
    table.info tr.is-total td {
      background: #fafafa;
      font-weight: 700;
      font-size: 14px;
    }
    .section-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      margin: 4px 0 6px;
      color: #333;
    }
    .sign {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 32px;
      margin-top: 36px;
    }
    .sign .slot {
      border-top: 1px solid #888;
      padding-top: 8px;
      min-height: 56px;
      font-size: 12px;
      color: #444;
    }
    .foot {
      margin-top: 28px;
      padding-top: 12px;
      border-top: 1px dashed #ccc;
      font-size: 11px;
      color: #666;
      line-height: 1.65;
    }
    @media print {
      body { padding: 0; }
      .no-print { display: none !important; }
      .sheet { max-width: none; }
    }
    @media (max-width: 640px) {
      .parties, .sign { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="toolbar no-print">
      <button type="button" id="btn-print">列印折讓單</button>
    </div>

    <header class="head">
      <h1>電子發票銷貨折讓單</h1>
      <div class="sub">Electronic Invoice Sales Allowance</div>
      <div class="allowance-no">折讓單據號碼：${escapeHtml(no || '—')}</div>
    </header>

    <div class="parties">
      <div class="box">
        <h2>營業人（開立方）</h2>
        <div class="line"><span class="label">名稱</span>${escapeHtml(slip.sellerName || '—')}</div>
        <div class="line"><span class="label">統編</span>${escapeHtml(slip.sellerUbn || '—')}</div>
        <div class="line"><span class="label">地址</span>${escapeHtml(slip.sellerAddress || '—')}</div>
        <div class="line"><span class="label">商店代號</span>${escapeHtml(slip.merchantId || '—')}</div>
      </div>
      <div class="box">
        <h2>買受人</h2>
        <div class="line"><span class="label">名稱</span>${escapeHtml(buyer)}</div>
        <div class="line"><span class="label">Email</span>${escapeHtml(slip.buyerEmail || '—')}</div>
        <div class="line"><span class="label">會員編號</span>${escapeHtml(
          slip.memberId != null ? String(slip.memberId) : '—',
        )}</div>
      </div>
    </div>

    <div class="section-title">一、單據資訊</div>
    <table class="info">${metaHtml}</table>

    <div class="section-title">二、交易摘要</div>
    <table class="info">${partyHtml}</table>

    <div class="section-title">三、折讓金額（含稅總額反推稅額，稅率 5%）</div>
    <table class="info">${amtHtml}</table>

    <div class="sign">
      <div class="slot">營業人簽章／日期</div>
      <div class="slot">買受人簽章／日期</div>
    </div>

    <div class="foot">
      說明：本單依 ezPay 電子發票折讓開立結果產製，供櫃檯存查與交付買受人。<br />
      折讓總額為含稅金額；未稅額／稅額依含稅總額以稅率 5% 反推。<br />
      正式申報、證明聯與申報狀態以財政部電子發票整合服務平台／ezPay 商家後台資料為準。
    </div>
  </div>
  <script>
    (function () {
      var btn = document.getElementById('btn-print');
      if (btn) btn.addEventListener('click', function () { window.print(); });
      function triggerPrint() {
        setTimeout(function () { window.focus(); window.print(); }, 300);
      }
      if (document.readyState === 'complete') triggerPrint();
      else window.addEventListener('load', triggerPrint);
    })();
  </script>
</body>
</html>`;
}

/**
 * 開啟新視窗列印專業電子發票銷貨折讓單
 * 使用 Blob URL，避免 about:blank + document.write 造成空白頁
 */
export function printAllowanceSlip(slip: AllowanceSlip) {
  const no = String(slip?.allowanceNo || '').trim();
  if (!no) {
    throw new Error('缺少折讓單據號碼，無法列印');
  }

  const html = buildAllowancePrintHtml(slip);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank', 'width=860,height=980');
  if (!w) {
    URL.revokeObjectURL(url);
    throw new Error('無法開啟列印視窗，請允許瀏覽器彈出視窗');
  }

  const revoke = () => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  };
  w.addEventListener?.('load', () => setTimeout(revoke, 60_000));
  setTimeout(revoke, 120_000);
}
