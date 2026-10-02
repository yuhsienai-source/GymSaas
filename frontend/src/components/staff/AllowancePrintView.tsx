import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AllowancePrintPayload } from '../../types/api';

export type AllowancePrintFormat = 'A4_FOUR_PART' | 'THERMAL_80MM';

const COPY_LABELS = [
  '第一聯：交付原銷貨人作為銷項稅額之扣減憑證',
  '第二聯：交付原銷貨人作為記帳憑證',
  '第三聯：由原買受人作為進項稅額之扣減憑證',
  '第四聯：由原買受人作為記帳憑證',
];

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

function money(n: number | null | undefined) {
  return Math.round(Number(n) || 0).toLocaleString('zh-TW');
}

function twDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
}

function SignatureNote({ p }: { p: AllowancePrintPayload }) {
  if (p.signature.signed) {
    return (
      <small>
        簽收時間 {twDate(p.signature.signedAt)}
        {p.signature.intact === false ? '（⚠ 簽名檔校驗不符）' : ''}
      </small>
    );
  }
  return p.signature.required ? <small>⚠ B2B 折讓須買受人簽收</small> : null;
}

function ReprintMark({ p }: { p: AllowancePrintPayload }) {
  if (!p.print?.isReprint) return null;
  return <div className="alw-reprint">補印（第 {p.print.count} 次列印）</div>;
}

function A4Copy({ p, label, sigUrl }: { p: AllowancePrintPayload; label: string; sigUrl: string | null }) {
  const inv = p.originalInvoice;
  return (
    <section className="alw-a4__copy">
      <header className="alw-a4__head">
        <h1>電子發票銷貨退回、進貨退出或折讓證明單</h1>
        <div className="alw-a4__label">{label}</div>
        <ReprintMark p={p} />
      </header>
      <div className="alw-a4__meta">
        <div><span>原銷貨營業人</span>{p.seller.name}（統編 {p.seller.ubn || '—'}）</div>
        <div><span>營業地址</span>{p.seller.address || p.seller.branchAddress || '—'}</div>
        <div><span>門市</span>{p.seller.branchName || '—'}{p.seller.branchCode ? `（${p.seller.branchCode}）` : ''}</div>
        <div>
          <span>原買受人</span>
          {p.buyer.category === 'B2B' ? `${p.buyer.name || '—'}（統編 ${p.buyer.ubn || '—'}）` : p.buyer.memberName || '消費者'}
        </div>
        <div><span>折讓單號</span><b className="alw-mono">{p.allowance.allowanceNo}</b></div>
        <div><span>折讓日期</span>{twDate(p.allowance.issuedAt)}</div>
      </div>
      <table className="alw-table">
        <thead>
          <tr>
            <th colSpan={3}>原開立銷貨發票</th>
            <th rowSpan={2}>品名</th>
            <th rowSpan={2}>數量</th>
            <th rowSpan={2}>單價</th>
            <th colSpan={2}>退貨或折讓內容</th>
            <th rowSpan={2}>課稅別</th>
          </tr>
          <tr>
            <th>字軌</th>
            <th>號碼</th>
            <th>日期</th>
            <th>金額（不含稅）</th>
            <th>營業稅額</th>
          </tr>
        </thead>
        <tbody>
          {p.items.map((it) => (
            <tr key={it.lineNo}>
              <td>{inv.track}</td>
              <td className="alw-mono">{inv.number}</td>
              <td>{twDate(inv.issuedAt)}</td>
              <td>{it.name}</td>
              <td className="alw-num">{it.qty}{it.unit}</td>
              <td className="alw-num">{money(it.unitPrice)}</td>
              <td className="alw-num">{money(it.amount)}</td>
              <td className="alw-num">{money(it.taxAmt)}</td>
              <td>{inv.taxTypeLabel}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={6} className="alw-num">合計（含稅 {money(p.amounts.total)}）</th>
            <td className="alw-num">{money(p.amounts.untaxed)}</td>
            <td className="alw-num">{money(p.amounts.tax)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      <div className="alw-a4__foot">
        <div className="alw-a4__reason">
          原因：{p.allowance.reason || '—'}
          {p.allowance.subOrderId ? `｜子單 ${p.allowance.subOrderId}` : ''}
          {p.allowance.refundId ? `｜退費單 ${p.allowance.refundId}` : ''}
        </div>
        <div className="alw-a4__sign">
          <div className="alw-slot">原銷貨營業人蓋章</div>
          <div className="alw-slot">
            原買受人簽收
            {sigUrl ? <img className="alw-sig" src={sigUrl} alt="買受人簽名" /> : null}
            <SignatureNote p={p} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Thermal({ p, sigUrl }: { p: AllowancePrintPayload; sigUrl: string | null }) {
  const inv = p.originalInvoice;
  return (
    <div className="alw-thermal">
      <h1>電子發票折讓證明單</h1>
      <ReprintMark p={p} />
      <div className="alw-c">{p.seller.name}</div>
      <div className="alw-c">統編 {p.seller.ubn || '—'}{p.seller.branchName ? `｜${p.seller.branchName}` : ''}</div>
      <div className="alw-hr" />
      <div className="alw-row"><span>折讓單號</span><span className="alw-mono">{p.allowance.allowanceNo}</span></div>
      <div className="alw-row"><span>折讓日期</span><span>{twDate(p.allowance.issuedAt)}</span></div>
      <div className="alw-row"><span>原發票</span><span className="alw-mono">{inv.track}-{inv.number}</span></div>
      <div className="alw-row"><span>原發票日期</span><span>{twDate(inv.issuedAt)}</span></div>
      {p.buyer.category === 'B2B' ? (
        <div className="alw-row"><span>買受人統編</span><span>{p.buyer.ubn || '—'}</span></div>
      ) : null}
      <div className="alw-hr" />
      {p.items.map((it) => (
        <div key={it.lineNo} className="alw-it">
          <div>{it.name}</div>
          <div className="alw-row"><span>{it.qty}{it.unit} × {money(it.unitPrice)}</span><span>{money(it.amount)}</span></div>
          <div className="alw-row alw-sub"><span>稅額</span><span>{money(it.taxAmt)}</span></div>
        </div>
      ))}
      <div className="alw-hr" />
      <div className="alw-row"><span>未稅合計</span><span>{money(p.amounts.untaxed)}</span></div>
      <div className="alw-row"><span>稅額合計（{inv.taxTypeLabel}）</span><span>{money(p.amounts.tax)}</span></div>
      <div className="alw-row alw-tot"><span>折讓總額</span><span>${money(p.amounts.total)}</span></div>
      <div className="alw-hr" />
      <div>原因：{p.allowance.reason || '—'}</div>
      <div style={{ marginTop: '3mm' }}>買受人簽收：</div>
      {sigUrl ? <img className="alw-sig" src={sigUrl} alt="買受人簽名" /> : <div className="alw-slot" />}
      <div className="alw-sub"><SignatureNote p={p} /></div>
    </div>
  );
}

/**
 * 折讓證明單列印：只排版後端 print-payload（禁止前端重算金額或稅額）。
 * 掛載後以 portal 置於 body，`@media print` 只印本區塊，簽名圖載入後呼叫 window.print()，列印結束 onDone 卸載。
 */
export default function AllowancePrintView({
  payload,
  format,
  onDone,
}: {
  payload: AllowancePrintPayload;
  format: AllowancePrintFormat;
  onDone: () => void;
}) {
  const rawSigUrl = payload.signature.dataUrl && PNG_DATA_URL.test(payload.signature.dataUrl) ? payload.signature.dataUrl : null;
  const [sigReady, setSigReady] = useState(!rawSigUrl);
  const [sigBroken, setSigBroken] = useState(false);
  const sigUrl = sigBroken ? null : rawSigUrl;

  useEffect(() => {
    document.body.classList.add('alw-printing');
    return () => document.body.classList.remove('alw-printing');
  }, []);

  useEffect(() => {
    if (!rawSigUrl) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive) setSigReady(true);
    };
    img.onerror = () => {
      if (!alive) return;
      setSigBroken(true);
      setSigReady(true);
    };
    img.src = rawSigUrl;
    return () => {
      alive = false;
    };
  }, [rawSigUrl]);

  useEffect(() => {
    if (!sigReady) return;
    let finished = false;
    let fallback: number | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      onDone();
    };
    window.addEventListener('afterprint', finish);
    const t = window.setTimeout(() => {
      window.print();
      fallback = window.setTimeout(finish, 1000);
    }, 60);
    return () => {
      window.clearTimeout(t);
      if (fallback) window.clearTimeout(fallback);
      window.removeEventListener('afterprint', finish);
    };
  }, [sigReady, onDone]);

  const pageRule = format === 'THERMAL_80MM' ? '@page { size: 80mm auto; margin: 3mm; }' : '@page { size: A4; margin: 8mm; }';

  return createPortal(
    <div className={`alw-print-root alw-print-root--${format === 'THERMAL_80MM' ? 'thermal' : 'a4'}`}>
      <style>{pageRule}</style>
      {format === 'THERMAL_80MM' ? (
        <Thermal p={payload} sigUrl={sigUrl} />
      ) : (
        [COPY_LABELS.slice(0, 2), COPY_LABELS.slice(2, 4)].map((pair, i) => (
          <div key={i} className="alw-a4__page">
            {pair.map((label, j) => (
              <div key={label} className="alw-a4__half">
                {j === 1 ? <div className="alw-a4__cut" /> : null}
                <A4Copy p={payload} label={label} sigUrl={sigUrl} />
              </div>
            ))}
          </div>
        ))
      )}
    </div>,
    document.body,
  );
}
