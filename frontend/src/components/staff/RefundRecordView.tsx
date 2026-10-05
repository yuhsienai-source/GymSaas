import { type FormEvent, useCallback, useRef, useState } from 'react';
import { Alert, Badge, Button, Field, Input, Modal } from '../ui';
import ReasonModal from './ReasonModal';
import RefundErrorAlert from './RefundErrorAlert';
import AllowancePrintView, { type AllowancePrintFormat } from './AllowancePrintView';
import { useToast } from '../../contexts/ToastContext';
import {
  abortRefund,
  confirmYipayRefund,
  fallbackRefundToCash,
  fetchRefund,
  resolveRefundInvoice,
  retryRefundGateway,
} from '../../lib/api';
import { usePosDisplayHost } from '../../lib/usePosDisplayHost';
import { useAllowancePrint } from '../../lib/useAllowancePrint';
import { DISPLAY_ACK_TIMEOUT_MS, usePosAllowanceBus } from '../../features/pos/hooks/usePosAllowanceBus';
import { DISPLAY_PROBE_BLOCKED, probeCustomerDisplay } from '../../lib/customerDisplayProbe';
import { describeRefundError, type RefundErrorInfo } from '../../lib/refundErrors';
import {
  GATEWAY_INVOICE_STEP_LABEL,
  GATEWAY_PAYMENT_STEP_LABEL,
  INVOICE_ACTION_LABEL,
  REFUND_METHOD_LABEL,
  REFUND_PAYMENT_STATUS_LABEL,
  REFUND_STATUS_LABEL,
  refundStatusTone,
} from '../../lib/refundLabels';
import type {
  ApiResponse,
  RefundGatewayRetryData,
  RefundInvoiceResolve,
  RefundInvoiceResolveBody,
  RefundPaymentRecord,
  RefundRecord,
} from '../../types/api';

const RETRYABLE = ['PAYMENT_PENDING', 'PAYMENT_FAILED', 'INVOICE_PENDING', 'INVOICE_FAILED', 'SIGNATURE_PENDING', 'GATEWAY_RETRYING'];
const AMBIGUOUS_TAG = '[待確認]';

/** 無線上退款序號、且前次結果不明：必須先勾確認才可重打金流 */
function paymentNeedsGatewayConfirm(refund: RefundRecord) {
  return refund.payments.some(
    (p) =>
      (p.method === 'LINEPAY' || p.method === 'PAYUNI') &&
      !p.providerRef &&
      (p.status === 'PROCESSING' || (p.status === 'FAILED' && String(p.lastError || '').startsWith(AMBIGUOUS_TAG))),
  );
}

function money(n: number) {
  return `$${Math.round(Number(n) || 0).toLocaleString('zh-TW')}`;
}

function fmtTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

type YipayDraft = { rrn: string; authCode: string; cardLast4: string; terminalRef: string };
const EMPTY_YIPAY: YipayDraft = { rrn: '', authCode: '', cardLast4: '', terminalRef: '' };

/** 乙禾端末退刷：步驟引導＋原交易憑證核對＋回填（只送憑證，不送金額） */
function YipayRefundForm({
  payment,
  busy,
  onSubmit,
  onCancel,
}: {
  payment: RefundPaymentRecord;
  busy: boolean;
  onSubmit: (d: YipayDraft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<YipayDraft>(EMPTY_YIPAY);
  const orig = payment.original;
  const cardMismatch = Boolean(orig?.cardLast4 && d.cardLast4.length === 4 && d.cardLast4 !== orig.cardLast4);
  const valid = /^[0-9A-Za-z]{6,12}$/.test(d.rrn) && /^[0-9A-Z]{6}$/.test(d.authCode) && /^\d{4}$/.test(d.cardLast4);

  return (
    <div className="card card--default card--pad-md form-stack">
      <strong>乙禾 EDC 端末退刷 {money(payment.amount)}</strong>
      <ol className="text-sm" style={{ margin: 0, paddingLeft: '1.3em' }}>
        <li>於乙禾端末機選擇「退貨／取消」，輸入退款金額 <strong>{money(payment.amount)}</strong>。</li>
        <li>請顧客以<strong>原刷卡片</strong>感應／插卡（末四碼須與原交易相同）。</li>
        <li>端末列印退貨簽單後，依簽單回填下方 RRN、授權碼與卡號末四碼。</li>
      </ol>
      {orig ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>原交易核對</th><th>RRN</th><th>授權碼</th><th>卡號末四碼</th><th>金額</th><th>刷卡時間</th></tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-sm">原刷卡</td>
                <td className="mono">{orig.rrn || '—'}</td>
                <td className="mono">{orig.authCode || '—'}</td>
                <td className="mono">{orig.cardLast4 || '—'}</td>
                <td>{money(orig.amount)}</td>
                <td className="text-sm">{fmtTime(orig.capturedAt)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <Alert tone="info">查無原刷卡端末紀錄，請以紙本簽單核對原交易卡號。</Alert>
      )}
      <div className="list-toolbar">
        <Field label="退貨 RRN（調閱編號）">
          <Input value={d.rrn} maxLength={12} disabled={busy} onChange={(e) => setD({ ...d, rrn: e.target.value.trim() })} className="mono" />
        </Field>
        <Field label="退貨授權碼（6 碼）">
          <Input value={d.authCode} maxLength={6} disabled={busy} onChange={(e) => setD({ ...d, authCode: e.target.value.trim().toUpperCase() })} className="mono" />
        </Field>
        <Field label="卡號末四碼">
          <Input value={d.cardLast4} maxLength={4} inputMode="numeric" disabled={busy} onChange={(e) => setD({ ...d, cardLast4: e.target.value.replace(/\D/g, '') })} className="mono" />
        </Field>
        <Field label="端末序號（選填）">
          <Input value={d.terminalRef} maxLength={40} disabled={busy} onChange={(e) => setD({ ...d, terminalRef: e.target.value })} />
        </Field>
      </div>
      {cardMismatch && (
        <Alert tone="error">卡號末四碼與原交易（{orig?.cardLast4}）不符；乙禾退貨必須退回原刷卡片，後端將拒絕此筆。</Alert>
      )}
      <div className="btn-row">
        <Button disabled={busy || !valid || cardMismatch} loading={busy} onClick={() => onSubmit(d)}>
          確認乙禾退刷
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

const RESOLVE_FORBIDDEN_HINT = '此操作須由值班主管（DUTY+）授權執行，請由主管帳號登入辦理；無須重新登入目前帳號。';

/** ezPay 折讓結果不明：主管核對藍新後台後擇一處置（已開立補登折讓號／確認未開立重開），兩者皆必填原因 */
function InvoiceResolveModal({
  pending,
  onSubmit,
  onClose,
}: {
  pending: RefundInvoiceResolve;
  onSubmit: (body: RefundInvoiceResolveBody) => Promise<RefundErrorInfo | null>;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<'ISSUED' | 'NOT_ISSUED' | null>(null);
  const [allowanceNo, setAllowanceNo] = useState('');
  const [confirmedAbsent, setConfirmedAbsent] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RefundErrorInfo | null>(null);
  const resolveInFlightRef = useRef(false);

  const no = allowanceNo.trim().toUpperCase();
  const noValid = /^[A-Z0-9]{6,20}$/.test(no);
  const valid =
    outcome !== null &&
    reason.trim().length >= 2 &&
    (outcome === 'ISSUED' ? noValid : confirmedAbsent);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || resolveInFlightRef.current) return;
    resolveInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const body: RefundInvoiceResolveBody =
        outcome === 'ISSUED'
          ? { einvoiceId: pending.einvoiceId, outcome, ezPayAllowanceNo: no, reason: reason.trim() }
          : { einvoiceId: pending.einvoiceId, outcome: 'NOT_ISSUED', confirmEzPayNotIssued: true, reason: reason.trim() };
      const err = await onSubmit(body);
      if (err) setError(err.status === 403 ? { ...err, title: '權限不足', hint: RESOLVE_FORBIDDEN_HINT } : err);
    } finally {
      resolveInFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal open title="核對藍新結果" onClose={onClose} closeOnBackdrop={false}>
      <form onSubmit={submit} className="form-stack">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>原發票號碼</th><th>本次折讓（含稅）</th><th>未稅</th><th>稅額</th><th>類別</th></tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">{pending.invoiceNumber}</td>
                <td><strong>{money(pending.amount)}</strong></td>
                <td>{money(pending.untaxed)}</td>
                <td>{money(pending.tax)}</td>
                <td>{pending.category === 'B2B' ? 'B2B（須買受人簽名）' : pending.category || '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm" style={{ margin: 0 }}>
          請至藍新 ezPay 後台查詢此發票是否已有<strong>相同金額</strong>之折讓單，依查詢結果選擇。限值班主管（DUTY+）操作。
        </p>
        <fieldset className="auth-choice-list" disabled={busy}>
          <legend className="field__label">藍新後台查詢結果</legend>
          <label className="auth-choice">
            <input type="radio" name="invoiceResolveOutcome" checked={outcome === 'ISSUED'} onChange={() => { setOutcome('ISSUED'); setConfirmedAbsent(false); }} />
            <span>藍新<strong>已開立</strong>此筆折讓 → 補登折讓單號後接續結案（不會再呼叫藍新）</span>
          </label>
          <label className="auth-choice">
            <input type="radio" name="invoiceResolveOutcome" checked={outcome === 'NOT_ISSUED'} onChange={() => { setOutcome('NOT_ISSUED'); setAllowanceNo(''); }} />
            <span>藍新<strong>未開立</strong>：確認後重新發送折讓</span>
          </label>
        </fieldset>
        {outcome === 'ISSUED' && (
          <Field label="藍新折讓單號（必填）">
            <Input
              value={allowanceNo}
              maxLength={20}
              disabled={busy}
              autoComplete="off"
              className="mono"
              onChange={(e) => setAllowanceNo(e.target.value)}
            />
          </Field>
        )}
        {outcome === 'NOT_ISSUED' && (
          <label className="text-sm">
            <input
              type="checkbox"
              checked={confirmedAbsent}
              disabled={busy}
              onChange={(e) => setConfirmedAbsent(e.target.checked)}
            />{' '}
            我已於藍新後台確認該筆折讓尚未開立
          </label>
        )}
        {outcome === 'ISSUED' && allowanceNo.trim() !== '' && !noValid && (
          <Alert tone="warning">折讓單號須為 6～20 碼英數字，請依藍新後台所示輸入。</Alert>
        )}
        {outcome && (
          <Field label="核對說明（必填，寫入稽核紀錄）">
            <textarea
              className="input"
              rows={3}
              maxLength={200}
              value={reason}
              disabled={busy}
              placeholder={outcome === 'ISSUED' ? '例：藍新後台查得折讓單，金額相符' : '例：藍新後台查無此發票折讓紀錄'}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        )}
        <RefundErrorAlert error={error} onDismiss={() => setError(null)} />
        <div className="reason-modal__actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={!valid}>
            {outcome === 'NOT_ISSUED' ? '確認未開立並重開' : '補登折讓單號'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** 退費單後續處理：乙禾回填、改臨櫃現金、重試、核對藍新結果、中止、客顯簽名、折讓單列印（狀態一律以後端回傳為準） */
export default function RefundRecordView({
  refund: initial,
  onChange,
}: {
  refund: RefundRecord;
  onChange?: (r: RefundRecord) => void;
}) {
  const { toast } = useToast();
  const posDisplay = usePosDisplayHost();
  const printer = useAllowancePrint();
  const [refund, setRefund] = useState(initial);
  const [busy, setBusy] = useState(false);
  const refundInFlightRef = useRef(false);
  const [actionError, setActionError] = useState<RefundErrorInfo | null>(null);
  const [checked, setChecked] = useState(false);
  const [yipayFor, setYipayFor] = useState<string | null>(null);
  const [cashFor, setCashFor] = useState<RefundPaymentRecord | null>(null);
  const [aborting, setAborting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [reopenedAmbiguous, setReopenedAmbiguous] = useState(false);
  const [stepSummary, setStepSummary] = useState<RefundGatewayRetryData['stepSummary']>(null);

  const apply = useCallback(
    (res: ApiResponse<RefundRecord>) => {
      if (!res.data) return;
      setRefund(res.data);
      onChange?.(res.data);
      setChecked(false);
      toast(res.message || '已更新', res.code === 'PARTIAL_INVOICE' ? 'info' : 'success');
    },
    [onChange, toast],
  );

  /**
   * 所有寫入動作共用同步鎖：請求進行中不得再送（防重複退刷／重複折讓／重複回滾錢包）
   * 成功回傳最新退費單；onError 有值時錯誤交由呼叫端（對話框內）明示
   */
  const run = useCallback(
    async (
      fn: () => Promise<ApiResponse<RefundRecord>>,
      fallback: string,
      onError?: (e: RefundErrorInfo) => void,
    ): Promise<RefundRecord | null> => {
      if (refundInFlightRef.current) return null;
      refundInFlightRef.current = true;
      setBusy(true);
      setActionError(null);
      try {
        const res = await fn();
        apply(res);
        return res.data ?? null;
      } catch (err) {
        const info = describeRefundError(err, fallback);
        if (onError) onError(info);
        else setActionError(info);
        try {
          const fresh = await fetchRefund(refund.id);
          if (fresh.data) {
            setRefund(fresh.data);
            onChange?.(fresh.data);
          }
        } catch {
          /* 保留原畫面 */
        }
        return null;
      } finally {
        refundInFlightRef.current = false;
        setBusy(false);
      }
    },
    [apply, onChange, refund.id],
  );

  const { postIdle } = posDisplay;
  const allowanceBus = usePosAllowanceBus({
    refundInFlightRef,
    onFinalized: (r, message) => {
      setRefund(r);
      onChange?.(r);
      toast(message || '簽名已歸檔', 'success');
      postIdle();
    },
  });
  const signing = allowanceBus.active;
  const locked = busy || allowanceBus.phase === 'uploading';

  const allowances = (refund.invoiceResults || []).filter((x) => x.action === 'ALLOWANCE' && x.done && x.allowanceNo);
  const yipayAwaiting = refund.payments.some(
    (p) =>
      p.method === 'YIPAY'
      && p.status !== 'FORFEITED'
      && p.status !== 'CANCELLED'
      && p.status !== 'REVERSED'
      && (p.status === 'AWAITING_TERMINAL' || !p.rrn || !p.authCode),
  );
  const canSign = !refund.signed && refund.status !== 'ABORTED' && allowances.length > 0 && !yipayAwaiting;
  const terminal = ['COMPLETED', 'ABORTED'].includes(refund.status);
  const yipayPayment = yipayFor ? refund.payments.find((p) => p.id === yipayFor) || null : null;
  const pendingResolve = terminal ? null : refund.invoiceResolve ?? null;
  /** 作廢／折讓結果不明（含作廢逾時）：後端禁止中止 */
  const invoiceUnknown = Boolean(pendingResolve) || (refund.invoiceResults || []).some((x) => !x.done && x.ambiguous);
  const paymentConfirmRequired = paymentNeedsGatewayConfirm(refund);
  const retryLockedByPeer = actionError?.code === 'REFUND_RETRY_IN_PROGRESS';

  async function ensureBuyerAtDisplay() {
    if (!refund.signatureRequired || refund.signed) return true;
    if (refundInFlightRef.current) return false;
    refundInFlightRef.current = true;
    setBusy(true);
    try {
      const alive = await probeCustomerDisplay();
      if (!alive) {
        setActionError(DISPLAY_PROBE_BLOCKED);
        return false;
      }
      return true;
    } finally {
      refundInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function submitRetry() {
    if (refundInFlightRef.current || (paymentNeedsGatewayConfirm(refund) && !checked)) return;
    if (refund.signatureRequired && !refund.signed && !['SIGNATURE_PENDING', 'COMPLETED', 'ABORTED', 'AWAITING_TERMINAL'].includes(refund.status)) {
      if (!(await ensureBuyerAtDisplay())) return;
    }
    refundInFlightRef.current = true;
    setBusy(true);
    setActionError(null);
    setStepSummary(null);
    try {
      const res = await retryRefundGateway(refund.id, checked);
      const order = res.data?.refundOrder;
      if (order) {
        setRefund(order);
        onChange?.(order);
        setChecked(false);
        setStepSummary(res.data?.stepSummary ?? null);
        toast(res.message || '已更新', res.code === 'PARTIAL_INVOICE' ? 'info' : 'success');
      }
    } catch (err) {
      const info = describeRefundError(err, '重試失敗');
      setActionError(info);
      try {
        const fresh = await fetchRefund(refund.id);
        const next = fresh.data;
        if (next) {
          setRefund(next);
          onChange?.(next);
          if (info.code === 'YIPAY_TERMINAL_VOUCHER_REQUIRED') {
            const leg = next.payments.find((p) => p.method === 'YIPAY' && (p.status === 'AWAITING_TERMINAL' || !p.rrn || !p.authCode));
            if (leg) setYipayFor(leg.id);
          }
          if (info.code === 'INVOICE_RESULT_UNKNOWN' && next.invoiceResolve) setResolving(true);
        }
      } catch {
        /* 保留原畫面 */
      }
    } finally {
      refundInFlightRef.current = false;
      setBusy(false);
    }
  }

  function requestSignature() {
    setActionError(null);
    void allowanceBus.start(refund.id);
  }

  async function submitResolve(body: RefundInvoiceResolveBody): Promise<RefundErrorInfo | null> {
    const box: { err: RefundErrorInfo | null } = { err: null };
    const next = await run(() => resolveRefundInvoice(refund.id, body), '核對藍新結果失敗', (e) => {
      box.err = e;
    });
    if (!next) {
      if (box.err && ['NO_UNRESOLVED_INVOICE', 'INVOICE_MISMATCH'].includes(box.err.code || '')) setActionError(box.err);
      return box.err;
    }
    setResolving(false);
    setReopenedAmbiguous(body.outcome === 'NOT_ISSUED' && Boolean(next.invoiceResolve));
    if (next.status === 'SIGNATURE_PENDING' && !next.signed) void allowanceBus.start(next.id);
    return null;
  }

  async function print(allowanceNo: string, format: AllowancePrintFormat) {
    try {
      await printer.print(allowanceNo, format);
    } catch (err) {
      setActionError(describeRefundError(err, '列印失敗'));
    }
  }

  return (
    <div className="form-stack">
      <div className="btn-row" style={{ alignItems: 'center' }}>
        <Badge tone={refundStatusTone(refund.status)} dot>
          {REFUND_STATUS_LABEL[refund.status] || refund.status}
        </Badge>
        <span className="mono text-sm">{refund.id}</span>
        <span className="text-sm text-muted">
          子單 {refund.subOrderId} · 應退 {money(refund.grossAmount)} · 實退 {money(refund.payoutAmount)}
          {refund.feeAmount > 0 ? ` · 手續費 ${money(refund.feeAmount)}` : ''}
        </span>
      </div>
      {refund.calc?.note ? <p className="text-sm" style={{ margin: 0 }}>{String(refund.calc.note)}</p> : null}
      {pendingResolve ? (
        <Alert tone="warning">
          <strong>藍新折讓結果不明，須由值班主管核對</strong>
          <div>
            發票 <span className="mono">{pendingResolve.invoiceNumber}</span> · 本次折讓含稅 {money(pendingResolve.amount)}
            （未稅 {money(pendingResolve.untaxed)}＋稅額 {money(pendingResolve.tax)}）
          </div>
          <div className="text-sm" style={{ marginTop: 4 }}>
            藍新可能已開立此筆折讓，預占額度保留中；核對前不可重試或中止。已退款不受影響。
          </div>
          {reopenedAmbiguous ? (
            <div className="text-sm" style={{ marginTop: 4 }}>
              <strong>重新開立折讓時再次發生連線異常／回應異常</strong>，請再次至藍新後台核對。
            </div>
          ) : null}
          <div className="btn-row" style={{ marginTop: 8 }}>
            <Button size="sm" disabled={locked} onClick={() => setResolving(true)}>核對藍新結果</Button>
          </div>
        </Alert>
      ) : refund.status === 'INVOICE_FAILED' ? (
        <Alert tone="warning">退款已完成，發票作廢／折讓失敗（已退款不會沖回）。請稍後按「重試」補處理發票。</Alert>
      ) : null}
      {refund.status === 'GATEWAY_RETRYING' && !terminal ? (
        <Alert tone="warning">正在與金流／ezPay 同步。若櫃台行程中斷，約 90 秒後才可再試。</Alert>
      ) : null}
      {stepSummary ? (
        <Alert tone="info">
          <strong>本次重試檢查點</strong>
          <div className="text-sm">金流：{GATEWAY_PAYMENT_STEP_LABEL[stepSummary.paymentGatewayStep] || stepSummary.paymentGatewayStep}</div>
          <div className="text-sm">發票／折讓：{GATEWAY_INVOICE_STEP_LABEL[stepSummary.ezPayInvoiceStep] || stepSummary.ezPayInvoiceStep}</div>
        </Alert>
      ) : null}
      {refund.lastError && !terminal && !pendingResolve ? <Alert tone="warning">{refund.lastError}</Alert> : null}
      {refund.status === 'ABORTED' && refund.abortReason ? <Alert tone="info">中止原因：{refund.abortReason}</Alert> : null}
      <RefundErrorAlert error={actionError} onDismiss={() => setActionError(null)} />

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>退款管道</th>
              <th>金額</th>
              <th>狀態</th>
              <th>憑證</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {refund.payments.map((p) => {
              const canCash =
                ((p.method === 'LINEPAY' || p.method === 'PAYUNI') && p.status === 'FAILED') ||
                (p.method === 'YIPAY' && p.status === 'AWAITING_TERMINAL');
              return (
                <tr key={p.id}>
                  <td>{REFUND_METHOD_LABEL[p.method] || p.method}</td>
                  <td>{money(p.amount)}</td>
                  <td>
                    {REFUND_PAYMENT_STATUS_LABEL[p.status] || p.status}
                    {p.lastError && p.status === 'FAILED' ? (
                      <div className="text-muted" style={{ fontSize: 11 }}>{p.lastError}</div>
                    ) : null}
                  </td>
                  <td className="mono text-sm">
                    {p.rrn ? `RRN ${p.rrn} · 授權 ${p.authCode} · 末四碼 ${p.cardLast4}` : p.providerRef || '—'}
                  </td>
                  <td>
                    <div className="btn-row">
                      {p.method === 'YIPAY' && p.status === 'AWAITING_TERMINAL' && (
                        <Button size="sm" disabled={locked} onClick={() => setYipayFor(p.id)}>
                          端末退刷
                        </Button>
                      )}
                      {canCash && (
                        <Button size="sm" variant="secondary" disabled={locked} onClick={() => setCashFor(p)}>
                          改臨櫃現金
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {yipayPayment && yipayPayment.status === 'AWAITING_TERMINAL' && (
        <YipayRefundForm
          key={yipayPayment.id}
          payment={yipayPayment}
          busy={locked}
          onCancel={() => setYipayFor(null)}
          onSubmit={(d) =>
            void (async () => {
              if (!(await ensureBuyerAtDisplay())) return;
              const ok = await run(() => confirmYipayRefund(refund.id, yipayPayment.id, d), '乙禾退刷確認失敗');
              if (ok) setYipayFor(null);
            })()
          }
        />
      )}

      {allowances.length > 0 && (
        <div className="form-stack">
          <strong className="text-sm">折讓單</strong>
          {allowances.map((a) => (
            <div key={a.allowanceNo} className="btn-row" style={{ alignItems: 'center' }}>
              <span className="mono text-sm">{a.allowanceNo}</span>
              <span className="text-sm text-muted">
                原發票 {a.invoiceNumber} · {money(a.amount || 0)}
                {a.resolvedManually ? ' · 人工核對補登' : ''}
              </span>
              <Button size="sm" variant="secondary" onClick={() => void print(a.allowanceNo!, 'A4_FOUR_PART')}>A4 列印</Button>
              <Button size="sm" variant="secondary" onClick={() => void print(a.allowanceNo!, 'THERMAL_80MM')}>熱感列印</Button>
            </div>
          ))}
        </div>
      )}
      {(refund.invoiceResults || [])
        .filter((x) => x.action !== 'ALLOWANCE' && x.done && x.action && x.action !== 'NONE')
        .map((x) => (
          <p key={`${x.einvoiceId}-${x.action}`} className="text-sm" style={{ margin: 0 }}>
            發票 {x.invoiceNumber || '（未開立）'}：{INVOICE_ACTION_LABEL[x.action || ''] || x.action}
            {x.remoteAlreadyVoided ? '（查得藍新已作廢，已同步）' : ''}
          </p>
        ))}

      {canSign && (
        <Alert tone={refund.signatureRequired ? 'warning' : 'info'}>
          {refund.signatureRequired
            ? 'B2B 折讓須買受人於客顯核對原發票號碼與折讓金額並親簽後才會結案。'
            : '可請顧客於客顯核對折讓明細並簽收（B2C 選簽）。'}
          {allowanceBus.phase === 'preparing' ? '（產生預覽中…）' : ''}
          {allowanceBus.phase === 'waiting_ack' ? '（已推送，等待客顯回應…）' : ''}
          {allowanceBus.phase === 'viewing' ? '（顧客核對／簽名中…）' : ''}
          {allowanceBus.phase === 'uploading' ? '（簽名歸檔中…）' : ''}
        </Alert>
      )}
      {canSign && allowanceBus.phase === 'no_display' && (
        <Alert tone="error">
          <strong>未偵測到客顯視窗回應</strong>
          <div className="text-sm">
            {DISPLAY_ACK_TIMEOUT_MS / 1000} 秒內未收到客顯確認。請確認副螢幕已開啟客顯頁面（須同一瀏覽器、同一設定檔），然後重新推送。
            B2B 折讓仍須客顯親簽歸檔後才結案；可先列印折讓單供顧客核對，紙本簽名不能代替歸檔。
          </div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            <Button size="sm" variant="secondary" onClick={posDisplay.openDisplayWindow}>開啟客顯</Button>
            <Button size="sm" onClick={allowanceBus.resend}>重新推送</Button>
            <Button size="sm" variant="ghost" onClick={allowanceBus.cancel}>撤回</Button>
          </div>
        </Alert>
      )}
      <RefundErrorAlert error={allowanceBus.error} onDismiss={allowanceBus.clearError} />

      {paymentConfirmRequired && !terminal && !pendingResolve && (
        <label className="text-sm">
          <input type="checkbox" checked={checked} disabled={locked || retryLockedByPeer} onChange={(e) => setChecked(e.target.checked)} />{' '}
          我已確認 LINE Pay／PayUNi 後台未完成退刷（無退款序號時必勾，避免雙重退刷）
        </label>
      )}

      <div className="btn-row">
        {!terminal && !pendingResolve && RETRYABLE.includes(refund.status) && (
          <Button
            disabled={locked || retryLockedByPeer || (paymentConfirmRequired && !checked)}
            loading={busy}
            onClick={() => void submitRetry()}
          >
            重試
          </Button>
        )}
        {canSign &&
          (signing ? (
            <Button variant="ghost" disabled={allowanceBus.phase === 'uploading'} onClick={allowanceBus.cancel}>
              取消客顯簽名
            </Button>
          ) : (
            <Button variant="secondary" disabled={locked} onClick={requestSignature}>
              推送客顯簽名
            </Button>
          ))}
        {!terminal && (
          <Button variant="danger" disabled={locked || signing || invoiceUnknown} onClick={() => setAborting(true)}>
            中止退費
          </Button>
        )}
      </div>
      {!terminal && invoiceUnknown && (
        <p className="text-sm text-muted" style={{ margin: 0 }}>
          發票作廢／折讓結果不明期間禁止中止，請先{pendingResolve ? '核對藍新後台' : '按「重試」由系統查詢藍新結果'}。
        </p>
      )}

      {resolving && pendingResolve && (
        <InvoiceResolveModal
          key={pendingResolve.einvoiceId}
          pending={pendingResolve}
          onSubmit={submitResolve}
          onClose={() => setResolving(false)}
        />
      )}

      {cashFor && (
        <ReasonModal
          title={`改臨櫃現金退款 ${money(cashFor.amount)}`}
          label="原因（必填）"
          confirmLabel="改現金退款"
          danger
          onClose={() => setCashFor(null)}
          onSubmit={async (reason) => {
            if (!(await ensureBuyerAtDisplay())) return false;
            return run(() => fallbackRefundToCash(refund.id, cashFor.id, { reason, confirmGatewayNotRefunded: checked }), '改臨櫃現金失敗').then(Boolean);
          }}
        >
          <p className="text-sm">
            原 {REFUND_METHOD_LABEL[cashFor.method]} 退款將標記為已改其他方式，現金自本班錢櫃支出並列入交班。須有進行中班次。
          </p>
        </ReasonModal>
      )}
      {aborting && (
        <ReasonModal
          title="中止退費"
          label="中止原因（必填）"
          confirmLabel="中止並沖回"
          danger
          onClose={() => setAborting(false)}
          onSubmit={(reason) => run(() => abortRefund(refund.id, reason), '中止失敗').then(Boolean)}
        >
          <p className="text-sm">
            僅限尚無線上／乙禾退款完成、發票未處理者。已收回之權益、錢包與庫存將沖回；已退現金須已在本班錢櫃收回。已終止之定期定額不會恢復。
          </p>
        </ReasonModal>
      )}

      {printer.job && (
        <AllowancePrintView
          key={`${printer.job.payload.allowance.allowanceNo}-${printer.job.format}`}
          payload={printer.job.payload}
          format={printer.job.format}
          onDone={printer.clear}
        />
      )}
    </div>
  );
}
