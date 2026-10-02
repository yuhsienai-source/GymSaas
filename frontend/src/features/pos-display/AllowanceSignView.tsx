import { useEffect, useRef, useState } from 'react';
import SignaturePad, { type SignaturePadHandle } from '../../components/staff/SignaturePad';
import { openAllowanceSignChannel, type AllowanceSignChannel } from '../../lib/allowanceSignChannel';
import { ALLOWANCE_BUS_TYPES, type AllowanceSignRequestMsg } from '../../types/posDisplayBus';
import { allowanceWatermarkText, watermarkSignature } from './signatureWatermark';

/** 筆跡點數下限（防空白／誤觸送出；後端另以筆跡像素把關） */
const MIN_STROKE_POINTS = 20;
/** 送出後等主機歸檔結果；逾時可重送同一張已壓印簽名 */
const FINALIZE_TIMEOUT_MS = 20000;
const DONE_DISMISS_MS = 2500;

type Phase = 'review' | 'sending' | 'awaiting' | 'done' | 'failed' | 'timeout';

const SUB_ORDER_LABEL: Record<string, string> = {
  SAL: '商品銷售',
  TYK: '會籍／儲值方案',
  CRS: '月卡訂閱',
};

function money(n: number) {
  return `$${Math.round(Number(n) || 0).toLocaleString('zh-TW')}`;
}

function twDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * 客顯折讓簽署視圖：收到 ALLOWANCE_SIGN_REQUEST 立即回 ALLOWANCE_VIEW_ACK，全螢幕覆蓋顯示後端預覽，
 * 顧客勾選確認後親簽 → 記憶體 Canvas 壓浮水印 → PNG Blob 經 BroadcastChannel 回主機。無請求時不渲染。
 */
export default function AllowanceSignView() {
  const channelRef = useRef<AllowanceSignChannel | null>(null);
  const requestRef = useRef<AllowanceSignRequestMsg | null>(null);
  const [request, setRequest] = useState<AllowanceSignRequestMsg | null>(null);
  const [phase, setPhase] = useState<Phase>('review');
  const [confirmed, setConfirmed] = useState(false);
  const [points, setPoints] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const [failMessage, setFailMessage] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [padKey, setPadKey] = useState(0);
  const [hasSigned, setHasSigned] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const padRef = useRef<SignaturePadHandle>(null);
  const submitLockRef = useRef(false);
  const lastSignedRef = useRef<{ blob: Blob; signedAt: string; points: number } | null>(null);
  const finalizeTimerRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = (ref: { current: number | null }) => {
      if (ref.current != null) window.clearTimeout(ref.current);
      ref.current = null;
    };
    const resetSigning = () => {
      clearTimer(finalizeTimerRef);
      submitLockRef.current = false;
      lastSignedRef.current = null;
      setHasSigned(false);
      setPhase('review');
      setConfirmed(false);
      setPoints(0);
      setHint(null);
      setFailMessage(null);
      setRestartRequired(false);
      setPadKey((k) => k + 1);
    };
    const dismiss = () => {
      clearTimer(dismissTimerRef);
      resetSigning();
      requestRef.current = null;
      setRequest(null);
    };

    const ch = openAllowanceSignChannel('display');
    channelRef.current = ch;
    const unsub = ch.subscribe((msg) => {
      if (msg.type === ALLOWANCE_BUS_TYPES.SIGN_REQUEST) {
        clearTimer(dismissTimerRef);
        resetSigning();
        requestRef.current = msg;
        setRequest(msg);
        setNow(Date.now());
        ch.post({ type: ALLOWANCE_BUS_TYPES.VIEW_ACK, from: 'display', requestId: msg.requestId });
        return;
      }
      if (msg.requestId !== requestRef.current?.requestId) return;
      if (msg.type === ALLOWANCE_BUS_TYPES.SIGN_CANCEL) {
        dismiss();
        return;
      }
      if (msg.type === ALLOWANCE_BUS_TYPES.SIGN_FINALIZED) {
        clearTimer(finalizeTimerRef);
        submitLockRef.current = false;
        if (msg.ok) {
          lastSignedRef.current = null;
          setHasSigned(false);
          setPhase('done');
          dismissTimerRef.current = window.setTimeout(dismiss, DONE_DISMISS_MS);
        } else {
          setPhase('failed');
          setFailMessage(msg.message || '櫃檯未能完成歸檔');
          setRestartRequired(Boolean(msg.restartRequired));
        }
      }
    });

    return () => {
      clearTimer(finalizeTimerRef);
      clearTimer(dismissTimerRef);
      unsub();
      ch.close();
      channelRef.current = null;
      lastSignedRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [request]);

  if (!request) return null;
  const preview = request.preview;
  const expired = Date.parse(preview.expiresAt) <= now;
  const branchLabel = preview.branch.name || preview.branch.code || '';
  const busy = phase === 'sending' || phase === 'awaiting' || phase === 'done';
  const canSign = confirmed && !expired && !busy && !(phase === 'failed' && restartRequired);

  function sendComplete() {
    const req = requestRef.current;
    const signed = lastSignedRef.current;
    const ch = channelRef.current;
    if (!req || !signed || !ch) {
      submitLockRef.current = false;
      return;
    }
    const sent = ch.post({
      type: ALLOWANCE_BUS_TYPES.SIGN_COMPLETE,
      from: 'display',
      requestId: req.requestId,
      previewToken: req.preview.previewToken,
      signatureBlob: signed.blob,
      signedAt: signed.signedAt,
      strokePoints: signed.points,
    });
    if (!sent) {
      submitLockRef.current = false;
      setPhase('failed');
      setFailMessage('客顯與櫃檯通道中斷，請告知櫃檯重新開啟客顯');
      return;
    }
    setPhase('awaiting');
    if (finalizeTimerRef.current != null) window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = window.setTimeout(() => {
      finalizeTimerRef.current = null;
      submitLockRef.current = false;
      setPhase('timeout');
    }, FINALIZE_TIMEOUT_MS);
  }

  async function submit() {
    if (submitLockRef.current || !canSign) return;
    const canvas = padRef.current?.getCanvas();
    const pts = padRef.current?.pointCount() ?? 0;
    if (!canvas || pts < MIN_STROKE_POINTS) {
      setHint('簽名過短或空白，請以正楷或慣用簽名完整簽署');
      return;
    }
    submitLockRef.current = true;
    setHint(null);
    setFailMessage(null);
    setPhase('sending');
    try {
      const signedAt = new Date();
      const blob = await watermarkSignature(canvas, allowanceWatermarkText(branchLabel, signedAt));
      lastSignedRef.current = { blob, signedAt: signedAt.toISOString(), points: pts };
      setHasSigned(true);
      sendComplete();
    } catch {
      submitLockRef.current = false;
      setPhase('failed');
      setFailMessage('簽名影像產生失敗，請清除後重簽');
    }
  }

  function resend() {
    if (submitLockRef.current || !lastSignedRef.current || expired) return;
    submitLockRef.current = true;
    setFailMessage(null);
    setPhase('sending');
    sendComplete();
  }

  function resign() {
    if (submitLockRef.current) return;
    lastSignedRef.current = null;
    setHasSigned(false);
    padRef.current?.clear();
    setPadKey((k) => k + 1);
    setPoints(0);
    setHint(null);
    setFailMessage(null);
    setPhase('review');
  }

  function askStaff() {
    const req = requestRef.current;
    if (!req || submitLockRef.current) return;
    channelRef.current?.post({
      type: ALLOWANCE_BUS_TYPES.SIGN_CANCEL,
      from: 'display',
      requestId: req.requestId,
      reason: 'CUSTOMER_QUESTION',
    });
    lastSignedRef.current = null;
    requestRef.current = null;
    setRequest(null);
  }

  return (
    <div className="asv" role="dialog" aria-modal="true" aria-labelledby="asv-title">
      <header className="asv__bar">
        <h1 id="asv-title">電子發票折讓證明單｜買受人確認簽收</h1>
        <span>{branchLabel || '—'}</span>
      </header>

      <div className="asv__body">
        <section className="asv__detail" aria-label="折讓明細">
          <div className="asv__meta">
            <span className="asv__tag">{preview.subOrderType}</span>
            <span>
              子單 <b className="asv__mono">{preview.subOrderId}</b>
              {SUB_ORDER_LABEL[preview.subOrderType] ? `（${SUB_ORDER_LABEL[preview.subOrderType]}）` : ''}
            </span>
            <span>退費單 <b className="asv__mono">{preview.refundId}</b></span>
            {preview.memberName ? <span>會員 {preview.memberName}</span> : null}
          </div>

          {preview.docs.map((d) => (
            <article key={d.allowanceNo} className="asv__doc">
              <div className="asv__inv">
                <div>
                  <small>原發票號碼</small>
                  <strong className="asv__mono">{d.invoiceTrack}-{d.invoiceNo}</strong>
                </div>
                <div>
                  <small>開立日期</small>
                  <span>{twDate(d.invoiceDate)}</span>
                </div>
                <div>
                  <small>折讓單號</small>
                  <span className="asv__mono">{d.allowanceNo}</span>
                </div>
              </div>
              <div className="asv__sub">
                {d.sellerName}
                {d.buyerLabel ? `｜買受人 ${d.buyerLabel}` : ''}｜{d.taxTypeLabel}
              </div>
              <table className="asv__items">
                <thead>
                  <tr>
                    <th>品名</th>
                    <th className="num">數量</th>
                    <th className="num">未稅金額</th>
                    <th className="num">稅額</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((it, i) => (
                    <tr key={`${it.name}-${i}`}>
                      <td>{it.name}</td>
                      <td className="num">{it.qty}{it.unit}</td>
                      <td className="num">{money(it.amount)}</td>
                      <td className="num">{money(it.taxAmt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="asv__doc-total">
                <span>未稅 {money(d.untaxed)}｜稅額 {money(d.tax)}</span>
                <span>折讓金額 <b>{money(d.total)}</b></span>
              </div>
            </article>
          ))}

          <dl className="asv__sum">
            <div><dt>折讓未稅合計</dt><dd>{money(preview.totals.untaxed)}</dd></div>
            <div><dt>折讓稅額合計</dt><dd>{money(preview.totals.tax)}</dd></div>
            <div><dt>折讓總額（含稅）</dt><dd>{money(preview.totals.total)}</dd></div>
            {preview.refund.feeAmount > 0 ? (
              <div><dt>違約手續費／已使用扣除</dt><dd>−{money(preview.refund.feeAmount)}</dd></div>
            ) : null}
            {preview.wallet?.bonusReversed ? (
              <div><dt>扣回贈送運動金（SC）</dt><dd>−{money(preview.wallet.bonusReversed)}</dd></div>
            ) : null}
            {preview.wallet?.cashReversed ? (
              <div><dt>扣回儲值本金</dt><dd>−{money(preview.wallet.cashReversed)}</dd></div>
            ) : null}
            {preview.wallet?.cashCredited ? (
              <div><dt>退回零錢包</dt><dd>+{money(preview.wallet.cashCredited)}</dd></div>
            ) : null}
          </dl>
          <div className="asv__payout">
            <span>應退總額</span>
            <strong>{money(preview.refund.payoutAmount)}</strong>
          </div>
        </section>

        <section className="asv__sign" aria-label="簽名">
          <p className="asv__statement">{preview.statement}</p>
          <label className="asv__check">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || expired}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>我已核對原發票號碼與折讓金額無誤</span>
          </label>
          <div className={`asv__pad${canSign ? '' : ' is-locked'}`}>
            <SignaturePad
              key={`${request.requestId}-${padKey}`}
              padRef={padRef}
              hideClear
              height={240}
              disabled={!canSign}
              onStrokeChange={setPoints}
            />
          </div>
          {expired ? (
            <p className="asv__alert" role="alert">簽署時效已過，請告知櫃檯重新推送。</p>
          ) : phase === 'awaiting' || phase === 'sending' ? (
            <p className="asv__status">已送出，櫃檯歸檔中，請稍候…</p>
          ) : phase === 'done' ? (
            <p className="asv__status is-ok">已完成簽收，謝謝您！</p>
          ) : phase === 'timeout' ? (
            <p className="asv__alert" role="alert">尚未收到櫃檯回覆，可再送一次；若仍失敗請告知櫃檯。</p>
          ) : phase === 'failed' ? (
            <p className="asv__alert" role="alert">
              {failMessage}
              {restartRequired ? '（請告知櫃檯重新推送）' : ''}
            </p>
          ) : hint ? (
            <p className="asv__alert" role="alert">{hint}</p>
          ) : (
            <p className="asv__hint">
              {confirmed ? '請於上方框內親簽' : '請先勾選確認，再於框內簽名'}
            </p>
          )}

          <div className="asv__actions">
            {(phase === 'timeout' || (phase === 'failed' && !restartRequired)) && hasSigned ? (
              <button type="button" className="asv-btn asv-btn--primary" onClick={resend} disabled={expired}>
                再送一次
              </button>
            ) : (
              <button
                type="button"
                className="asv-btn asv-btn--primary"
                onClick={() => void submit()}
                disabled={!canSign || points < MIN_STROKE_POINTS}
              >
                {phase === 'sending' || phase === 'awaiting' ? '送出中…' : '確認簽署並送回櫃檯'}
              </button>
            )}
            <button type="button" className="asv-btn" onClick={resign} disabled={busy || expired}>
              清除重簽
            </button>
            <button type="button" className="asv-btn asv-btn--ghost" onClick={askStaff} disabled={busy}>
              有疑問，請櫃檯協助
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
