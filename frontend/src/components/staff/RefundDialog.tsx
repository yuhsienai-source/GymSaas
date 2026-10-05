import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Field, Input, Modal, Select } from '../ui';
import RefundRecordView from './RefundRecordView';
import RefundErrorAlert from './RefundErrorAlert';
import { useToast } from '../../contexts/ToastContext';
import {
  executeSubOrderRefund,
  executeTopupCancel,
  newRefundIdempotencyKey,
  opsRefundLookup,
  previewSubOrderRefund,
  previewTopupCancel,
  type ShortfallResolution,
  type SubOrderRefundItem,
} from '../../lib/api';
import { DISPLAY_PROBE_BLOCKED, probeCustomerDisplay } from '../../lib/customerDisplayProbe';
import { describeRefundError, type RefundErrorInfo } from '../../lib/refundErrors';
import {
  INVOICE_ACTION_LABEL,
  ORDER_KIND_LABEL,
  REFUND_METHOD_LABEL,
  invoiceDisplayStatus,
} from '../../lib/refundLabels';
import type {
  RefundAction,
  RefundLookupInvoice,
  RefundLookupResult,
  RefundLookupSubOrder,
  RefundPreview,
  RefundRecord,
  RefundScope,
  RefundTerminationClause,
} from '../../types/api';
import { useStaffAuth } from '../../contexts/StaffAuthContext';

function money(n: number) {
  return `$${Math.round(Number(n) || 0).toLocaleString('zh-TW')}`;
}

const ACTION_LABEL: Record<RefundAction, string> = {
  TOPUP_CANCEL: '儲值原單取消',
  SUB_ORDER_REFUND: '子單退費',
  GROUP_REFUND: '團課退費（請至團課報名）',
  SUBSCRIPTION_CANCEL: '請至「月卡訂閱／請假」取消',
};

type Choice = { sub: RefundLookupSubOrder; action: 'TOPUP_CANCEL' | 'SUB_ORDER_REFUND' };

function scopeOptions(kind: RefundLookupSubOrder['kind']): { value: RefundScope; label: string }[] {
  if (kind === 'SALE') return [{ value: 'FULL', label: '全部未退品項' }, { value: 'ITEMS', label: '勾選品項／退貨數量' }];
  if (kind === 'MEMBERSHIP')
    return [
      { value: 'FULL', label: '契約第八條：未開始／7 日內未使用全額退' },
      { value: 'UNUSED', label: '契約第九條：未履約退費（半月制、扣手續費，截斷效期）' },
    ];
  if (kind === 'PT')
    return [
      { value: 'FULL', label: '契約第八條：未上課全額退' },
      { value: 'UNUSED', label: '契約第九條：未上堂數退費（扣已上堂數、臨時請假補償與違約金）' },
    ];
  if (kind === 'COURSE_SUB')
    return [
      { value: 'UNUSED', label: '契約第九條：分期解約（扣已上堂數、違約金與未繳期數，終止續扣）' },
      { value: 'FULL', label: '契約第八條：未上課，退已繳全額' },
    ];
  if (kind === 'TOPUP') return [{ value: 'UNUSED', label: '契約第九條：未使用退費（扣實際使用與手續費）' }];
  return [];
}

/** 可套用契約條款／手續費調降之子單類型（後端另擋 SALE／原單取消） */
const FEE_POLICY_KINDS: RefundLookupSubOrder['kind'][] = ['MEMBERSHIP', 'PT', 'COURSE_SUB', 'TOPUP'];

const CLAUSE_OPTIONS: { value: RefundTerminationClause; label: string }[] = [
  { value: 'VOLUNTARY', label: '第九條 自願終止（依契約收手續費）' },
  { value: 'EXEMPT', label: '第十四條 不可歸責（受傷／懷孕／遷居／教練無法履約）免手續費' },
];

/** 後端逾效期／應補繳提示已以紅色警示框呈現，一般提示列表略過 */
const CONTRACT_ALERT_PREFIXES = ['本課程已逾契約效期', '學員上課進度超前'];

const SHORTFALL_RESOLUTION_LABEL: Record<ShortfallResolution, string> = {
  PAID_AT_POS: '已臨櫃收訖',
  FLAG_ALERT_FOR_RECOVERY: '立案追償（列欠款黑名單）',
};

function twDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 已使用量文字：只讀後端 calc，不在前端重算 */
function usageLabel(preview: RefundPreview): string | null {
  const c = preview.calc as Record<string, unknown>;
  if (preview.orderKind === 'MEMBERSHIP') {
    const d = (c.detail || null) as Record<string, unknown> | null;
    if (!d) return null;
    return `已用 ${d.consumedPeriods}/${d.totalPeriods} 期（本期第 ${d.usedDays} 日，未滿 15 日以半個月計）`;
  }
  if (preview.orderKind === 'PT') {
    const released = num(c.releasedSessions) ?? 0;
    return `已上 ${c.used}/${c.totalSessions} 堂${released > 0 ? `（另釋出未來預約 ${released} 堂）` : ''}`;
  }
  if (preview.orderKind === 'TOPUP') {
    const used = num(c.usedAmount);
    return used == null ? null : `實際使用 ${money(used)}`;
  }
  return null;
}

function BreakdownTable({ preview, contractTotal }: { preview: RefundPreview; contractTotal: number }) {
  const c = preview.calc as Record<string, unknown>;
  const lateFees = num(c.lateLeaveFees) ?? 0;
  const lateCount = num(c.lateLeaveCount) ?? 0;
  const usage = usageLabel(preview);
  const rows: [string, string, boolean?][] = [
    ['原合約總價', money(contractTotal)],
    ...(usage ? ([['已使用', usage]] as [string, string][]) : []),
    [
      lateFees > 0 ? '已使用折算額（含臨時請假補償）' : '已使用折算額',
      preview.consumedValue > 0 ? `− ${money(preview.consumedValue)}` : money(0),
    ],
    ...(lateFees > 0
      ? ([[`臨時請假補償（${lateCount} 次，未於 8 小時前請假）`, `− ${money(lateFees)}`]] as [string, string][])
      : []),
    ['契約手續費上限', money(preview.feeMax)],
    ['實收手續費', preview.feeAmount > 0 ? `− ${money(preview.feeAmount)}` : money(0)],
    ['應退金額', money(preview.grossAmount)],
    ['實退金額', money(preview.payoutAmount), true],
  ];
  return (
    <div className="table-wrap">
      <table className="data-table">
        <tbody>
          {rows.map(([k, v, strong]) => (
            <tr key={k}>
              <th style={{ textAlign: 'left', fontWeight: 500 }}>{k}</th>
              <td style={{ textAlign: 'right', ...(strong ? { color: 'var(--brand, #083D4F)', fontWeight: 700 } : {}) }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceChips({ invoices }: { invoices?: RefundLookupInvoice[] }) {
  if (!invoices?.length) return <span className="text-muted text-sm">無發票</span>;
  return (
    <div className="form-stack" style={{ gap: 4 }}>
      {invoices.map((inv) => {
        const st = invoiceDisplayStatus(inv);
        return (
          <div key={inv.id} className="btn-row" style={{ gap: 6, alignItems: 'center' }}>
            <span className="mono text-sm">{inv.invoiceNumber || '（未配號）'}</span>
            <Badge tone={st.tone}>{st.label}</Badge>
            {inv.category === 'B2B' ? <span className="text-muted" style={{ fontSize: 11 }}>B2B</span> : null}
            {inv.allowanceTotal > 0 ? (
              <span className="text-muted" style={{ fontSize: 11 }}>已折讓 {money(inv.allowanceTotal)}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 退費視窗：以單號（SAL／TYK／CRS／CHK…）或發票號反查 → 選子單與範圍 → 後端試算 → 必填原因執行。
 * 金額、管道拆分與發票作法全部由後端決定；前端只送 scope、items{orderItemId,qty}、reason。
 * 呼叫端須於每次開啟時重新掛載（條件渲染），狀態不跨單據沿用。
 */
export default function RefundDialog({
  open,
  refId,
  invoiceNumber,
  preferAction,
  onClose,
  onDone,
}: {
  open: boolean;
  refId?: string;
  invoiceNumber?: string;
  preferAction?: 'TOPUP_CANCEL' | 'SUB_ORDER_REFUND';
  onClose: () => void;
  onDone?: (r: RefundRecord) => void;
}) {
  const { toast } = useToast();
  const { canAccessTx } = useStaffAuth();
  const [clause, setClause] = useState<RefundTerminationClause>('VOLUNTARY');
  /** 空字串＝依契約上限；調降值只送後端驗證，不在前端算實退 */
  const [feeInput, setFeeInput] = useState('');
  const [lookup, setLookup] = useState<RefundLookupResult | null>(null);
  const [lookupError, setLookupError] = useState<RefundErrorInfo | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [scope, setScope] = useState<RefundScope>('FULL');
  const [qty, setQty] = useState<Record<number, number>>({});
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [previewError, setPreviewError] = useState<RefundErrorInfo | null>(null);
  const [execError, setExecError] = useState<RefundErrorInfo | null>(null);
  const [reason, setReason] = useState('');
  const [buyerEmail, setBuyerEmail] = useState('');
  const [record, setRecord] = useState<RefundRecord | null>(null);
  const [busy, setBusy] = useState(false);
  /** 應補繳處置（綁定選擇當下金額；試算金額變動即失效） */
  const [shortfallChoice, setShortfallChoice] = useState<{ amount: number; resolution: ShortfallResolution } | null>(null);
  const [shortfallNote, setShortfallNote] = useState('');
  const refundInFlightRef = useRef(false);
  const idempotencyKeyRef = useRef(newRefundIdempotencyKey());

  const pick = useCallback((sub: RefundLookupSubOrder, action: Choice['action']) => {
    idempotencyKeyRef.current = newRefundIdempotencyKey();
    setChoice({ sub, action });
    setScope(action === 'TOPUP_CANCEL' ? 'FULL' : scopeOptions(sub.kind)[0]?.value || 'FULL');
    setClause('VOLUNTARY');
    setFeeInput('');
    setQty({});
    setPreview(null);
    setPreviewError(null);
    setExecError(null);
    setShortfallChoice(null);
    setShortfallNote('');
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await opsRefundLookup({
          ...(refId ? { orderId: refId } : {}),
          ...(invoiceNumber ? { invoiceNumber } : {}),
        });
        if (cancelled || !res.data) return;
        setLookup(res.data);
        const usable = res.data.subOrders.filter((s) =>
          s.actions.some((a) => a === 'TOPUP_CANCEL' || a === 'SUB_ORDER_REFUND'),
        );
        if (usable.length === 1) {
          const s = usable[0];
          const a = preferAction && s.actions.includes(preferAction) ? preferAction : (s.actions[0] as Choice['action']);
          if (a === 'TOPUP_CANCEL' || a === 'SUB_ORDER_REFUND') pick(s, a);
        }
      } catch (err) {
        if (!cancelled) setLookupError(describeRefundError(err, '查詢單據失敗'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refId, invoiceNumber, preferAction, pick]);

  const items: SubOrderRefundItem[] = useMemo(
    () =>
      Object.entries(qty)
        .filter(([, q]) => q > 0)
        .map(([id, q]) => ({ orderItemId: Number(id), qty: q })),
    [qty],
  );
  const needItems = choice?.action === 'SUB_ORDER_REFUND' && scope === 'ITEMS' && !items.length;
  const feePolicyEnabled =
    canAccessTx && choice?.action === 'SUB_ORDER_REFUND' && FEE_POLICY_KINDS.includes(choice.sub.kind);
  const policyClause: RefundTerminationClause = feePolicyEnabled ? clause : 'VOLUNTARY';
  const feeTrim = feeInput.trim();
  const feeInvalid = feePolicyEnabled && clause === 'VOLUNTARY' && feeTrim !== '' && !/^\d+$/.test(feeTrim);
  const overrideFeeAmount =
    feePolicyEnabled && clause === 'VOLUNTARY' && feeTrim !== '' && !feeInvalid ? Number(feeTrim) : null;
  const inputKey = choice
    ? JSON.stringify([choice.sub.id, choice.action, scope, scope === 'ITEMS' ? items : null, policyClause, overrideFeeAmount])
    : '';
  const [previewKey, setPreviewKey] = useState('');
  const previewCurrent = Boolean(preview) && previewKey === inputKey;
  const shortfall = preview?.shortfall ?? 0;
  const shortfallResolution = shortfall > 0 && shortfallChoice?.amount === shortfall ? shortfallChoice.resolution : null;
  const shortfallBlocked =
    shortfall > 0 && (!shortfallResolution || (shortfallResolution === 'PAID_AT_POS' && shortfallNote.trim().length < 2));

  const runPreview = useCallback(async () => {
    if (!choice) return;
    if ((choice.action === 'SUB_ORDER_REFUND' && scope === 'ITEMS' && !items.length) || feeInvalid) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const key = JSON.stringify([choice.sub.id, choice.action, scope, scope === 'ITEMS' ? items : null, policyClause, overrideFeeAmount]);
    try {
      const res =
        choice.action === 'TOPUP_CANCEL'
          ? await previewTopupCancel(choice.sub.id)
          : await previewSubOrderRefund(choice.sub.id, {
              scope,
              items: scope === 'ITEMS' ? items : undefined,
              clause: policyClause,
              overrideFeeAmount,
            });
      setPreview(res.data || null);
      setPreviewKey(key);
      setPreviewError(null);
    } catch (err) {
      setPreview(null);
      setPreviewError(describeRefundError(err, '試算失敗'));
    }
  }, [choice, scope, items, policyClause, overrideFeeAmount, feeInvalid]);

  useEffect(() => {
    if (!choice || record) return;
    const t = window.setTimeout(() => void runPreview(), 250);
    return () => window.clearTimeout(t);
  }, [choice, record, runPreview]);

  async function execute() {
    if (!choice || !preview || !previewCurrent || refundInFlightRef.current || shortfallBlocked) return;
    if (!reason.trim()) {
      setExecError({ title: '請填寫退費原因', message: '', tone: 'warning' });
      return;
    }
    refundInFlightRef.current = true;
    setBusy(true);
    setExecError(null);
    if (preview.signatureRequired) {
      const displayReady = await probeCustomerDisplay();
      if (!displayReady) {
        refundInFlightRef.current = false;
        setBusy(false);
        setExecError(DISPLAY_PROBE_BLOCKED);
        return;
      }
    }
    const ok = window.confirm(
      `確定對 ${choice.sub.id} ${choice.action === 'TOPUP_CANCEL' ? '原單取消' : '退費'}？\n實退 ${money(preview.payoutAmount)}（應退 ${money(preview.grossAmount)}${
        preview.feeAmount > 0 ? `，手續費 ${money(preview.feeAmount)}` : ''
      }${preview.clause === 'EXEMPT' ? '，第十四條免手續費' : ''}）\n發票：${
        INVOICE_ACTION_LABEL[preview.invoicePlan.action] || preview.invoicePlan.action
      }${preview.signatureRequired ? '\n開立折讓後須買受人當場於客顯親簽，且開立後不可中止。' : ''}${
        shortfallResolution ? `\n應補繳 ${money(shortfall)}：${SHORTFALL_RESOLUTION_LABEL[shortfallResolution]}` : ''
      }`,
    );
    if (!ok) {
      refundInFlightRef.current = false;
      setBusy(false);
      return;
    }
    try {
      const key = idempotencyKeyRef.current;
      const res =
        choice.action === 'TOPUP_CANCEL'
          ? await executeTopupCancel(choice.sub.id, { quoteToken: preview.quoteToken, reason: reason.trim(), buyerEmail }, key)
          : await executeSubOrderRefund(
              choice.sub.id,
              {
                quoteToken: preview.quoteToken,
                scope,
                items: scope === 'ITEMS' ? items : undefined,
                reason: reason.trim(),
                buyerEmail,
                clause: policyClause,
                overrideFeeAmount,
                ...(shortfallResolution ? { shortfallResolution, shortfallNote } : {}),
              },
              key,
            );
      if (res.data) {
        setRecord(res.data);
        onDone?.(res.data);
      }
      toast(
        res.message || '已送出退費',
        res.code === 'PARTIAL_INVOICE' || res.data?.replayed ? 'info' : 'success',
      );
    } catch (err) {
      setExecError(describeRefundError(err, '退費失敗'));
      void runPreview();
    } finally {
      refundInFlightRef.current = false;
      setBusy(false);
    }
  }

  const title = record ? `退費單 ${record.id}` : choice ? `退費 · ${choice.sub.id}` : '退費';
  const canSwitchToRefund =
    choice?.action === 'TOPUP_CANCEL' &&
    previewError?.code === 'WALLET_INSUFFICIENT_FOR_VOID' &&
    choice.sub.actions.includes('SUB_ORDER_REFUND');

  return (
    <Modal open={open} title={title} onClose={onClose} closeOnBackdrop={false} wide>
      {record ? (
        <RefundRecordView refund={record} onChange={(r) => { setRecord(r); onDone?.(r); }} />
      ) : lookupError ? (
        <RefundErrorAlert error={lookupError} />
      ) : !lookup ? (
        <p className="text-sm text-muted">查詢中…</p>
      ) : (
        <div className="form-stack">
          {lookup.member && (
            <p className="text-sm" style={{ margin: 0 }}>
              會員：{lookup.member.name}（{lookup.member.memberNo || `#${lookup.member.id}`}）
              {lookup.checkoutSessionId ? <span className="text-muted">｜母單 {lookup.checkoutSessionId}</span> : null}
            </p>
          )}
          {lookup.openRefunds.length > 0 && (
            <Alert tone="warning">
              有處理中之退費單：{lookup.openRefunds.map((r) => `${r.id}（${r.refId}）`).join('、')}，請至「退費／折讓」續辦。
            </Alert>
          )}
          {lookup.sharedInvoices.length > 0 && (
            <Alert tone="info">
              此母單含舊制合併發票（{lookup.sharedInvoices.map((i) => i.invoiceNumber || '未配號').join('、')}）：只能逐子單折讓，不可整張作廢。
            </Alert>
          )}

          {!choice || lookup.subOrders.length > 1 ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>子單</th>
                    <th>類型</th>
                    <th>金額／已退</th>
                    <th>狀態</th>
                    <th>ezPay 發票</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lookup.subOrders.map((s) => (
                    <tr key={s.id} style={choice?.sub.id === s.id ? { background: 'var(--brand-soft)' } : undefined}>
                      <td className="mono text-sm">{s.id}</td>
                      <td>{ORDER_KIND_LABEL[s.kind] || s.kind}</td>
                      <td>
                        {money(s.amount)}
                        {s.refundedAmount > 0 ? ` / ${money(s.refundedAmount)}` : ''}
                      </td>
                      <td>{s.status}</td>
                      <td>
                        <InvoiceChips invoices={s.invoices} />
                      </td>
                      <td>
                        <div className="btn-row">
                          {s.actions.length === 0 && <span className="text-muted text-sm">不可退</span>}
                          {s.actions.map((a) =>
                            a === 'TOPUP_CANCEL' || a === 'SUB_ORDER_REFUND' ? (
                              <Button
                                key={a}
                                size="sm"
                                variant={choice?.sub.id === s.id && choice.action === a ? 'primary' : 'secondary'}
                                disabled={busy}
                                onClick={() => pick(s, a)}
                              >
                                {ACTION_LABEL[a]}
                              </Button>
                            ) : (
                              <span key={a} className="text-muted text-sm">{ACTION_LABEL[a]}</span>
                            ),
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="btn-row" style={{ alignItems: 'center' }}>
              <span className="mono text-sm">{choice.sub.id}</span>
              <span className="text-sm">{ORDER_KIND_LABEL[choice.sub.kind] || choice.sub.kind}</span>
              <InvoiceChips invoices={choice.sub.invoices} />
            </div>
          )}

          {choice && (
            <>
              {choice.action === 'SUB_ORDER_REFUND' && scopeOptions(choice.sub.kind).length > 1 && (
                <Field label="退費範圍">
                  <Select value={scope} disabled={busy} onChange={(e) => setScope(e.target.value as RefundScope)}>
                    {scopeOptions(choice.sub.kind).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                </Field>
              )}
              {choice.action === 'TOPUP_CANCEL' && (
                <p className="text-sm text-muted" style={{ margin: 0 }}>
                  原單取消須會員錢包仍完整保有本次儲值之本金與運動金；已動用者請改「子單退費（未使用退費）」。
                </p>
              )}
              {choice.action === 'SUB_ORDER_REFUND' && choice.sub.kind !== 'SALE' && (
                <p className="text-sm text-muted" style={{ margin: 0 }}>
                  金額依定型化契約第八～十條由後端試算（儲值手續費 $100；月卡半月制、手續費 $500；課程違約金 20% 上限 $9,000；贈送運動金扣抵），櫃檯只能選條款或調降手續費，不可改金額。
                </p>
              )}
              {feePolicyEnabled && (
                <div className="btn-row" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
                  <Field label="終止條款">
                    <Select
                      value={clause}
                      disabled={busy}
                      onChange={(e) => setClause(e.target.value as RefundTerminationClause)}
                    >
                      {CLAUSE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </Select>
                  </Field>
                  {clause === 'VOLUNTARY' && (
                    <Field
                      label="調降手續費（選填）"
                      hint={preview && previewCurrent ? `0 ～ ${money(preview.feeMax)}；留空依契約上限` : '留空依契約上限'}
                    >
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1}
                        value={feeInput}
                        disabled={busy}
                        onChange={(e) => setFeeInput(e.target.value)}
                        style={{ maxWidth: 140 }}
                      />
                    </Field>
                  )}
                </div>
              )}
              {feeInvalid && <Alert tone="warning">手續費須為 0 以上之整數。</Alert>}
              {feePolicyEnabled && clause === 'EXEMPT' && (
                <Alert tone="info">第十四條免手續費須於退費原因註明事由（受傷、懷孕、遷居或教練無法履約且不接受更換），並留存證明文件。</Alert>
              )}
              {choice.action === 'SUB_ORDER_REFUND' && scope === 'ITEMS' && choice.sub.items && (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr><th>退</th><th>品項</th><th>單價</th><th>已售／已退</th><th>本次退貨數量</th></tr>
                    </thead>
                    <tbody>
                      {choice.sub.items.map((it) => {
                        const left = it.qty - it.refundedQty;
                        const cur = qty[it.orderItemId] ?? 0;
                        return (
                          <tr key={it.orderItemId}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`退貨 ${it.name}`}
                                disabled={left <= 0 || busy}
                                checked={cur > 0}
                                onChange={(e) =>
                                  setQty((prev) => ({ ...prev, [it.orderItemId]: e.target.checked ? left : 0 }))
                                }
                                style={{ width: 20, height: 20 }}
                              />
                            </td>
                            <td>{it.name}</td>
                            <td>{money(it.unitPrice)}</td>
                            <td>{it.qty} / {it.refundedQty}</td>
                            <td>
                              <Input
                                type="number"
                                min={0}
                                max={left}
                                step={1}
                                disabled={left <= 0 || cur <= 0 || busy}
                                value={cur}
                                onChange={(e) => {
                                  const v = Math.max(0, Math.min(left, Math.floor(Number(e.target.value) || 0)));
                                  setQty((prev) => ({ ...prev, [it.orderItemId]: v }));
                                }}
                                style={{ maxWidth: 96 }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {needItems && <Alert tone="info">請勾選退貨品項並確認數量，系統將依原發票稅別試算折讓金額。</Alert>}

              <RefundErrorAlert error={previewError}>
                {canSwitchToRefund ? (
                  <Button size="sm" onClick={() => pick(choice.sub, 'SUB_ORDER_REFUND')}>
                    改用子單退費（未使用退費）
                  </Button>
                ) : null}
              </RefundErrorAlert>

              {preview && (
                <div className="card card--default card--pad-md form-stack">
                  <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                    <strong>實退 {money(preview.payoutAmount)}</strong>
                    <span className="text-sm text-muted">
                      應退 {money(preview.grossAmount)}
                      {preview.feeAmount > 0 ? ` · 手續費 ${money(preview.feeAmount)}` : ''}
                      {preview.consumedValue > 0 ? ` · 已使用 ${money(preview.consumedValue)}` : ''}
                    </span>
                  </div>
                  {preview.calc?.note ? <p className="text-sm" style={{ margin: 0 }}>{String(preview.calc.note)}</p> : null}
                  {preview.orderKind !== 'SALE' && preview.kind !== 'TOPUP_VOID' && (
                    <BreakdownTable preview={preview} contractTotal={choice.sub.amount} />
                  )}
                  <ul className="text-sm" style={{ margin: 0, paddingLeft: '1.2em' }}>
                    {preview.legs.map((l) => (
                      <li key={l.method}>
                        {REFUND_METHOD_LABEL[l.method] || l.method}：{money(l.amount)}
                        {l.forfeited ? '（註銷，不退現）' : ''}
                        {!l.ready ? '（查無原交易序號，將需改臨櫃現金）' : ''}
                        {l.needsTerminal ? '（須至乙禾端末刷退，完成後回填 RRN／授權碼）' : ''}
                      </li>
                    ))}
                  </ul>
                  <div className="text-sm">
                    發票：<strong>{INVOICE_ACTION_LABEL[preview.invoicePlan.action] || preview.invoicePlan.action}</strong>
                    {preview.invoicePlan.invoices
                      .filter((i) => i.invoiceNumber)
                      .map((i) => (
                        <span key={i.id} className="mono">
                          {' '}· {i.invoiceNumber}
                          {i.category === 'B2B' ? '（B2B）' : ''}
                          {i.action ? `→${INVOICE_ACTION_LABEL[i.action] || i.action}` : ''}
                        </span>
                      ))}
                  </div>
                  {preview.signatureRequired && (
                    <Alert tone="warning">
                      此單據開立折讓後須由買受人當場於客顯親簽，且開立後不可中止。請先開啟副螢幕客顯並確認顧客在場。
                    </Alert>
                  )}
                  {preview.calc?.medicalSuspension?.exemptEligible && (
                    <Alert tone="info">
                      會員因傷病暫停累計 {preview.calc.medicalSuspension.days} 日（已滿六個月），依契約第十二條末款終止不得收取手續費，後端已將手續費鎖定為 $0。
                    </Alert>
                  )}
                  {preview.isContractExpired && (
                    <Alert tone="error">
                      ⚠️ 本課程已逾契約效期（單堂 10 日，到期日 {twDate(preview.contractExpiresAt)}）。依紙本契約原則不予退費，若需專案退費須由值班主管（DUTY+）核准。
                    </Alert>
                  )}
                  {shortfall > 0 && (
                    <Alert tone="error">
                      ⚠️ 學員上課進度超前，扣除已繳分期款後尚須臨櫃補繳差額 {money(shortfall)}。須選擇處置方式，否則不會停止續扣或終止合約。
                      {(Object.keys(SHORTFALL_RESOLUTION_LABEL) as ShortfallResolution[]).map((r) => (
                        <label key={r} className="text-sm" style={{ display: 'block', marginTop: 8 }}>
                          <input
                            type="radio"
                            name="shortfallResolution"
                            checked={shortfallResolution === r}
                            disabled={busy}
                            onChange={() => setShortfallChoice({ amount: shortfall, resolution: r })}
                          />{' '}
                          {r === 'PAID_AT_POS'
                            ? `已於 POS 臨櫃收訖補繳差額 ${money(shortfall)}`
                            : `學員未當場繳清，由主管核准立案追償（列入欠款黑名單，清償後由門市解除；不影響已付費之入場）`}
                        </label>
                      ))}
                      {shortfallResolution && (
                        <Field label={shortfallResolution === 'PAID_AT_POS' ? 'POS 收款單號或收訖說明（必填）' : '追償備註（選填）'}>
                          <Input
                            value={shortfallNote}
                            maxLength={200}
                            disabled={busy}
                            onChange={(e) => setShortfallNote(e.target.value)}
                          />
                        </Field>
                      )}
                    </Alert>
                  )}
                  {preview.warnings
                    .filter((w) => !CONTRACT_ALERT_PREFIXES.some((p) => w.startsWith(p)))
                    .map((w) => (
                      <Alert key={w} tone="info">{w}</Alert>
                    ))}
                </div>
              )}

              <Field label="退費原因（必填）">
                <Input value={reason} maxLength={200} disabled={busy} onChange={(e) => setReason(e.target.value)} placeholder="例：商品瑕疵、顧客反悔（7 日內）" />
              </Field>
              <Field label="買受人 Email（選填）" hint="ezPay 折讓通知寄送">
                <Input type="email" value={buyerEmail} maxLength={50} disabled={busy} onChange={(e) => setBuyerEmail(e.target.value)} />
              </Field>
              <RefundErrorAlert error={execError} onDismiss={() => setExecError(null)} />
              <div className="btn-row">
                <Button
                  variant="danger"
                  loading={busy}
                  disabled={busy || !previewCurrent || !reason.trim() || shortfallBlocked}
                  onClick={() => void execute()}
                >
                  {choice.action === 'TOPUP_CANCEL' ? '確認取消' : choice.sub.kind === 'SALE' && scope === 'ITEMS' ? '送出退貨／折讓' : '確認退費'}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
