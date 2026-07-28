import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, Field, Input, Modal, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  cancelOpsCardSubscription,
  fetchCoursePurchasesReport,
  fetchGateReport,
  fetchOrdersReport,
  fetchSalesReport,
  fetchTopupReport,
  getErrorMessage,
  opsCancelGate,
  opsCancelPtPurchase,
  opsCancelSale,
  opsRefund,
  type ReportPayload,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import { defaultReportRange, downloadCsv } from '../../../lib/csvExport';
import { formatGateAccessNo } from '../../../lib/gateAccessNo';
import { printAllowanceSlip, type AllowanceSlip } from '../../../lib/printAllowanceSlip';
import type { Branch } from '../../../types/api';

type ReportKind = 'orders' | 'topup' | 'gate' | 'sales' | 'coursePurchases';

/** 一般報表內的子類型（訂單查詢已上拉至交易異動頂層） */
const REPORT_KINDS: { key: Exclude<ReportKind, 'orders'>; label: string }[] = [
  { key: 'topup', label: '儲值報表' },
  { key: 'gate', label: '進出場報表' },
  { key: 'sales', label: '商品銷售報表' },
  { key: 'coursePurchases', label: '課程購買報表' },
];

function gateAccessLabel(r: Record<string, unknown>) {
  if (r.gateAccessNo) return String(r.gateAccessNo);
  return formatGateAccessNo(
    r.checkInAt != null ? String(r.checkInAt) : null,
    r.gateLogId ?? r.id,
  );
}

function fmtDt(v: unknown) {
  if (!v) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('zh-TW');
}

function fmtMoney(v: unknown) {
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return `$${n.toLocaleString('zh-TW')}`;
}

function payLabel(method: unknown, breakdown: unknown) {
  if (breakdown && typeof breakdown === 'object') {
    const parts = Object.entries(breakdown as Record<string, number>)
      .filter(([, amt]) => Number(amt) > 0)
      .map(([m, amt]) => `${m}:$${amt}`);
    if (parts.length) return parts.join(' + ');
  }
  return method ? String(method) : '—';
}

function cardModeLabel(r: Record<string, unknown>) {
  const mode = String(r.cardMode || '').toUpperCase();
  if (mode === 'INSTALLMENT') {
    return r.cardInst ? `分期 ${r.cardInst} 期` : '分期';
  }
  if (mode === 'RECURRING') {
    const pt = String(r.periodType || 'M').toUpperCase();
    const cycle = pt === 'W' ? '週' : pt === 'Y' ? '年' : '月';
    const times = r.periodTimes != null ? Number(r.periodTimes) : null;
    const timesText = times === 0 ? '不限' : times != null ? `${times} 期` : '';
    const amt =
      r.recurringAmount != null && Number(r.recurringAmount) > 0
        ? ` · 期付 $${Number(r.recurringAmount)}`
        : '';
    return `定期定額（每${cycle}${timesText ? ` · ${timesText}` : ''}${amt}）`;
  }
  if (mode === 'LUMP' || !mode) return '一次付清';
  return mode;
}

/** @returns 折讓單據號碼；無則 null */
function tryPrintAllowanceSlip(result: { data?: unknown; message?: string }): string | null {
  const slip = (result.data as { allowanceSlip?: AllowanceSlip | null } | undefined)
    ?.allowanceSlip;
  if (!slip?.allowanceNo) return null;
  try {
    printAllowanceSlip(slip);
  } catch {
    // 列印失敗仍回傳單號，由呼叫端 toast 提示查詢
  }
  return slip.allowanceNo;
}

function toastRefundDone(
  toastFn: (m: string, t?: 'success' | 'error' | 'info') => void,
  result: { data?: unknown; message?: string },
  fallback: string,
) {
  const no = tryPrintAllowanceSlip(result);
  toastFn(
    no
      ? `${result.message || fallback} · 折讓單據號碼 ${no}`
      : result.message || fallback,
    'success',
  );
}

function txnStatusText(r: Record<string, unknown>) {
  if (r.txnStatus) return String(r.txnStatus);
  const s = String(r.status ?? '').toUpperCase();
  if (s === 'PAID' || s === 'ACTIVE') return '成功';
  if (s === 'CANCELLED') return '沖回';
  if (s === 'REFUNDED') return '退費';
  if (s === 'PENDING') return '待付款';
  if (s === 'FAILED') return '失敗';
  return s || '—';
}

function dash(v: unknown) {
  if (v === undefined || v === null || v === '') return '—';
  return String(v);
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="bind-row" style={{ gap: '0.75rem', alignItems: 'flex-start' }}>
      <span className="text-muted" style={{ minWidth: 112, flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ flex: 1, wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

/** 報表／列表顯示用會員編號 */
function memberNoLabel(r: Record<string, unknown>) {
  if (r.memberNo) return String(r.memberNo);
  if (r.memberId != null && r.memberId !== '') return `#${String(r.memberId)}`;
  return '—';
}

function rowIsFinal(r: Record<string, unknown>) {
  const s = String(r.status ?? '').toUpperCase();
  return s === 'CANCELLED' || s === 'REFUNDED' || s === 'FAILED';
}

function ActionCell({ children }: { children: ReactNode }) {
  return (
    <td style={{ whiteSpace: 'nowrap' }}>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {children}
      </div>
    </td>
  );
}

type Props = {
  branches: Branch[];
  /** 由父層（交易異動）控制時傳入 */
  branchId?: number | '';
  onBranchIdChange?: (id: number | '') => void;
  /** 父層已顯示分店列時隱藏表單內分店欄 */
  hideBranchField?: boolean;
  /** 鎖定單一報表類型（訂單查詢頂層用） */
  fixedKind?: ReportKind;
  pageTitle?: string;
  pageDesc?: string;
};

export default function HqReportsTab({
  branches,
  branchId: branchIdProp,
  onBranchIdChange,
  hideBranchField = false,
  fixedKind,
  pageTitle,
  pageDesc,
}: Props) {
  const { toast } = useToast();
  const range = defaultReportRange();
  const [kindDraft, setKindDraft] = useState<ReportKind>(fixedKind || 'topup');
  const kind = fixedKind ?? kindDraft;
  const setKind = setKindDraft;
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(fixedKind === 'orders' ? 'ALL' : 'PAID');
  const [branchIdLocal, setBranchIdLocal] = useState<number | ''>('');
  const branchControlled = branchIdProp !== undefined;
  const branchId = branchControlled ? branchIdProp : branchIdLocal;
  const setBranchId = onBranchIdChange || setBranchIdLocal;
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<ReportPayload<Record<string, unknown>> | null>(null);
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);

  const runQuery = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        from: from || undefined,
        to: to || undefined,
        q: q.trim() || undefined,
        status:
          kind === 'topup' || kind === 'sales' || kind === 'orders' || kind === 'coursePurchases'
            ? status || undefined
            : undefined,
        branchId: branchId ? Number(branchId) : undefined,
      };
      let res;
      if (kind === 'orders') res = await fetchOrdersReport(params);
      else if (kind === 'topup') res = await fetchTopupReport(params);
      else if (kind === 'gate') res = await fetchGateReport(params);
      else if (kind === 'coursePurchases') res = await fetchCoursePurchasesReport(params);
      else res = await fetchSalesReport(params);

      if (res.status === 'success' && res.data) {
        setPayload(res.data);
      } else {
        setPayload(null);
        toast(res.message || '查詢失敗', 'error');
      }
    } catch (err) {
      setPayload(null);
      toast(getErrorMessage(err, '查詢報表失敗'), 'error');
    } finally {
      setLoading(false);
    }
  }, [kind, from, to, q, status, branchId, toast]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const params = {
          from: from || undefined,
          to: to || undefined,
          q: q.trim() || undefined,
          status:
            kind === 'topup' || kind === 'sales' || kind === 'orders' || kind === 'coursePurchases'
              ? status || undefined
              : undefined,
          branchId: branchId ? Number(branchId) : undefined,
        };
        let res;
        if (kind === 'orders') res = await fetchOrdersReport(params);
        else if (kind === 'topup') res = await fetchTopupReport(params);
        else if (kind === 'gate') res = await fetchGateReport(params);
        else if (kind === 'coursePurchases') res = await fetchCoursePurchasesReport(params);
        else res = await fetchSalesReport(params);

        if (cancelled) return;
        if (res.status === 'success' && res.data) {
          setPayload(res.data);
        } else {
          setPayload(null);
          toast(res.message || '查詢失敗', 'error');
        }
      } catch (err) {
        if (cancelled) return;
        setPayload(null);
        toast(getErrorMessage(err, '查詢報表失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 切換報表類型／分店時自動查
  }, [kind, branchId]);

  const actionInFlight = useRef(false);

  const withRowAction = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      if (actionInFlight.current) return;
      actionInFlight.current = true;
      setActionBusyKey(key);
      try {
        await fn();
        await runQuery();
      } finally {
        actionInFlight.current = false;
        setActionBusyKey(null);
      }
    },
    [runQuery],
  );

  async function onTopupCancel(r: Record<string, unknown>) {
    const orderId = String(r.orderId || '').trim();
    if (!orderId) return;
    const isUnlimited = String(r.usageType || '').toUpperCase() === 'UNLIMITED';
    const isRecurring = String(r.cardMode || '').toUpperCase() === 'RECURRING';
    if (
      !window.confirm(
        isUnlimited && !isRecurring
          ? `確定取消沖回月卡購案 ${orderId}？\n將截斷效期並降為計時（不開折讓）；若要按未使用天數折讓請用「退費折讓」。`
          : `確定取消沖回訂閱／月卡相關單號 ${orderId}？\n（定期定額將停續扣並保留效期；計時儲值請改用退費折讓）`,
      )
    )
      return;
    await withRowAction(`topup-cancel-${orderId}`, async () => {
      try {
        const result = await cancelOpsCardSubscription(orderId, {
          expirePolicy: isUnlimited && !isRecurring ? 'CUT_NO_ALLOWANCE' : 'KEEP',
          settle: true,
          doAllowance: false,
        });
        toast(result.message || '已取消', 'success');
      } catch (err) {
        toast(getErrorMessage(err, '取消沖回失敗（計時儲值請改用退費折讓）'), 'error');
      }
    });
  }

  async function onTopupRefund(r: Record<string, unknown>) {
    const orderId = String(r.orderId || '').trim();
    if (!orderId) return;
    const isUnlimited = String(r.usageType || '').toUpperCase() === 'UNLIMITED';
    if (isUnlimited) {
      if (
        !window.confirm(
          `確定對月卡 ${orderId} 執行退費折讓？將截斷效期，並依未使用天數開立 ezPay 折讓。`,
        )
      )
        return;
      await withRowAction(`topup-refund-${orderId}`, async () => {
        try {
          const result = await cancelOpsCardSubscription(orderId, {
            expirePolicy: 'CUT_UNUSED',
            doAllowance: true,
            settle: true,
          });
          toastRefundDone(toast, result, '月卡退費折讓完成');
        } catch (err) {
          toast(getErrorMessage(err, '退費折讓失敗'), 'error');
        }
      });
      return;
    }
    if (
      !window.confirm(
        `確定對 ${orderId} 執行退費折讓？將回收運動金並對已開立發票開立 ezPay 折讓。`,
      )
    )
      return;
    await withRowAction(`topup-refund-${orderId}`, async () => {
      try {
        const result = await opsRefund(orderId, {
          invoiceNumber: r.invoiceNumber ? String(r.invoiceNumber) : undefined,
        });
        toastRefundDone(toast, result, '退費折讓完成');
      } catch (err) {
        toast(getErrorMessage(err, '退費折讓失敗'), 'error');
      }
    });
  }

  async function onSaleCancel(r: Record<string, unknown>) {
    const saleId = String(r.saleId || '').trim();
    if (!saleId) return;
    if (
      !window.confirm(
        `確定取消沖回銷貨 ${saleId}？將回補庫存、退回零錢包；有發票時會作廢或折讓。`,
      )
    )
      return;
    await withRowAction(`sale-cancel-${saleId}`, async () => {
      try {
        const result = await opsCancelSale(saleId, '報表取消沖回', { prefer: 'void' });
        toast(result.message || '銷貨已取消', 'success');
      } catch (err) {
        toast(getErrorMessage(err, '取消沖回失敗'), 'error');
      }
    });
  }

  async function onSaleRefund(r: Record<string, unknown>) {
    const saleId = String(r.saleId || '').trim();
    if (!saleId) return;
    if (
      !window.confirm(
        `確定對銷貨 ${saleId} 執行退費折讓取消？將回補庫存並優先以發票折讓／作廢處理。`,
      )
    )
      return;
    await withRowAction(`sale-refund-${saleId}`, async () => {
      try {
        const result = await opsCancelSale(saleId, '報表退費折讓', { prefer: 'allowance' });
        toastRefundDone(toast, result, '銷貨已取消（折讓／作廢）');
      } catch (err) {
        toast(getErrorMessage(err, '退費折讓失敗'), 'error');
      }
    });
  }

  async function onCourseCancel(r: Record<string, unknown>, prefer: 'void' | 'allowance') {
    const checkoutId = r.checkoutId ? String(r.checkoutId).trim() : '';
    const orderId = r.orderId ? String(r.orderId).trim() : '';
    if (!checkoutId && !orderId) {
      toast('缺少結帳／訂單編號', 'error');
      return;
    }
    const label = prefer === 'allowance' ? '退費折讓' : '取消沖回';
    // 優先單筆 orderId，避免 CHK 一次取消所有私教腿
    const ref = orderId || checkoutId;
    if (
      !window.confirm(
        `確定對 ${ref} 執行${label}？\n` +
          (prefer === 'allowance'
            ? '將以發票折讓處理並停用未使用私教合約。'
            : '將作廢／沖回發票並停用未使用私教合約。'),
      )
    )
      return;
    await withRowAction(`course-${prefer}-${ref}`, async () => {
      try {
        const result = await opsCancelPtPurchase({
          ...(orderId ? { orderId } : { checkoutId }),
          prefer,
          reason: `報表${label}`,
        });
        if (prefer === 'allowance') {
          toastRefundDone(toast, result, `私教購案已${label}`);
        } else {
          toast(result.message || `私教購案已${label}`, 'success');
        }
      } catch (err) {
        toast(getErrorMessage(err, `${label}失敗`), 'error');
      }
    });
  }

  async function onGateCancel(r: Record<string, unknown>) {
    const logId = r.gateLogId ?? r.id;
    if (logId == null || logId === '') return;
    const accessNo = gateAccessLabel(r);
    if (!window.confirm(`確定取消沖回進出場單號 ${accessNo}？已出場費用將退回零錢包。`)) return;
    await withRowAction(`gate-cancel-${logId}`, async () => {
      try {
        const result = await opsCancelGate(logId, '報表取消沖回');
        toast(result.message || '進出場已取消', 'success');
      } catch (err) {
        toast(getErrorMessage(err, '取消沖回失敗'), 'error');
      }
    });
  }

  function handleExport() {
    if (!payload?.rows?.length) {
      toast('沒有可輸出的資料', 'error');
      return;
    }
    const stamp = `${from || 'all'}_${to || 'all'}`;
    if (kind === 'orders') {
      downloadCsv(
        `訂單查詢_${stamp}`,
        ['日期時間', '狀態', '發票號碼', '訂單總額', '載具', '公司統編', '捐贈碼', '訂單編號'],
        payload.rows.map((r) => [
          fmtDt(r.createdAt),
          txnStatusText(r),
          String(r.invoiceNumber ?? ''),
          Number(r.amount) || 0,
          String(r.carrierNum ?? ''),
          String(r.buyerUbn ?? ''),
          String(r.loveCode ?? ''),
          String(r.orderId ?? ''),
        ]),
      );
    } else if (kind === 'topup') {
      downloadCsv(
        `儲值報表_${stamp}`,
        [
          '訂單編號',
          '時間',
          '會員編號',
          '會員姓名',
          '方案',
          '金額',
          '交易狀態',
          '發票號碼',
          '發票載具',
          '公司統編',
          '捐贈碼',
        ],
        payload.rows.map((r) => [
          String(r.orderId ?? ''),
          fmtDt(r.createdAt),
          memberNoLabel(r),
          String(r.memberName ?? ''),
          String(r.planName ?? ''),
          Number(r.amount) || 0,
          txnStatusText(r),
          String(r.invoiceNumber ?? ''),
          String(r.carrierNum ?? ''),
          String(r.buyerUbn ?? ''),
          String(r.loveCode ?? ''),
        ]),
      );
    } else if (kind === 'gate') {
      downloadCsv(
        `進出場報表_${stamp}`,
        [
          '進出場單號',
          '分店',
          '會員編號',
          '會員姓名',
          '電話',
          '方案',
          '計費',
          '進場',
          '出場',
          '費用',
          '交易狀態',
          '仍在場',
        ],
        payload.rows.map((r) => [
          gateAccessLabel(r),
          String(r.branchName ?? ''),
          memberNoLabel(r),
          String(r.memberName ?? ''),
          String(r.memberPhone ?? ''),
          String(r.plan ?? ''),
          String(r.billingMode ?? ''),
          fmtDt(r.checkInAt),
          fmtDt(r.checkOutAt),
          Number(r.fee) || 0,
          txnStatusText(r),
          r.inVenue ? 'Y' : 'N',
        ]),
      );
    } else if (kind === 'coursePurchases') {
      downloadCsv(
        `課程購買報表_${stamp}`,
        [
          '結帳編號',
          '時間',
          '分店',
          '會員編號',
          '會員姓名',
          '教練',
          '課程方案',
          '份數',
          '堂數',
          '金額',
          '付款',
          '交易狀態',
          '發票號碼',
          '備註',
        ],
        payload.rows.map((r) => [
          String(r.checkoutId ?? r.orderId ?? ''),
          fmtDt(r.createdAt),
          String(r.branchName ?? ''),
          memberNoLabel(r),
          String(r.memberName ?? ''),
          String(r.trainerName ?? ''),
          String(r.planName ?? ''),
          Number(r.qty) || 0,
          Number(r.totalSessions) || 0,
          Number(r.amount) || 0,
          payLabel(r.payMethod, r.payBreakdown),
          txnStatusText(r),
          String(r.invoiceNumber ?? ''),
          String(r.notes ?? ''),
        ]),
      );
    } else {
      downloadCsv(
        `商品銷售報表_${stamp}`,
        [
          '銷貨單號',
          '時間',
          '分店',
          '會員編號',
          '會員姓名',
          '金額',
          '付款',
          '交易狀態',
          '發票號碼',
          '發票載具',
          '公司統編',
          '捐贈碼',
          '品項',
        ],
        payload.rows.map((r) => [
          String(r.saleId ?? ''),
          fmtDt(r.createdAt),
          String(r.branchName ?? ''),
          memberNoLabel(r),
          String(r.memberName ?? ''),
          Number(r.amount) || 0,
          payLabel(r.payMethod, r.payBreakdown),
          txnStatusText(r),
          String(r.invoiceNumber ?? ''),
          String(r.carrierNum ?? ''),
          String(r.buyerUbn ?? ''),
          String(r.loveCode ?? ''),
          String(r.itemDesc ?? ''),
        ]),
      );
    }
    toast('CSV 已下載', 'success');
  }

  const summary = payload?.summary;
  const rows = payload?.rows ?? [];
  const emptyColSpan =
    kind === 'orders'
      ? 8
      : kind === 'topup'
        ? 12
        : kind === 'gate'
          ? 12
          : kind === 'coursePurchases'
            ? 14
            : 14;
  const sectionTitle =
    pageTitle || (fixedKind === 'orders' ? '訂單查詢' : '一般報表');
  const sectionDesc =
    pageDesc ||
    (fixedKind === 'orders'
      ? '依分店查詢合併結帳／獨立訂單 · 明細與 CSV（最多 1000 筆）'
      : '明細列表查詢與 CSV 輸出（最多 1000 筆）');

  return (
    <PageSection title={sectionTitle} desc={sectionDesc}>
      {!fixedKind ? (
        <div className="hq-tabs" role="tablist" aria-label="一般報表類型" style={{ marginBottom: '1rem' }}>
          {REPORT_KINDS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={kind === item.key}
              className={`hq-tabs__btn ${kind === item.key ? 'is-active' : ''}`}
              onClick={() => {
                setLoading(true);
                setKind(item.key);
                setDetailRow(null);
                if (item.key === 'topup') setStatus('PAID');
                else if (item.key === 'sales' || item.key === 'coursePurchases') setStatus('ALL');
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      <Card title="查詢條件">
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void runQuery();
          }}
          style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
        >
          <Field label="起日">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="迄日">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="關鍵字">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={
                kind === 'gate'
                  ? 'ACC單號／姓名／電話'
                  : kind === 'sales'
                    ? '銷貨單號／品項／發票／載具'
                    : kind === 'coursePurchases'
                      ? '結帳編號／方案／教練／會員／發票'
                      : kind === 'orders'
                        ? '訂單／會員／發票／金流／說明'
                        : '訂單／會員／發票／載具'
              }
            />
          </Field>
          {(kind === 'topup' || kind === 'orders') && (
            <Field label="交易狀態">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                {kind === 'orders' && <option value="ALL">全部</option>}
                <option value="PAID">成功（已付款）</option>
                <option value="CANCELLED">沖回</option>
                <option value="REFUNDED">退費</option>
                <option value="PENDING">待付款</option>
                <option value="FAILED">失敗</option>
                {kind === 'topup' && <option value="ALL">全部</option>}
              </Select>
            </Field>
          )}
          {(kind === 'sales' || kind === 'coursePurchases') && (
            <Field label="交易狀態">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="ALL">全部（成功＋沖回＋退費）</option>
                <option value="PAID">成功</option>
                <option value="CANCELLED">沖回</option>
                <option value="REFUNDED">退費</option>
              </Select>
            </Field>
          )}
          {!hideBranchField && (
            <Field label="分店">
              <Select
                value={branchId === '' ? '' : String(branchId)}
                onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')}
              >
                <option value="">全部分店</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {staffBranchLabel(b)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem' }}>
            <Button type="submit" disabled={loading}>
              {loading ? '查詢中…' : '查詢'}
            </Button>
            <Button type="button" variant="secondary" onClick={handleExport} disabled={!rows.length}>
              輸出 CSV
            </Button>
          </div>
        </form>
      </Card>

      {summary && (
        <p className="text-muted" style={{ margin: '0.75rem 0' }}>
          {kind === 'orders' && (
            <>
              筆數 {summary.count ?? 0} · 成功 {summary.paidCount ?? 0} · 合計{' '}
              {fmtMoney(summary.totalAmount)} · 已付合計 {fmtMoney(summary.paidAmount)}
            </>
          )}
          {kind === 'topup' && (
            <>
              筆數 {summary.count ?? 0} · 合計 {fmtMoney(summary.totalAmount)}
            </>
          )}
          {kind === 'gate' && (
            <>
              筆數 {summary.count ?? 0} · 仍在場 {summary.stillIn ?? 0} · 費用合計{' '}
              {fmtMoney(summary.totalFee)}
            </>
          )}
          {kind === 'sales' && (
            <>
              單數 {summary.count ?? 0} · 合計 {fmtMoney(summary.totalAmount)} · 件數{' '}
              {summary.itemQty ?? 0}
            </>
          )}
          {kind === 'coursePurchases' && (
            <>
              筆數 {summary.count ?? 0} · 合計 {fmtMoney(summary.totalAmount)} · 堂數{' '}
              {summary.sessionsSold ?? 0} · 份數 {summary.qtySold ?? 0}
            </>
          )}
        </p>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            {kind === 'orders' && (
              <tr>
                <th>日期時間</th>
                <th>狀態</th>
                <th>發票號碼</th>
                <th>訂單總額</th>
                <th>載具</th>
                <th>公司統編</th>
                <th>捐贈碼</th>
                <th></th>
              </tr>
            )}
            {kind === 'topup' && (
              <tr>
                <th>訂單編號</th>
                <th>時間</th>
                <th>會員編號</th>
                <th>會員姓名</th>
                <th>方案</th>
                <th>金額</th>
                <th>交易狀態</th>
                <th>發票號碼</th>
                <th>發票載具</th>
                <th>公司統編</th>
                <th>捐贈碼</th>
                <th>異動</th>
              </tr>
            )}
            {kind === 'gate' && (
              <tr>
                <th>進出場單號</th>
                <th>分店</th>
                <th>進場</th>
                <th>出場</th>
                <th>會員編號</th>
                <th>會員姓名</th>
                <th>電話</th>
                <th>方案</th>
                <th>計費</th>
                <th>費用</th>
                <th>交易狀態</th>
                <th>異動</th>
              </tr>
            )}
            {kind === 'sales' && (
              <tr>
                <th>銷貨單號</th>
                <th>時間</th>
                <th>分店</th>
                <th>會員編號</th>
                <th>會員姓名</th>
                <th>金額</th>
                <th>付款</th>
                <th>交易狀態</th>
                <th>發票號碼</th>
                <th>發票載具</th>
                <th>公司統編</th>
                <th>捐贈碼</th>
                <th>品項</th>
                <th>異動</th>
              </tr>
            )}
            {kind === 'coursePurchases' && (
              <tr>
                <th>結帳編號</th>
                <th>時間</th>
                <th>分店</th>
                <th>會員編號</th>
                <th>會員姓名</th>
                <th>教練</th>
                <th>課程方案</th>
                <th>份數</th>
                <th>堂數</th>
                <th>金額</th>
                <th>付款</th>
                <th>交易狀態</th>
                <th>發票號碼</th>
                <th>異動</th>
              </tr>
            )}
          </thead>
          <tbody>
            {!rows.length && (
              <tr>
                <td colSpan={emptyColSpan} className="text-muted">
                  {loading ? '載入中…' : '無資料'}
                </td>
              </tr>
            )}
            {kind === 'orders' &&
              rows.map((r) => (
                <tr key={String(r.orderId)}>
                  <td className="mono text-sm">{fmtDt(r.createdAt)}</td>
                  <td>{txnStatusText(r)}</td>
                  <td className="mono text-sm">{dash(r.invoiceNumber)}</td>
                  <td>{fmtMoney(r.amount)}</td>
                  <td className="mono text-sm">{dash(r.carrierNum)}</td>
                  <td className="mono text-sm">{dash(r.buyerUbn)}</td>
                  <td className="mono text-sm">{dash(r.loveCode)}</td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => setDetailRow(r)}>
                      詳情
                    </Button>
                  </td>
                </tr>
              ))}
            {kind === 'topup' &&
              rows.map((r) => {
                const orderId = String(r.orderId ?? '');
                const busy = actionBusyKey === `topup-cancel-${orderId}` || actionBusyKey === `topup-refund-${orderId}`;
                const done = rowIsFinal(r);
                return (
                  <tr key={orderId}>
                    <td className="mono text-sm">{orderId}</td>
                    <td className="mono text-sm">{fmtDt(r.createdAt)}</td>
                    <td className="mono text-sm">{memberNoLabel(r)}</td>
                    <td>{String(r.memberName ?? '')}</td>
                    <td>{dash(r.planName)}</td>
                    <td>{fmtMoney(r.amount)}</td>
                    <td>{txnStatusText(r)}</td>
                    <td className="mono text-sm">{dash(r.invoiceNumber)}</td>
                    <td className="mono text-sm">{dash(r.carrierNum)}</td>
                    <td className="mono text-sm">{dash(r.buyerUbn)}</td>
                    <td className="mono text-sm">{dash(r.loveCode)}</td>
                    <ActionCell>
                      {(String(r.usageType || '').toUpperCase() === 'UNLIMITED' ||
                        String(r.cardMode || '').toUpperCase() === 'RECURRING') && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={done || Boolean(busy) || loading}
                          onClick={() => void onTopupCancel(r)}
                        >
                          取消沖回
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={done || Boolean(busy) || loading}
                        onClick={() => void onTopupRefund(r)}
                      >
                        退費折讓
                      </Button>
                    </ActionCell>
                  </tr>
                );
              })}
            {kind === 'gate' &&
              rows.map((r) => {
                const logId = String(r.gateLogId ?? r.id ?? '');
                const accessNo = gateAccessLabel(r);
                const busy = actionBusyKey === `gate-cancel-${logId}`;
                const done = rowIsFinal(r);
                return (
                  <tr key={logId}>
                    <td className="mono text-sm">{accessNo}</td>
                    <td>{dash(r.branchName)}</td>
                    <td className="mono text-sm">{fmtDt(r.checkInAt)}</td>
                    <td className="mono text-sm">{fmtDt(r.checkOutAt)}</td>
                    <td className="mono text-sm">{memberNoLabel(r)}</td>
                    <td>{String(r.memberName ?? '')}</td>
                    <td className="mono text-sm">{dash(r.memberPhone)}</td>
                    <td>{dash(r.plan)}</td>
                    <td>{dash(r.billingMode)}</td>
                    <td>{fmtMoney(r.fee)}</td>
                    <td>
                      {txnStatusText(r)}
                      {r.inVenue ? '（在場）' : ''}
                    </td>
                    <ActionCell>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={done || busy || loading}
                        onClick={() => void onGateCancel(r)}
                      >
                        取消沖回
                      </Button>
                    </ActionCell>
                  </tr>
                );
              })}
            {kind === 'sales' &&
              rows.map((r) => {
                const saleId = String(r.saleId ?? '');
                const busy =
                  actionBusyKey === `sale-cancel-${saleId}` ||
                  actionBusyKey === `sale-refund-${saleId}`;
                const done = rowIsFinal(r);
                return (
                  <tr key={saleId}>
                    <td className="mono text-sm">{saleId}</td>
                    <td className="mono text-sm">{fmtDt(r.createdAt)}</td>
                    <td>{dash(r.branchName)}</td>
                    <td className="mono text-sm">{memberNoLabel(r)}</td>
                    <td>{r.memberName ? String(r.memberName) : '—'}</td>
                    <td>{fmtMoney(r.amount)}</td>
                    <td className="text-sm">{payLabel(r.payMethod, r.payBreakdown)}</td>
                    <td>{txnStatusText(r)}</td>
                    <td className="mono text-sm">{dash(r.invoiceNumber)}</td>
                    <td className="mono text-sm">{dash(r.carrierNum)}</td>
                    <td className="mono text-sm">{dash(r.buyerUbn)}</td>
                    <td className="mono text-sm">{dash(r.loveCode)}</td>
                    <td className="text-sm">{dash(r.itemDesc)}</td>
                    <ActionCell>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={done || busy || loading}
                        onClick={() => void onSaleCancel(r)}
                      >
                        取消沖回
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={done || busy || loading}
                        onClick={() => void onSaleRefund(r)}
                      >
                        退費折讓
                      </Button>
                    </ActionCell>
                  </tr>
                );
              })}
            {kind === 'coursePurchases' &&
              rows.map((r) => {
                const rowKey = String(r.rowId ?? `${r.checkoutId}-${r.planName}`);
                const ref = String(r.checkoutId || r.orderId || rowKey);
                const busy =
                  actionBusyKey === `course-void-${ref}` ||
                  actionBusyKey === `course-allowance-${ref}`;
                const done = rowIsFinal(r);
                return (
                  <tr key={rowKey}>
                    <td className="mono text-sm">{dash(r.checkoutId || r.orderId)}</td>
                    <td className="mono text-sm">{fmtDt(r.createdAt)}</td>
                    <td>{dash(r.branchName)}</td>
                    <td className="mono text-sm">{memberNoLabel(r)}</td>
                    <td>{r.memberName ? String(r.memberName) : '—'}</td>
                    <td>{dash(r.trainerName)}</td>
                    <td>
                      {dash(r.planName)}
                      {r.notes ? (
                        <span className="text-muted text-sm"> · {String(r.notes)}</span>
                      ) : null}
                    </td>
                    <td>{Number(r.qty) || 0}</td>
                    <td>{r.totalSessions != null ? Number(r.totalSessions) : '—'}</td>
                    <td>{fmtMoney(r.amount)}</td>
                    <td className="text-sm">{payLabel(r.payMethod, r.payBreakdown)}</td>
                    <td>{txnStatusText(r)}</td>
                    <td className="mono text-sm">{dash(r.invoiceNumber)}</td>
                    <ActionCell>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={done || busy || loading}
                        onClick={() => void onCourseCancel(r, 'void')}
                      >
                        取消沖回
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={done || busy || loading}
                        onClick={() => void onCourseCancel(r, 'allowance')}
                      >
                        退費折讓
                      </Button>
                    </ActionCell>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <Modal
        open={Boolean(detailRow)}
        title={`交易詳情${detailRow?.orderId ? ` · ${String(detailRow.orderId)}` : ''}`}
        onClose={() => setDetailRow(null)}
        footer={
          <Button variant="secondary" onClick={() => setDetailRow(null)}>
            關閉
          </Button>
        }
      >
        {detailRow && (
          <div className="form-stack">
            <DetailRow label="交易編號" value={<span className="mono">{dash(detailRow.orderId)}</span>} />
            <DetailRow label="日期時間" value={fmtDt(detailRow.createdAt)} />
            <DetailRow label="類型" value={dash(detailRow.orderKind)} />
            <DetailRow label="交易狀態" value={txnStatusText(detailRow)} />
            <DetailRow label="會員編號" value={<span className="mono">{memberNoLabel(detailRow)}</span>} />
            <DetailRow label="會員姓名" value={dash(detailRow.memberName)} />
            <DetailRow label="電話" value={<span className="mono">{dash(detailRow.memberPhone)}</span>} />
            <DetailRow label="訂單總額" value={fmtMoney(detailRow.amount)} />
            <DetailRow label="刷卡金額" value={fmtMoney(detailRow.cardAmount)} />
            <DetailRow
              label="付款"
              value={payLabel(detailRow.payMethod, detailRow.payBreakdown)}
            />
            <DetailRow label="抵用券" value={<span className="mono">{dash(detailRow.voucherCode)}</span>} />
            <DetailRow label="刷卡模式" value={cardModeLabel(detailRow)} />
            <DetailRow label="發票號碼" value={<span className="mono">{dash(detailRow.invoiceNumber)}</span>} />
            <DetailRow label="載具" value={<span className="mono">{dash(detailRow.carrierNum)}</span>} />
            <DetailRow label="公司統編" value={<span className="mono">{dash(detailRow.buyerUbn)}</span>} />
            <DetailRow label="捐贈碼" value={<span className="mono">{dash(detailRow.loveCode)}</span>} />
            <DetailRow label="金流序號" value={<span className="mono">{dash(detailRow.merchantNo)}</span>} />
            {detailRow.saleOrderId ? (
              <DetailRow
                label="銷貨單號"
                value={<span className="mono">{dash(detailRow.saleOrderId)}</span>}
              />
            ) : null}
            {detailRow.promoOrderId && detailRow.promoOrderId !== detailRow.orderId ? (
              <DetailRow
                label="購案子單"
                value={<span className="mono">{dash(detailRow.promoOrderId)}</span>}
              />
            ) : null}

            <div className="form-stack" style={{ marginTop: '0.5rem' }}>
              <strong>品項明細</strong>
              {Array.isArray(detailRow.lines) && detailRow.lines.length > 0 ? (
                <ul className="info-list">
                  {(detailRow.lines as Record<string, unknown>[]).map((line, idx) => (
                    <li key={`${String(line.kind)}-${idx}`}>
                      <div className="bind-row" style={{ alignItems: 'flex-start', gap: '0.5rem' }}>
                        <span className="text-muted" style={{ minWidth: 72 }}>
                          {dash(line.kindLabel || line.kind)}
                        </span>
                        <span style={{ flex: 1 }}>
                          {dash(line.name)}
                          {Number(line.qty) > 1 ? ` ×${Number(line.qty)}` : ''}
                          {line.detail ? (
                            <span className="text-muted text-sm"> · {String(line.detail)}</span>
                          ) : null}
                        </span>
                        {line.lineTotal != null && line.lineTotal !== '' ? (
                          <span>{fmtMoney(line.lineTotal)}</span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">{dash(detailRow.itemSummary || detailRow.itemDesc)}</p>
              )}
            </div>
          </div>
        )}
      </Modal>
    </PageSection>
  );
}
