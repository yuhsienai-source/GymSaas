import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, PageSection, StatCard } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import {
  closeOpsShift,
  fetchOpsShiftCurrent,
  fetchOpsShiftHistory,
  fetchOpsYipayReconcile,
  getErrorMessage,
  openOpsShift,
} from '../../lib/api';
import {
  allChecklistDone,
  CLOSE_CHECKLIST,
  emptyChecklist,
  emptyDenomCounts,
  sumDenomCounts,
  type ChecklistState,
  type DenomCounts,
  CASH_DENOMINATIONS,
} from '../../lib/cashDenominations';
import { printShiftHandoverSlip } from '../../lib/printShiftHandoverSlip';
import { staffHasManagerRankOrAbove } from '../../lib/staffPermissions';
import { positionShortLabel } from '../../lib/orgStructure';
import type { Branch } from '../../types/api';

type Props = {
  branchId: number | '';
  branchName?: string | null;
  branches: Branch[];
};

type ShiftSlot = 'MORNING' | 'EVENING' | 'MIDDAY';
type CloseStep = 'summary' | 'count' | 'reconcile';

type SlotMeta = { key: ShiftSlot; label: string; short?: string; hint?: string };

type TodaySlot = {
  key: ShiftSlot;
  label: string;
  status: 'AVAILABLE' | 'OPEN' | 'CLOSED';
  shiftId: string | null;
};

type PayColumn = { key: string; label: string; amount: number };

type ShiftRow = {
  id: string;
  status: string;
  slot?: string | null;
  slotLabel?: string | null;
  startedAt: string;
  endedAt?: string | null;
  openingFloat: number;
  expectedCash?: number | null;
  countedCash?: number | null;
  variance?: number | null;
  openedByName: string;
  closedByName?: string | null;
  note?: string | null;
  payMixSnapshot?: Record<string, number> | null;
  payMixColumns?: PayColumn[];
  summarySnapshot?: {
    cashIn?: number;
    payMixColumns?: PayColumn[];
    cashDenominations?: { counts?: DenomCounts; total?: number } | null;
    totals?: LiveSummary['totals'];
    closeOperator?: { matchExpected?: boolean; variance?: number };
  } | null;
};

type LiveSummary = {
  cashIn: number;
  /** 本班臨櫃現金退款（已自系統應有現金扣除） */
  cashRefund?: number;
  payMix: Record<string, number>;
  payMixColumns?: PayColumn[];
  totals: {
    checkoutCount: number;
    checkoutAmount: number;
    salesCount: number;
    salesAmount: number;
    topupCount: number;
    topupAmount: number;
    paidTxnCount: number;
    paidTxnAmount: number;
  };
  refunds?: { count: number; cashOut?: number; note?: string };
  gateNote?: string;
};

type OpenPreview = {
  suggestedSlot: ShiftSlot;
  suggestedOpeningFloat: number;
  openingFloatSource: string;
  previousShiftId?: string | null;
  today?: { businessDate: string; slots: TodaySlot[] };
  slots?: SlotMeta[];
  payMethodColumns?: { key: string; label: string }[];
};

const FALLBACK_PAY_COLUMNS: { key: string; label: string }[] = [
  { key: 'CASH', label: '現金' },
  { key: 'YIPAY', label: '乙禾現場刷卡' },
  { key: 'CARD', label: 'PayUNi 刷卡／定期' },
  { key: 'LINEPAY', label: 'LinePay' },
  { key: 'WALLET_CASH', label: '零錢包' },
  { key: 'VOUCHER', label: '抵用券' },
];

const FALLBACK_SLOTS: SlotMeta[] = [
  { key: 'MORNING', label: '早班', hint: '07:00–15:30' },
  { key: 'EVENING', label: '晚班', hint: '15:30–00:00' },
];

const CLOSE_STEPS: { key: CloseStep; n: number; label: string }[] = [
  { key: 'summary', n: 1, label: '營業彙總' },
  { key: 'count', n: 2, label: '現金點鈔' },
  { key: 'reconcile', n: 3, label: '對帳簽核' },
];

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

function buildPayColumns(
  defs: { key: string; label: string }[],
  payMix?: Record<string, number> | null,
  existing?: PayColumn[] | null,
): PayColumn[] {
  if (existing?.length) return existing;
  const src = payMix && typeof payMix === 'object' ? payMix : {};
  const known = new Set(defs.map((d) => d.key));
  const rows = defs.map((d) => ({
    key: d.key,
    label: d.label,
    amount: Math.round(Number(src[d.key]) || 0),
  }));
  for (const [k, v] of Object.entries(src)) {
    if (known.has(k)) continue;
    const n = Math.round(Number(v) || 0);
    if (n === 0) continue;
    rows.push({ key: k, label: k, amount: n });
  }
  return rows;
}

function varianceMeta(v: number | null | undefined) {
  if (v == null || !Number.isFinite(Number(v))) {
    return { text: '—', tone: 'neutral' as const, label: '未對帳' };
  }
  const n = Math.round(Number(v));
  if (n === 0) return { text: '±0', tone: 'success' as const, label: '相符' };
  if (n > 0) return { text: `+${money(n)}`, tone: 'warning' as const, label: '溢收' };
  return { text: money(n), tone: 'danger' as const, label: '短缺' };
}

function VarianceBadge({ variance }: { variance: number | null | undefined }) {
  const m = varianceMeta(variance);
  return (
    <Badge tone={m.tone} dot>
      {m.label} {m.text}
    </Badge>
  );
}

function StepRail({ step }: { step: CloseStep }) {
  const idx = CLOSE_STEPS.findIndex((s) => s.key === step);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${CLOSE_STEPS.length}, 1fr)`,
        gap: '0.5rem',
        marginBottom: '0.75rem',
      }}
    >
      {CLOSE_STEPS.map((s, i) => {
        const active = i === idx;
        const done = i < idx;
        return (
          <div
            key={s.key}
            style={{
              borderBottom: active ? '2px solid currentColor' : '2px solid transparent',
              paddingBottom: '0.35rem',
              opacity: active || done ? 1 : 0.45,
              fontWeight: active ? 700 : 500,
              fontSize: '0.9rem',
            }}
          >
            <span className="text-muted">{s.n}.</span> {s.label}
            {done ? ' ✓' : ''}
          </div>
        );
      })}
    </div>
  );
}

export default function OpsShiftHandoverTab({ branchId, branchName }: Props) {
  const { toast } = useToast();
  const { staff } = useStaffAuth();
  const canAdjustVariance = staffHasManagerRankOrAbove(staff);
  const operatorLabel = useMemo(() => {
    if (!staff) return '未登入';
    const roleZh = positionShortLabel(staff.role) || '員工';
    return `${staff.name || '員工'}（${roleZh}）`;
  }, [staff]);

  const [busy, setBusy] = useState(false);
  const [shift, setShift] = useState<ShiftRow | null>(null);
  const [live, setLive] = useState<LiveSummary | null>(null);
  const [expectedCash, setExpectedCash] = useState<number | null>(null);
  const [history, setHistory] = useState<ShiftRow[]>([]);
  const [preview, setPreview] = useState<OpenPreview | null>(null);
  const [payDefs, setPayDefs] = useState(FALLBACK_PAY_COLUMNS);

  const [closeStep, setCloseStep] = useState<CloseStep>('summary');
  const [blindMode, setBlindMode] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [denomCounts, setDenomCounts] = useState<DenomCounts>(emptyDenomCounts);
  const [checklist, setChecklist] = useState<ChecklistState>(emptyChecklist);
  const [closeNote, setCloseNote] = useState('');
  const [edcCount, setEdcCount] = useState('');
  const [edcAmount, setEdcAmount] = useState('');
  const [yipayBusy, setYipayBusy] = useState(false);
  const [yipayReport, setYipayReport] = useState<{
    day: string;
    system: { count: number; amount: number };
    captures: {
      confirmedCount: number;
      confirmedAmount: number;
      pendingCount: number;
      pendingAmount: number;
      orphanCount: number;
      pending?: Array<{ id: string; targetId: string; amount: number; rrn?: string | null }>;
      orphans?: Array<{ id: string; targetId: string; amount: number; rrn?: string | null }>;
    };
    edcCompare: {
      matched: boolean;
      countDiff: number;
      amountDiff: number;
      edcCount: number;
      edcAmount: number;
    } | null;
    hints: string[];
    needsAttention: boolean;
  } | null>(null);

  const resetCloseFlow = useCallback(() => {
    setCloseStep('summary');
    setBlindMode(true);
    setRevealed(false);
    setDenomCounts(emptyDenomCounts());
    setChecklist(emptyChecklist());
    setCloseNote('');
    setEdcCount('');
    setEdcAmount('');
    setYipayReport(null);
  }, []);

  const runYipayReconcile = useCallback(async () => {
    if (branchId === '' || branchId == null) return;
    setYipayBusy(true);
    try {
      const res = await fetchOpsYipayReconcile({
        branchId: Number(branchId),
        edcCount: edcCount.trim() || undefined,
        edcAmount: edcAmount.trim() || undefined,
      });
      const data = res.data;
      if (!data) throw new Error(res.message || '無日結資料');
      setYipayReport({
        day: data.day,
        system: data.system,
        captures: data.captures,
        edcCompare: data.edcCompare,
        hints: data.hints || [],
        needsAttention: data.needsAttention,
      });
      if (data.needsAttention) {
        toast('乙禾日結有異常，請依提示補登或請主管處理', 'error');
      } else if (data.edcCompare?.matched) {
        toast('乙禾日結相符', 'success');
        setChecklist((prev) => ({ ...prev, cardSettled: true }));
      } else {
        toast('已載入系統乙禾認列；請輸入刷卡機結算單比對', 'info');
      }
    } catch (err) {
      toast(getErrorMessage(err, '乙禾日結失敗'), 'error');
    } finally {
      setYipayBusy(false);
    }
  }, [branchId, edcCount, edcAmount, toast]);

  const load = useCallback(async (opts?: { resetFlow?: boolean }) => {
    if (branchId === '' || branchId == null) return;
    try {
      const [cur, hist] = await Promise.all([
        fetchOpsShiftCurrent(Number(branchId)),
        fetchOpsShiftHistory(Number(branchId)),
      ]);
      if (opts?.resetFlow) resetCloseFlow();
      const curData = cur.data as {
        shift?: ShiftRow | null;
        liveSummary?: LiveSummary | null;
        expectedCash?: number | null;
        openPreview?: OpenPreview | null;
        payMethodColumns?: { key: string; label: string }[];
      };
      setShift(curData.shift || null);
      setLive(curData.liveSummary || null);
      setExpectedCash(curData.expectedCash ?? null);
      setHistory(Array.isArray(hist.data) ? (hist.data as ShiftRow[]) : []);
      const histMeta = (hist as { meta?: { payMethodColumns?: { key: string; label: string }[] } })
        .meta;
      const cols =
        curData.payMethodColumns ||
        curData.openPreview?.payMethodColumns ||
        histMeta?.payMethodColumns ||
        FALLBACK_PAY_COLUMNS;
      setPayDefs(cols);
      const p = curData.openPreview || null;
      setPreview(p);
      if (!curData.shift) resetCloseFlow();
    } catch (err) {
      toast(getErrorMessage(err, '讀取班次失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }, [branchId, toast, resetCloseFlow]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (branchId === '' || branchId == null) return;
      try {
        const [cur, hist] = await Promise.all([
          fetchOpsShiftCurrent(Number(branchId)),
          fetchOpsShiftHistory(Number(branchId)),
        ]);
        if (cancelled) return;
        resetCloseFlow();
        const curData = cur.data as {
          shift?: ShiftRow | null;
          liveSummary?: LiveSummary | null;
          expectedCash?: number | null;
          openPreview?: OpenPreview | null;
          payMethodColumns?: { key: string; label: string }[];
        };
        setShift(curData.shift || null);
        setLive(curData.liveSummary || null);
        setExpectedCash(curData.expectedCash ?? null);
        setHistory(Array.isArray(hist.data) ? (hist.data as ShiftRow[]) : []);
        const histMeta = (hist as { meta?: { payMethodColumns?: { key: string; label: string }[] } })
          .meta;
        const cols =
          curData.payMethodColumns ||
          curData.openPreview?.payMethodColumns ||
          histMeta?.payMethodColumns ||
          FALLBACK_PAY_COLUMNS;
        setPayDefs(cols);
        setPreview(curData.openPreview || null);
        if (!curData.shift) resetCloseFlow();
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '讀取班次失敗'), 'error');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, toast, resetCloseFlow]);

  const livePayColumns = useMemo(
    () => buildPayColumns(payDefs, live?.payMix, live?.payMixColumns),
    [payDefs, live],
  );

  const countedTotal = useMemo(() => sumDenomCounts(denomCounts), [denomCounts]);
  const systemExpected = Math.round(expectedCash || 0);
  const showExpected = !blindMode || revealed || closeStep === 'reconcile';
  const liveVariance = showExpected ? Math.round(countedTotal - systemExpected) : null;
  const checklistOk = allChecklistDone(checklist);

  const handleOpen = async (slot: ShiftSlot) => {
    if (branchId === '') {
      toast('請先選擇分店', 'error');
      return;
    }
    const label =
      preview?.slots?.find((s) => s.key === slot)?.label ||
      FALLBACK_SLOTS.find((s) => s.key === slot)?.label ||
      slot;
    const floatAmt = preview?.suggestedOpeningFloat ?? 0;
    if (
      !window.confirm(
        `確定開「${label}」？\n分店：${branchName || `#${branchId}`}\n開班底金（系統帶入上一班實點）：${money(floatAmt)}\n操作人員：${operatorLabel}`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await openOpsShift({
        branchId: Number(branchId),
        slot,
      });
      toast(res.message || '已開班', 'success');
      resetCloseFlow();
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '開班失敗'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submitClose = async () => {
    if (!shift?.id) return;
    if (!checklistOk) {
      toast('請完成交班檢核清單全部項目', 'error');
      return;
    }
    if (!yipayReport) {
      toast('請先完成「刷卡機日結核對」再交班', 'error');
      return;
    }
    if (yipayReport.needsAttention) {
      toast('乙禾日結仍有異常（未認列／ORPHAN／EDC 單邊帳），請先補登或請主管處理', 'error');
      return;
    }

    const counted = countedTotal;
    const variance = Math.round(counted - systemExpected);

    if (variance !== 0) {
      if (!canAdjustVariance) {
        toast('有差額僅限店長／總部交班，請重新點鈔或請店長處理', 'error');
        return;
      }
      if (!closeNote.trim()) {
        toast('有差額時必須填寫原因', 'error');
        return;
      }
    }

    const vm = varianceMeta(variance);
    if (
      !window.confirm(
        `確認交班簽核？\n系統帶入 ${money(systemExpected)}\n現場實收（面額合計）${money(counted)}\n差額 ${vm.label} ${vm.text}\n操作：${operatorLabel}`,
      )
    )
      return;

    setBusy(true);
    try {
      const res = await closeOpsShift(shift.id, {
        matchExpected: false,
        countedCash: counted,
        cashDenominations: denomCounts,
        closeChecklist: checklist,
        note: variance !== 0 ? closeNote.trim() : closeNote.trim() || undefined,
      });
      toast(res.message || '交班完成', 'success');
      const closed = res.data as ShiftRow | undefined;
      try {
        printShiftHandoverSlip({
          shiftId: closed?.id || shift.id,
          branchName: branchName || `分店 #${branchId}`,
          slotLabel: closed?.slotLabel || shift.slotLabel || '—',
          status: 'CLOSED',
          startedAt: shift.startedAt,
          endedAt: closed?.endedAt || new Date().toISOString(),
          openedByName: shift.openedByName,
          closedByName: closed?.closedByName || operatorLabel,
          openingFloat: shift.openingFloat,
          cashIn: live?.cashIn || 0,
          expectedCash: closed?.expectedCash ?? systemExpected,
          countedCash: closed?.countedCash ?? counted,
          variance: closed?.variance ?? variance,
          payColumns: livePayColumns.map((c) => ({ label: c.label, amount: c.amount })),
          totals: live?.totals,
          denominations: denomCounts,
          note: closeNote.trim() || closed?.note,
        });
      } catch {
        /* 列印失敗不阻擋交班 */
      }
      resetCloseFlow();
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '交班失敗'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const printHistoryRow = (h: ShiftRow) => {
    const cols = buildPayColumns(
      payDefs,
      h.payMixSnapshot,
      h.payMixColumns || h.summarySnapshot?.payMixColumns,
    );
    try {
      printShiftHandoverSlip({
        shiftId: h.id,
        branchName: branchName || `分店 #${branchId}`,
        slotLabel: h.slotLabel || '—',
        status: h.status,
        startedAt: h.startedAt,
        endedAt: h.endedAt,
        openedByName: h.openedByName,
        closedByName: h.closedByName,
        openingFloat: h.openingFloat,
        cashIn: h.summarySnapshot?.cashIn ?? Math.max(0, (h.expectedCash || 0) - h.openingFloat),
        expectedCash: h.expectedCash ?? 0,
        countedCash: h.countedCash ?? 0,
        variance: h.variance ?? 0,
        payColumns: cols.map((c) => ({ label: c.label, amount: c.amount })),
        totals: h.summarySnapshot?.totals,
        denominations: h.summarySnapshot?.cashDenominations?.counts || null,
        note: h.note,
      });
    } catch (err) {
      toast(getErrorMessage(err, '無法列印'), 'error');
    }
  };

  if (branchId === '') {
    return (
      <PageSection title="交接班結算" desc="請先於上方選擇作業分店">
        <Card title="尚未選擇分店">
          <p className="text-muted text-sm">選定分店後可進行超商式開班／點鈔／對帳交班。</p>
        </Card>
      </PageSection>
    );
  }

  const slotDefs = preview?.slots?.length ? preview.slots : FALLBACK_SLOTS;
  const todaySlots = preview?.today?.slots || [];

  return (
    <PageSection
      title="交接班結算"
      desc={`${branchName || `分店 #${branchId}`} · 超商式三段流程：彙總 → 點鈔 → 對帳簽核`}
    >
      <div className="form-stack" style={{ gap: '1rem' }}>
        <Alert tone="info">
          <strong>標準作業（比照超商交班）</strong>
          <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
            <li>班別兩班制：早班 07:00–15:30、晚班 15:30–00:00。</li>
            <li>預設「盲點」：先依面額點鈔，再揭示系統應有，避免先看帳再湊數。</li>
            <li>支付分欄：現金／刷卡／零錢包／抵用券；進出場零錢包不計入錢櫃。</li>
            <li>交班須勾選檢核清單；差額僅店長／總部可結案並註明原因。</li>
            <li>目前登入：{operatorLabel}</li>
          </ul>
        </Alert>

        {!shift && (
          <Card
            title="① 開班"
            subtitle={
              preview?.today?.businessDate
                ? `營業日 ${preview.today.businessDate}（台北）· 底金＝上一班實點 ${money(preview.suggestedOpeningFloat)}`
                : '同一分店同時僅一個進行中班次'
            }
          >
            <div className="form-stack">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                  gap: '0.75rem',
                }}
              >
                {slotDefs.map((s) => {
                  const today = todaySlots.find((t) => t.key === s.key);
                  const closed = today?.status === 'CLOSED';
                  const suggested = preview?.suggestedSlot === s.key;
                  return (
                    <Button
                      key={s.key}
                      variant={suggested && !closed ? 'primary' : 'secondary'}
                      disabled={busy || closed}
                      onClick={() => void handleOpen(s.key)}
                    >
                      {s.label}
                      {closed ? '（已交班）' : suggested ? '（建議）' : ''}
                      {s.hint ? (
                        <span className="text-sm" style={{ display: 'block', fontWeight: 400 }}>
                          {s.hint}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
              </div>
            </div>
          </Card>
        )}

        {shift && (
          <Card
            title={`進行中 · ${shift.slotLabel || '班次'} · ${shift.id}`}
            subtitle={`開班 ${fmtDt(shift.startedAt)} · ${shift.openedByName} · 底金 ${money(shift.openingFloat)}`}
          >
            <StepRail step={closeStep} />

            <div className="btn-row" style={{ marginBottom: '0.75rem', flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                onClick={() => {
                  setBusy(true);
                  void load();
                }}
                disabled={busy}
              >
                重新整理彙總
              </Button>
              <label className="text-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={blindMode}
                  onChange={(e) => {
                    setBlindMode(e.target.checked);
                    if (e.target.checked) setRevealed(false);
                  }}
                />
                盲點模式（先點鈔再看帳面）
              </label>
            </div>

            {closeStep === 'summary' && (
              <div className="form-stack">
                <div className="bento-grid bento-grid--compact">
                  <StatCard label="開班底金" value={Math.round(shift.openingFloat)} tone="cash" />
                  <StatCard label="已付筆數" value={live?.totals?.paidTxnCount || 0} />
                  {showExpected ? (
                    <>
                      <StatCard label="班內現金收入" value={Math.round(live?.cashIn || 0)} tone="cash" />
                      {live?.cashRefund ? (
                        <StatCard label="班內現金退款" value={-Math.round(live.cashRefund)} tone="cash" />
                      ) : null}
                      <StatCard label="系統應有現金" value={systemExpected} tone="cash" />
                    </>
                  ) : null}
                </div>
                {showExpected ? null : (
                  <Alert tone="warning">
                    盲點中：班內現金與應有金額已隱藏，請先完成面額點鈔，再於對帳步驟一次揭示。
                  </Alert>
                )}

                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>支付方式</th>
                        <th>系統帶入</th>
                        <th>現場處理</th>
                      </tr>
                    </thead>
                    <tbody>
                      {livePayColumns.map((col) => (
                        <tr key={col.key}>
                          <td>{col.label}</td>
                          <td>
                            {!showExpected && (col.key === 'CASH' || col.key === 'WALLET_CASH')
                              ? '（盲點隱藏）'
                              : money(col.amount)}
                          </td>
                          <td className="text-sm text-muted">
                            {col.key === 'CASH' ? '下一步面額點鈔' : '核對班報／系統帳'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="text-sm text-muted">
                  合併結帳 {live?.totals?.checkoutCount || 0}／{money(live?.totals?.checkoutAmount)} ·
                  銷貨 {live?.totals?.salesCount || 0}／{money(live?.totals?.salesAmount)} · 儲值{' '}
                  {live?.totals?.topupCount || 0}／{money(live?.totals?.topupAmount)}
                  {live?.refunds?.count ? ` · 退費 ${live.refunds.count} 筆` : ''}
                  <br />
                  {live?.gateNote}
                </p>

                <Button onClick={() => setCloseStep('count')} disabled={busy}>
                  下一步：現金點鈔 →
                </Button>
              </div>
            )}

            {closeStep === 'count' && (
              <div className="form-stack">
                <Alert tone="info">
                  請依錢櫃內紙鈔／硬幣逐面額輸入張數；合計即為現場實收。勿先看系統應有金額。
                </Alert>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>面額</th>
                        <th>張／枚數</th>
                        <th>小計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {CASH_DENOMINATIONS.map((d) => {
                        const count = Number(denomCounts[String(d)]) || 0;
                        return (
                          <tr key={d}>
                            <td>
                              <strong>{money(d)}</strong>
                            </td>
                            <td style={{ maxWidth: 120 }}>
                              <Input
                                type="number"
                                min={0}
                                step={1}
                                value={count || ''}
                                onChange={(e) => {
                                  const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
                                  setDenomCounts((prev) => ({ ...prev, [String(d)]: v }));
                                }}
                                placeholder="0"
                              />
                            </td>
                            <td>{money(count * d)}</td>
                          </tr>
                        );
                      })}
                      <tr>
                        <td colSpan={2}>
                          <strong>現場實收合計</strong>
                        </td>
                        <td>
                          <strong>{money(countedTotal)}</strong>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="btn-row">
                  <Button variant="secondary" onClick={() => setCloseStep('summary')} disabled={busy}>
                    ← 回彙總
                  </Button>
                  <Button
                    onClick={() => {
                      setCloseStep('reconcile');
                      if (blindMode) setRevealed(true);
                      void runYipayReconcile();
                    }}
                    disabled={busy}
                  >
                    下一步：對帳簽核 →
                  </Button>
                </div>
              </div>
            )}

            {closeStep === 'reconcile' && (
              <div className="form-stack">
                <Card
                  title="刷卡機日結核對（乙禾 YIPAY）"
                  subtitle={`${yipayReport?.day || '今日'} · 系統認列 vs EDC 結算單`}
                >
                  <div className="form-stack">
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                        gap: '0.75rem',
                      }}
                    >
                      <StatCard
                        label="系統已認列"
                        value={
                          yipayReport
                            ? `${yipayReport.system.count} 筆 / ${money(yipayReport.system.amount)}`
                            : '—'
                        }
                        tone="cash"
                      />
                      <StatCard
                        label="端末暫存未認列"
                        value={
                          yipayReport
                            ? `${yipayReport.captures.pendingCount} 筆 / ${money(yipayReport.captures.pendingAmount)}`
                            : '—'
                        }
                      />
                      <StatCard
                        label="ORPHAN"
                        value={String(yipayReport?.captures.orphanCount ?? '—')}
                      />
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                        gap: '0.75rem',
                      }}
                    >
                      <Field label="刷卡機結算單：總筆數">
                        <Input
                          inputMode="numeric"
                          value={edcCount}
                          onChange={(e) => setEdcCount(e.target.value)}
                          placeholder="例：12"
                        />
                      </Field>
                      <Field label="刷卡機結算單：總金額">
                        <Input
                          inputMode="decimal"
                          value={edcAmount}
                          onChange={(e) => setEdcAmount(e.target.value)}
                          placeholder="例：24600"
                        />
                      </Field>
                    </div>
                    <div className="btn-row">
                      <Button loading={yipayBusy} onClick={() => void runYipayReconcile()}>
                        比對日結
                      </Button>
                    </div>
                    {yipayReport?.edcCompare ? (
                      <Alert tone={yipayReport.edcCompare.matched ? 'success' : 'warning'}>
                        {yipayReport.edcCompare.matched
                          ? 'EDC 結算單與系統認列相符'
                          : `單邊差異：筆數差 ${yipayReport.edcCompare.countDiff}、金額差 ${money(yipayReport.edcCompare.amountDiff)}（正＝刷卡機多於系統，請主管補登）`}
                      </Alert>
                    ) : null}
                    {yipayReport?.hints?.length ? (
                      <Alert tone="warning">
                        <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                          {yipayReport.hints.map((h) => (
                            <li key={h}>{h}</li>
                          ))}
                        </ul>
                      </Alert>
                    ) : null}
                    {(yipayReport?.captures.pending?.length ||
                      yipayReport?.captures.orphans?.length) ? (
                      <div className="table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>狀態</th>
                              <th>單號</th>
                              <th>金額</th>
                              <th>RRN</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(yipayReport.captures.pending || []).map((p) => (
                              <tr key={p.id}>
                                <td>
                                  <Badge tone="warning">未認列</Badge>
                                </td>
                                <td>
                                  <code>{p.targetId}</code>
                                </td>
                                <td>{money(p.amount)}</td>
                                <td>{p.rrn || '—'}</td>
                              </tr>
                            ))}
                            {(yipayReport.captures.orphans || []).map((p) => (
                              <tr key={p.id}>
                                <td>
                                  <Badge tone="danger">ORPHAN</Badge>
                                </td>
                                <td>
                                  <code>{p.targetId}</code>
                                </td>
                                <td>{money(p.amount)}</td>
                                <td>{p.rrn || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                </Card>

                <Alert
                  tone={
                    liveVariance == null ? 'info' : liveVariance === 0 ? 'success' : 'warning'
                  }
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                      gap: '0.75rem',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <div className="text-sm text-muted">系統帶入</div>
                      <strong style={{ fontSize: '1.25rem' }}>{money(systemExpected)}</strong>
                    </div>
                    <div>
                      <div className="text-sm text-muted">現場實收</div>
                      <strong style={{ fontSize: '1.25rem' }}>{money(countedTotal)}</strong>
                    </div>
                    <div>
                      <div className="text-sm text-muted">差額</div>
                      <VarianceBadge variance={liveVariance} />
                    </div>
                  </div>
                </Alert>

                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>對帳項目</th>
                        <th>系統帶入</th>
                        <th>現場實收</th>
                        <th>差額</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>開班底金</td>
                        <td>{money(shift.openingFloat)}</td>
                        <td className="text-muted">含於實點</td>
                        <td>—</td>
                      </tr>
                      <tr>
                        <td>班內現金收入</td>
                        <td>{money(live?.cashIn)}</td>
                        <td className="text-muted">含於實點</td>
                        <td>—</td>
                      </tr>
                      <tr>
                        <td>
                          <strong>錢櫃現金合計</strong>
                        </td>
                        <td>
                          <strong>{money(systemExpected)}</strong>
                        </td>
                        <td>
                          <strong>{money(countedTotal)}</strong>
                        </td>
                        <td>
                          <VarianceBadge variance={liveVariance} />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <Card title="交班檢核清單" subtitle="全部勾選後才能簽核交班">
                  <div className="form-stack" style={{ gap: '0.4rem' }}>
                    {CLOSE_CHECKLIST.map((item) => (
                      <label
                        key={item.key}
                        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                      >
                        <input
                          type="checkbox"
                          checked={checklist[item.key] === true}
                          onChange={(e) =>
                            setChecklist((prev) => ({ ...prev, [item.key]: e.target.checked }))
                          }
                        />
                        {item.label}
                      </label>
                    ))}
                  </div>
                </Card>

                {liveVariance !== 0 && (
                  <Field label="差額原因（店長級必填）">
                    <Input
                      value={closeNote}
                      onChange={(e) => setCloseNote(e.target.value)}
                      placeholder="例：溢收已入帳／短缺待查／點鈔重覆"
                      disabled={!canAdjustVariance}
                    />
                  </Field>
                )}

                {!canAdjustVariance && liveVariance !== 0 && (
                  <Alert tone="warning">
                    目前差額非零，一般人員無法交班。請重新點鈔，或請店長／總部登入處理。
                  </Alert>
                )}

                <div className="btn-row" style={{ flexWrap: 'wrap' }}>
                  <Button variant="secondary" onClick={() => setCloseStep('count')} disabled={busy}>
                    ← 回點鈔
                  </Button>
                  {liveVariance === 0 ? (
                    <Button
                      onClick={() => void submitClose()}
                      disabled={busy || !checklistOk}
                    >
                      相符簽核交班（並列印）
                    </Button>
                  ) : canAdjustVariance ? (
                    <Button
                      variant="danger"
                      onClick={() => void submitClose()}
                      disabled={busy || !checklistOk || !closeNote.trim()}
                    >
                      有差額交班（店長／並列印）
                    </Button>
                  ) : null}
                </div>
                <p className="text-sm text-muted">
                  簽核後自動開啟交班單列印視窗，可供接班人／店長簽名留存。
                </p>
              </div>
            )}
          </Card>
        )}

        <Card title="交班紀錄" subtitle="系統帶入 vs 現場實收 · 可重印結算單">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>班別</th>
                  <th>人員</th>
                  {payDefs.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                  <th>系統帶入</th>
                  <th>現場實收</th>
                  <th>差額</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={6 + payDefs.length} className="text-muted text-center">
                      尚無紀錄
                    </td>
                  </tr>
                ) : (
                  history.map((h) => {
                    const cols = buildPayColumns(
                      payDefs,
                      h.payMixSnapshot,
                      h.payMixColumns || h.summarySnapshot?.payMixColumns,
                    );
                    const byKey = Object.fromEntries(cols.map((c) => [c.key, c.amount]));
                    const hasVar = h.variance != null && h.variance !== 0;
                    return (
                      <tr
                        key={h.id}
                        style={
                          hasVar
                            ? { background: 'var(--color-danger-bg, rgba(180,40,40,0.06))' }
                            : undefined
                        }
                      >
                        <td>
                          <strong>{h.slotLabel || '—'}</strong>
                          <div className="text-muted text-sm">{h.id}</div>
                          <div className="text-muted text-sm">
                            {fmtDt(h.startedAt)}
                            {h.endedAt ? ` → ${fmtDt(h.endedAt)}` : ''}
                          </div>
                        </td>
                        <td className="text-sm">
                          開：{h.openedByName}
                          <br />
                          交：{h.closedByName || '—'}
                        </td>
                        {payDefs.map((c) => (
                          <td key={c.key}>{money(byKey[c.key] ?? 0)}</td>
                        ))}
                        <td>{h.expectedCash != null ? money(h.expectedCash) : '—'}</td>
                        <td>{h.countedCash != null ? money(h.countedCash) : '—'}</td>
                        <td>
                          <VarianceBadge variance={h.variance} />
                        </td>
                        <td>
                          {h.status === 'CLOSED' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => printHistoryRow(h)}
                              disabled={busy}
                            >
                              列印
                            </Button>
                          ) : (
                            '進行中'
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </PageSection>
  );
}
