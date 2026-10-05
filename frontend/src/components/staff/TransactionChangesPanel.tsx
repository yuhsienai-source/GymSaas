import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, PageSection, Select } from '../ui';
import { staffBranchLabel } from '../../lib/branchLabel';
import BranchScopeBar from './BranchScopeBar';
import RefundDialog from './RefundDialog';
import RefundRecordView from './RefundRecordView';
import RefundErrorAlert from './RefundErrorAlert';
import AllowancePrintView, { type AllowancePrintFormat } from './AllowancePrintView';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  cancelOpsCardSubscription,
  exportAllowancesForAccounting,
  fetchAllowances,
  fetchOpsCardSubscriptionRebindStatus,
  fetchOpsCardSubscriptions,
  fetchRefunds,
  fetchReportBranches,
  getErrorMessage,
  openPayuniCheckoutInNewTab,
  opsCancelGate,
  pauseOpsCardSubscription,
  previewCancelCardSubscription,
  rebindOpsCardSubscription,
  resumeOpsCardSubscription,
} from '../../lib/api';
import { resolveBranchId } from '../../lib/resolveBranchId';
import { defaultReportRange } from '../../lib/csvExport';
import { downloadAllowanceCsv, downloadAllowanceXlsx } from '../../lib/allowanceExport';
import { useAllowancePrint } from '../../lib/useAllowancePrint';
import { describeRefundError, type RefundErrorInfo } from '../../lib/refundErrors';
import { REFUND_STATUS_LABEL, refundStatusTone } from '../../lib/refundLabels';
import type { AllowanceListPayload, Branch, CardSubscription, RefundRecord } from '../../types/api';
import MemberLeaveReviewPanel, { type LeavePrefill } from './MemberLeaveReviewPanel';
import HqReportsTab from '../../pages/staff/hq/HqReportsTab';

type TxSubTab = 'reports' | 'refund' | 'cancel' | 'subscription';

const TX_TABS: { key: TxSubTab; label: string }[] = [
  { key: 'reports', label: '一般報表' },
  { key: 'refund', label: '退費／折讓' },
  { key: 'subscription', label: '月卡訂閱／暫停' },
  { key: 'cancel', label: '取消進出場' },
];

type AllowanceFilter = {
  from: string;
  to: string;
  allowanceNo: string;
  invoiceNumber: string;
  member: string;
  subOrderId: string;
  exportState: 'ALL' | 'EXPORTED' | 'UNEXPORTED';
};

type ExpirePolicy = 'KEEP' | 'CUT_UNUSED' | 'CUT_NO_ALLOWANCE';

type Props = {
  branches?: Branch[];
};

function fmtDate(v?: string | null) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('zh-TW');
  } catch {
    return String(v);
  }
}

export default function TransactionChangesPanel({ branches: branchesProp }: Props) {
  const { toast } = useToast();
  const { staff, isAdmin } = useStaffAuth();
  const branchLocked = !isAdmin && Boolean(staff?.branchId);
  const [subTab, setSubTab] = useState<TxSubTab>('reports');
  const [fetchedBranches, setFetchedBranches] = useState<Branch[]>([]);
  const branches = branchesProp?.length ? branchesProp : fetchedBranches;
  const [branchIdDraft, setBranchIdDraft] = useState<number | ''>('');
  const branchId = resolveBranchId(branchLocked, staff?.branchId, branches, branchIdDraft);
  const setBranchId = setBranchIdDraft;

  const [lookupInput, setLookupInput] = useState('');
  const [refundTarget, setRefundTarget] = useState<{ refId?: string; invoiceNumber?: string } | null>(null);
  const [openRefunds, setOpenRefunds] = useState<RefundRecord[]>([]);
  const [selectedRefund, setSelectedRefund] = useState<RefundRecord | null>(null);
  const [allowanceFilter, setAllowanceFilter] = useState<AllowanceFilter>(() => {
    const r = defaultReportRange();
    return { from: r.from, to: r.to, allowanceNo: '', invoiceNumber: '', member: '', subOrderId: '', exportState: 'ALL' };
  });
  const [allowanceData, setAllowanceData] = useState<AllowanceListPayload | null>(null);
  const [refundTabError, setRefundTabError] = useState<RefundErrorInfo | null>(null);
  const exportInFlightRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const printer = useAllowancePrint();
  const { print: printAllowanceNo } = printer;
  const [cancelGateId, setCancelGateId] = useState('');
  const [cancelGateReason, setCancelGateReason] = useState('');
  const [busy, setBusy] = useState(false);

  const [subs, setSubs] = useState<CardSubscription[]>([]);
  const [subMemberFilter, setSubMemberFilter] = useState('');
  const [selectedSubId, setSelectedSubId] = useState('');
  const [expirePolicy, setExpirePolicy] = useState<ExpirePolicy>('KEEP');
  const [cancelSubReason, setCancelSubReason] = useState('');
  const [doAllowance, setDoAllowance] = useState(true);
  const [previewText, setPreviewText] = useState('');
  const [leavePrefill, setLeavePrefill] = useState<LeavePrefill | null>(null);
  const [pendingRebind, setPendingRebind] = useState<{
    subscriptionId: string;
    label: string;
  } | null>(null);

  useEffect(() => {
    if (branchesProp?.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchReportBranches();
        if (!cancelled && res.status === 'success' && res.data) {
          setFetchedBranches(res.data);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchesProp]);

  const loadSubscriptions = useCallback(async () => {
    try {
      const params: { memberNo?: string; status?: string } = {};
      const no = subMemberFilter.trim().toUpperCase();
      if (/^[A-Z0-9]{6}$/.test(no)) params.memberNo = no;
      const res = await fetchOpsCardSubscriptions(params);
      if (res.status === 'success' && Array.isArray(res.data)) {
        setSubs(res.data);
      }
    } catch (err) {
      toast(getErrorMessage(err, '讀取訂閱失敗'), 'error');
    }
  }, [subMemberFilter, toast]);

  useEffect(() => {
    if (subTab !== 'subscription') return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await loadSubscriptions();
    })();
    return () => {
      cancelled = true;
    };
  }, [subTab, loadSubscriptions]);

  useEffect(() => {
    if (!pendingRebind?.subscriptionId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetchOpsCardSubscriptionRebindStatus(pendingRebind.subscriptionId);
        if (cancelled) return;
        if (res.status === 'success' && res.data && !res.data.rebindPending && res.data.creditUpdated) {
          toast('換卡約定完成', 'success');
          setPendingRebind(null);
          await loadSubscriptions();
        }
      } catch {
        /* 輪詢中略過暫時錯誤 */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [pendingRebind?.subscriptionId, loadSubscriptions, toast]);

  async function handleRebindCard(s: CardSubscription) {
    setBusy(true);
    try {
      const r = await rebindOpsCardSubscription(s.id);
      if (r.status !== 'success' || !r.data?.actionUrl || !r.data?.payload) {
        toast(r.message || '無法開啟換卡頁', 'error');
        return;
      }
      openPayuniCheckoutInNewTab(r.data.actionUrl, r.data.payload);
      setPendingRebind({
        subscriptionId: s.id,
        label: s.promotion?.name || s.coursePlan?.name || s.id,
      });
      toast(r.message || '已開啟 PayUNi 換卡頁', 'success');
    } catch (e) {
      toast(getErrorMessage(e, '換卡失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const loadOpenRefunds = useCallback(async () => {
    try {
      const res = await fetchRefunds({ status: 'OPEN', take: 50, ...(branchId ? { branchId: Number(branchId) } : {}) });
      setOpenRefunds(res.data || []);
    } catch (err) {
      setRefundTabError(describeRefundError(err, '讀取處理中退費單失敗'));
    }
  }, [branchId]);

  const loadAllowances = useCallback(async () => {
    const f = allowanceFilter;
    try {
      const res = await fetchAllowances({
        from: f.from || undefined,
        to: f.to || undefined,
        ...(branchId ? { branchId: Number(branchId) } : {}),
        allowanceNo: f.allowanceNo.trim() || undefined,
        invoiceNumber: f.invoiceNumber.trim().toUpperCase() || undefined,
        member: f.member.trim() || undefined,
        subOrderId: f.subOrderId.trim().toUpperCase() || undefined,
        exportState: f.exportState,
        take: 500,
      });
      setAllowanceData(res.data || null);
    } catch (err) {
      setRefundTabError(describeRefundError(err, '讀取折讓單失敗'));
    }
  }, [allowanceFilter, branchId]);

  useEffect(() => {
    if (subTab !== 'refund') return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await loadOpenRefunds();
      if (cancelled) return;
      await loadAllowances();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 切換分頁／分店時自動載入；篩選條件改按「查詢」
  }, [subTab, branchId]);

  const handleLookup = useCallback(() => {
    const v = lookupInput.trim().toUpperCase();
    if (!v) return;
    setRefundTarget(/^[A-Z]{2}\d{8}$/.test(v) ? { invoiceNumber: v } : { refId: v });
  }, [lookupInput]);

  const handlePrint = useCallback(
    async (allowanceNo: string, format: AllowancePrintFormat) => {
      try {
        await printAllowanceNo(allowanceNo, format);
        void loadAllowances();
      } catch (err) {
        setRefundTabError(describeRefundError(err, '列印失敗'));
      }
    },
    [printAllowanceNo, loadAllowances],
  );

  const handleExport = useCallback(
    async (kind: 'csv' | 'xlsx', markExported: boolean) => {
      const f = allowanceFilter;
      if (!f.from || !f.to) {
        setRefundTabError({ title: '請指定匯出日期區間', message: '會計匯出須填起日與迄日。', tone: 'warning' });
        return;
      }
      if (exportInFlightRef.current) return;
      exportInFlightRef.current = true;
      setExporting(true);
      try {
        const res = await exportAllowancesForAccounting({
          from: f.from,
          to: f.to,
          ...(branchId ? { branchId: Number(branchId) } : {}),
          allowanceNo: f.allowanceNo.trim() || undefined,
          invoiceNumber: f.invoiceNumber.trim().toUpperCase() || undefined,
          member: f.member.trim() || undefined,
          subOrderId: f.subOrderId.trim().toUpperCase() || undefined,
          exportState: f.exportState,
          markExported,
        });
        const data = res.data;
        if (!data?.rows.length) {
          toast('沒有可匯出的折讓單', 'error');
          return;
        }
        const branch =
          branchId === '' ? '全部門市' : staffBranchLabel(branches.find((b) => b.id === branchId)) || `分店${branchId}`;
        const scope = { from: f.from, to: f.to, branch };
        if (kind === 'csv') downloadAllowanceCsv(data, scope);
        else await downloadAllowanceXlsx(data, scope);
        toast(
          `${res.message || (markExported ? '已下載並標記結轉' : '已下載對帳檔（未標記）')}${data.exported.truncated ? '；已達 500 筆上限，請縮小日期區間分批匯出' : ''}`,
          data.exported.truncated ? 'info' : 'success',
        );
        setAllowanceData(data);
      } catch (err) {
        setRefundTabError(describeRefundError(err, '匯出失敗'));
      } finally {
        exportInFlightRef.current = false;
        setExporting(false);
      }
    },
    [allowanceFilter, branchId, branches, toast],
  );

  const handleCancelGate = useCallback(async () => {
    const logId = cancelGateId.trim();
    if (!logId) return;
    if (!window.confirm(`確定取消進出場單號 ${logId}？已出場費用將退回零錢包。`)) return;
    setBusy(true);
    try {
      const result = await opsCancelGate(logId, cancelGateReason);
      toast(result.message || '進出場已取消', 'success');
      setCancelGateId('');
      setCancelGateReason('');
    } catch (err) {
      toast(getErrorMessage(err, '取消進出場失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }, [cancelGateId, cancelGateReason, toast]);

  const handlePreviewCancel = useCallback(async () => {
    if (!selectedSubId) return;
    setBusy(true);
    try {
      const res = await previewCancelCardSubscription(selectedSubId);
      const d = res.data as {
        subscription?: { id?: string; originOrderId?: string | null };
        unusedDays?: number;
        periodDays?: number;
        usedDays?: number;
        estimatedAllowance?: number;
        refundDetail?: { note?: string; fee?: number; ratio?: number } | null;
        latestOrder?: { id: string; invoiceNumber?: string | null; amount: number } | null;
        member?: { expireDate?: string | null; name?: string };
      };
      const resolvedSubId = String(d.subscription?.id || '').trim();
      if (resolvedSubId) setSelectedSubId(resolvedSubId);
      setPreviewText(
        [
          `訂閱編號：${resolvedSubId || selectedSubId}`,
          d.subscription?.originOrderId
            ? `首期訂單：${d.subscription.originOrderId}`
            : null,
          `會員：${d.member?.name || '—'}`,
          `效期至：${fmtDate(d.member?.expireDate)}（剩餘約 ${d.unusedDays ?? 0} 天）`,
          `本期天數：${d.periodDays ?? '—'}／已使用約 ${d.usedDays ?? '—'} 天`,
          `最近訂單：${d.latestOrder?.id || '無'}／發票 ${d.latestOrder?.invoiceNumber || '無'}／$${d.latestOrder?.amount ?? 0}`,
          `預估折讓：$${d.estimatedAllowance ?? 0}（僅 CUT_UNUSED + 開折讓）`,
          d.refundDetail?.note ? `計算說明：${d.refundDetail.note}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (err) {
      toast(getErrorMessage(err, '預覽失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }, [selectedSubId, toast]);

  const handleCancelSubscription = useCallback(async () => {
    if (!selectedSubId) return;
    const label =
      expirePolicy === 'KEEP'
        ? '停續扣並保留已付效期'
        : expirePolicy === 'CUT_UNUSED'
          ? '停續扣、截斷效期，並依月卡退費基準開立 ezPay 折讓（未滿十五日可退、手續費$500）'
          : '停續扣並截斷效期（不開折讓）';
    if (!window.confirm(`確定取消訂閱 ${selectedSubId}？\n${label}`)) return;
    setBusy(true);
    try {
      const result = await cancelOpsCardSubscription(selectedSubId, {
        reason: cancelSubReason,
        expirePolicy,
        doAllowance: expirePolicy === 'CUT_UNUSED' ? doAllowance : false,
        settle: true,
      });
      const resolved =
        typeof result.data === 'object' && result.data && 'subscriptionId' in result.data
          ? String((result.data as { subscriptionId?: string }).subscriptionId || '')
          : typeof result.data === 'object' && result.data && 'id' in result.data
            ? String((result.data as { id?: string }).id || '')
            : '';
      if (resolved) setSelectedSubId(resolved);
      toast(result.message || '訂閱已取消', /PayUNi|⚠/.test(String(result.message || '')) ? 'error' : 'success');
      const slip = (result.data as { allowanceSlip?: { allowanceNo?: string } | null } | undefined)
        ?.allowanceSlip;
      if (slip?.allowanceNo) {
        toast(`折讓單據號碼：${slip.allowanceNo}`, 'success');
        try {
          await printAllowanceNo(slip.allowanceNo);
        } catch (printErr) {
          toast(getErrorMessage(printErr, `單號 ${slip.allowanceNo} 已開立，請至「退費／折讓」查詢`), 'error');
        }
      }
      setCancelSubReason('');
      setPreviewText('');
      await loadSubscriptions();
    } catch (err) {
      toast(getErrorMessage(err, '取消訂閱失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }, [selectedSubId, expirePolicy, doAllowance, cancelSubReason, toast, loadSubscriptions, printAllowanceNo]);

  const branchName =
    branchId === ''
      ? null
      : staffBranchLabel(branches.find((b) => b.id === branchId)) ||
        staff?.branchName ||
        `#${branchId}`;

  return (
    <div className="hq-dashboard">
      <BranchScopeBar
        branches={branches}
        branchId={branchId}
        locked={branchLocked}
        lockedLabel={staff?.branchName || (staff?.branchId ? `分店 #${staff.branchId}` : undefined)}
        hint="報表查詢以此分店篩選；退費／取消／訂閱仍依單號處理，後端會再驗證分店權限"
        onChange={setBranchId}
      />

      <nav className="hq-tabs" role="tablist" aria-label="交易異動項目" style={{ marginBottom: '1rem' }}>
        {TX_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={subTab === item.key}
            className={`hq-tabs__btn ${subTab === item.key ? 'is-active' : ''}`}
            onClick={() => setSubTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {subTab === 'reports' && (
        <HqReportsTab
          branches={branches}
          branchId={branchId}
          onBranchIdChange={setBranchId}
          hideBranchField
          pageDesc="於列表列執行退費（後端試算）／取消沖回；規則見頁面上方說明 · CSV 最多 1000 筆"
        />
      )}

      {subTab === 'refund' && (
        <PageSection
          title="退費／折讓"
          desc={
            branchName
              ? `目前作業分店：${branchName} · 以單號或發票號查詢後退費；金額由後端試算，必填原因並留稽核`
              : '以單號或發票號查詢後退費；金額由後端試算，必填原因並留稽核'
          }
        >
          <div className="form-stack" style={{ gap: '1rem' }}>
            <RefundErrorAlert error={refundTabError} onDismiss={() => setRefundTabError(null)} />
            <Card title="查詢單據並退費" subtitle="可輸入子單號（SAL／TYK／CRS…）、合併結帳 CHK 或發票號碼">
              <div className="list-toolbar">
                <Field label="單號／發票號碼">
                  <Input
                    value={lookupInput}
                    onChange={(e) => setLookupInput(e.target.value.trim())}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleLookup();
                    }}
                    placeholder="SAL…／TYK…／CHK…／AB12345678"
                    className="mono"
                  />
                </Field>
                <Button onClick={handleLookup} disabled={!lookupInput.trim()}>
                  查詢並退費
                </Button>
              </div>
            </Card>

            <Card
              title="處理中退費單"
              subtitle={openRefunds.length ? `${openRefunds.length} 筆待處理（乙禾回填、重試、簽名等）` : '目前無待處理退費單'}
            >
              <div className="form-stack">
                <Button variant="secondary" size="sm" onClick={() => void loadOpenRefunds()} disabled={busy}>
                  重新載入
                </Button>
                {openRefunds.length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>退費單</th>
                          <th>子單</th>
                          <th>實退</th>
                          <th>狀態</th>
                          <th>建立時間</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {openRefunds.map((r) => (
                          <tr key={r.id}>
                            <td className="mono text-sm">{r.id}</td>
                            <td className="mono text-sm">{r.subOrderId}</td>
                            <td>${r.payoutAmount.toLocaleString('zh-TW')}</td>
                            <td>
                              <Badge tone={refundStatusTone(r.status)}>{REFUND_STATUS_LABEL[r.status] || r.status}</Badge>
                            </td>
                            <td className="text-sm">{new Date(r.createdAt).toLocaleString('zh-TW')}</td>
                            <td>
                              <Button size="sm" variant="secondary" onClick={() => setSelectedRefund(r)}>
                                處理
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Card>

            <Card
              title="折讓單一覽"
              subtitle={
                allowanceData
                  ? `共 ${allowanceData.items.length} 筆（最多 500 筆）· 分店依上方作業分店篩選`
                  : '依日期區間與分店查詢後可匯出 CSV（UTF-8 BOM）／Excel 供會計申報'
              }
            >
              <div className="form-stack">
                <div className="list-toolbar">
                  <Field label="起日">
                    <Input
                      type="date"
                      value={allowanceFilter.from}
                      onChange={(e) => setAllowanceFilter({ ...allowanceFilter, from: e.target.value })}
                    />
                  </Field>
                  <Field label="迄日">
                    <Input
                      type="date"
                      value={allowanceFilter.to}
                      onChange={(e) => setAllowanceFilter({ ...allowanceFilter, to: e.target.value })}
                    />
                  </Field>
                  <Field label="折讓單號">
                    <Input
                      value={allowanceFilter.allowanceNo}
                      onChange={(e) => setAllowanceFilter({ ...allowanceFilter, allowanceNo: e.target.value })}
                      className="mono"
                    />
                  </Field>
                  <Field label="原發票號碼">
                    <Input
                      value={allowanceFilter.invoiceNumber}
                      onChange={(e) => setAllowanceFilter({ ...allowanceFilter, invoiceNumber: e.target.value })}
                      className="mono"
                    />
                  </Field>
                  <Field label="會員姓名">
                    <Input
                      value={allowanceFilter.member}
                      onChange={(e) => setAllowanceFilter({ ...allowanceFilter, member: e.target.value })}
                    />
                  </Field>
                  <Field label="子單號">
                    <Input
                      value={allowanceFilter.subOrderId}
                      onChange={(e) => setAllowanceFilter({ ...allowanceFilter, subOrderId: e.target.value })}
                      className="mono"
                    />
                  </Field>
                  <Field label="會計匯出狀態">
                    <select
                      className="input"
                      value={allowanceFilter.exportState}
                      onChange={(e) => setAllowanceFilter({ ...allowanceFilter, exportState: e.target.value as AllowanceFilter['exportState'] })}
                    >
                      <option value="ALL">全部</option>
                      <option value="UNEXPORTED">未匯出</option>
                      <option value="EXPORTED">已匯出</option>
                    </select>
                  </Field>
                </div>
                <div className="btn-row">
                  <Button onClick={() => void loadAllowances()} disabled={busy}>
                    查詢
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void handleExport('csv', false)}
                    loading={exporting}
                    disabled={!allowanceData?.rows.length}
                  >
                    僅下載 CSV
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => void handleExport('xlsx', false)}
                    loading={exporting}
                    disabled={!allowanceData?.rows.length}
                  >
                    僅下載 Excel
                  </Button>
                  <Button
                    onClick={() => void handleExport('csv', true)}
                    loading={exporting}
                    disabled={!allowanceData?.rows.length}
                  >
                    下載 CSV 並標記已結轉
                  </Button>
                </div>
                {allowanceData && allowanceData.items.length > 0 && (
                  <div className="table-wrap" style={{ maxHeight: 480, overflow: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>折讓日期</th>
                          <th>折讓單號</th>
                          <th>原發票</th>
                          <th>門市</th>
                          <th>會員／買受人</th>
                          <th>子單</th>
                          <th>含稅金額</th>
                          <th>簽名</th>
                          <th>列印</th>
                          <th>會計匯出</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {allowanceData.items.map((a) => (
                          <tr key={a.allowanceNo}>
                            <td className="text-sm">{new Date(a.issuedAt).toLocaleDateString('zh-TW')}</td>
                            <td className="mono text-sm">{a.allowanceNo}</td>
                            <td className="mono text-sm">{a.invoiceNumber}</td>
                            <td className="text-sm">{a.branchName || '—'}</td>
                            <td className="text-sm">
                              {a.category === 'B2B' ? `${a.buyerName || '—'}（${a.buyerUbn || '—'}）` : a.memberName || '—'}
                            </td>
                            <td className="mono text-sm">{a.subOrderId || '—'}</td>
                            <td>${a.totalAmt.toLocaleString('zh-TW')}</td>
                            <td className="text-sm">
                              {a.signed ? '已簽' : a.signatureRequired ? <Badge tone="warning">待簽</Badge> : '—'}
                            </td>
                            <td className="text-sm">{a.printCount > 0 ? `${a.printCount} 次` : '未列印'}</td>
                            <td className="text-sm">
                              {a.exportedToAcctAt ? new Date(a.exportedToAcctAt).toLocaleDateString('zh-TW') : '未匯出'}
                            </td>
                            <td>
                              <div className="btn-row">
                                <Button size="sm" variant="secondary" onClick={() => void handlePrint(a.allowanceNo, 'A4_FOUR_PART')}>
                                  {a.printCount > 0 ? 'A4 補印' : 'A4 列印'}
                                </Button>
                                <Button size="sm" variant="secondary" onClick={() => void handlePrint(a.allowanceNo, 'THERMAL_80MM')}>
                                  {a.printCount > 0 ? '熱感補印' : '熱感列印'}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </PageSection>
      )}

      {subTab === 'subscription' && (
        <PageSection
          title="月卡訂閱／請假"
          desc="取消訂閱可保留或截斷效期；退費折讓依 30 日一期基準（未滿十五日＝已繳×存續比例−$500；滿／逾十五日不可退）；請假會順延效期與定期定額扣款日"
        >
          <div className="form-stack" style={{ gap: '1rem' }}>
            <Card title="訂閱一覽" subtitle="定期定額 CRS…">
              <div className="form-stack">
                <div className="list-toolbar">
                  <Field label="會員編號（選填）">
                    <Input
                      value={subMemberFilter}
                      onChange={(e) => setSubMemberFilter(e.target.value)}
                      placeholder="6 碼英數，例如 A1B2C3"
                    />
                  </Field>
                  <Button variant="secondary" onClick={() => void loadSubscriptions()} disabled={busy}>
                    重新載入
                  </Button>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>選</th>
                        <th>訂閱</th>
                        <th>會員編號</th>
                        <th>會員</th>
                        <th>方案</th>
                        <th>狀態</th>
                        <th>下次扣款</th>
                        <th>效期</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subs.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="text-muted text-center">
                            尚無訂閱
                          </td>
                        </tr>
                      ) : (
                        subs.map((s) => (
                          <tr key={s.id}>
                            <td>
                              <input
                                type="radio"
                                name="subPick"
                                checked={selectedSubId === s.id}
                                onChange={() => {
                                  setSelectedSubId(s.id);
                                  setLeavePrefill({ subscriptionId: s.id, memberNo: s.member?.memberNo || '' });
                                }}
                              />
                            </td>
                            <td className="text-sm">{s.id}</td>
                            <td className="text-sm">{s.member?.memberNo || '—'}</td>
                            <td className="text-sm">
                              {s.member?.name || `#${s.memberId}`}
                            </td>
                            <td className="text-sm">
                              {s.promotion?.name ||
                                s.coursePlan?.name ||
                                (s.promotionId
                                  ? `#${s.promotionId}`
                                  : s.coursePlanId
                                    ? `課程#${s.coursePlanId}`
                                    : '—')}
                            </td>
                            <td>{s.status}</td>
                            <td className="text-sm">{fmtDate(s.nextChargeAt)}</td>
                            <td className="text-sm">{fmtDate(s.member?.expireDate)}</td>
                            <td>
                              <div className="btn-row">
                                {s.status === 'ACTIVE' && (
                                  <Button
                                    variant="secondary"
                                    onClick={() =>
                                      void (async () => {
                                        setBusy(true);
                                        try {
                                          const r = await pauseOpsCardSubscription(s.id);
                                          toast(r.message || '已暫停續扣', 'success');
                                          await loadSubscriptions();
                                        } catch (e) {
                                          toast(getErrorMessage(e, '暫停失敗'), 'error');
                                        } finally {
                                          setBusy(false);
                                        }
                                      })()
                                    }
                                    disabled={busy}
                                  >
                                    暫停續扣
                                  </Button>
                                )}
                                {s.status === 'PAUSED' && (
                                  <Button
                                    variant="secondary"
                                    onClick={() =>
                                      void (async () => {
                                        setBusy(true);
                                        try {
                                          const r = await resumeOpsCardSubscription(s.id);
                                          toast(
                                            r.message || '已恢復',
                                            /PayUNi|⚠/.test(String(r.message || '')) &&
                                              !/已啟用/.test(String(r.message || ''))
                                              ? 'error'
                                              : 'success',
                                          );
                                          await loadSubscriptions();
                                        } catch (e) {
                                          toast(getErrorMessage(e, '恢復失敗'), 'error');
                                        } finally {
                                          setBusy(false);
                                        }
                                      })()
                                    }
                                    disabled={busy}
                                  >
                                    恢復續扣
                                  </Button>
                                )}
                                {['ACTIVE', 'PAUSED', 'FAILED'].includes(String(s.status)) && (
                                  <Button
                                    variant="secondary"
                                    onClick={() => void handleRebindCard(s)}
                                    disabled={busy}
                                  >
                                    換卡
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>

            <Card
              title="取消訂閱結算"
              subtitle="可貼訂閱編號 CRS，或首期／續扣訂單號（CRS／舊 TYK）自動反查；KEEP=保留效期｜CUT_UNUSED=截斷並依月卡基準折讓｜CUT_NO_ALLOWANCE=截斷不折讓"
            >
              <div className="form-stack">
                <Field label="訂閱編號／訂單編號">
                  <Input
                    value={selectedSubId}
                    onChange={(e) => setSelectedSubId(e.target.value)}
                    placeholder="CRS…（訂閱或訂單）"
                  />
                </Field>
                <Field label="效期政策">
                  <Select
                    value={expirePolicy}
                    onChange={(e) => setExpirePolicy(e.target.value as ExpirePolicy)}
                  >
                    <option value="KEEP">KEEP：停續扣，保留已付效期</option>
                    <option value="CUT_UNUSED">CUT_UNUSED：截斷效期 + 月卡退費折讓</option>
                    <option value="CUT_NO_ALLOWANCE">CUT_NO_ALLOWANCE：截斷效期、不開折讓</option>
                  </Select>
                </Field>
                {expirePolicy === 'CUT_UNUSED' && (
                  <label className="text-sm">
                    <input
                      type="checkbox"
                      checked={doAllowance}
                      onChange={(e) => setDoAllowance(e.target.checked)}
                    />{' '}
                    呼叫 ezPay 開立折讓（未滿十五日：已繳×存續比例−手續費$500；滿／逾十五日不可退）
                  </label>
                )}
                <Field label="原因（選填）">
                  <Input
                    value={cancelSubReason}
                    onChange={(e) => setCancelSubReason(e.target.value)}
                    placeholder="例：搬家、改方案"
                  />
                </Field>
                <div className="btn-row">
                  <Button
                    variant="secondary"
                    onClick={() => void handlePreviewCancel()}
                    disabled={busy || !selectedSubId.trim()}
                  >
                    預覽結算
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => void handleCancelSubscription()}
                    disabled={busy || !selectedSubId.trim()}
                  >
                    執行取消訂閱
                  </Button>
                </div>
                {previewText && (
                  <pre className="text-sm text-muted" style={{ whiteSpace: 'pre-wrap' }}>
                    {previewText}
                  </pre>
                )}
              </div>
            </Card>

            <MemberLeaveReviewPanel
              memberNoFilter={subMemberFilter}
              prefill={leavePrefill}
              onSubscriptionsChanged={loadSubscriptions}
            />
          </div>
        </PageSection>
      )}

      {subTab === 'cancel' && (
        <PageSection
          title="取消進出場"
          desc={
            branchName
              ? `目前作業分店：${branchName} · 進出場 ACC＋日期時間；銷貨／購案退費請用「退費／折讓」`
              : '進出場 ACC＋日期時間；銷貨／購案退費請用「退費／折讓」'
          }
        >
          <div className="form-stack" style={{ gap: '1rem' }}>
            <Card title="取消進出場" subtitle="在場中取消進場；已出場則費用退回零錢包">
              <div className="form-stack">
                <Field label="進出場單號" hint="例 ACC20260728215430（或報表數字 id）">
                  <Input
                    value={cancelGateId}
                    onChange={(e) => setCancelGateId(e.target.value)}
                    placeholder="ACC20260728215430"
                    autoComplete="off"
                  />
                </Field>
                <Field label="取消原因（選填）">
                  <Input
                    value={cancelGateReason}
                    onChange={(e) => setCancelGateReason(e.target.value)}
                    placeholder="例：誤刷、重複進場"
                  />
                </Field>
                <Button
                  variant="danger"
                  onClick={() => void handleCancelGate()}
                  disabled={busy || !cancelGateId.trim()}
                >
                  取消進出場
                </Button>
              </div>
            </Card>
          </div>
        </PageSection>
      )}

      {refundTarget && (
        <RefundDialog
          open
          refId={refundTarget.refId}
          invoiceNumber={refundTarget.invoiceNumber}
          onClose={() => {
            setRefundTarget(null);
            void loadOpenRefunds();
            void loadAllowances();
          }}
        />
      )}

      {selectedRefund && (
        <Modal
          open
          wide
          closeOnBackdrop={false}
          title={`退費單 ${selectedRefund.id}`}
          onClose={() => {
            setSelectedRefund(null);
            void loadOpenRefunds();
            void loadAllowances();
          }}
        >
          <RefundRecordView refund={selectedRefund} />
        </Modal>
      )}

      {printer.job && (
        <AllowancePrintView
          key={`${printer.job.payload.allowance.allowanceNo}-${printer.job.format}`}
          payload={printer.job.payload}
          format={printer.job.format}
          onDone={printer.clear}
        />
      )}

      <Modal
        open={pendingRebind !== null}
        onClose={() => setPendingRebind(null)}
        title="等待換卡約定"
      >
        <p className="text-sm">
          已另開 PayUNi 頁面；請會員輸入新卡（$1 驗證授權，隨後取消不請款）。完成後此視窗會自動關閉。
        </p>
        <p className="text-sm text-muted mt-sm">
          訂閱：<strong>{pendingRebind?.label || pendingRebind?.subscriptionId}</strong>
        </p>
        <div className="btn-row mt-md">
          <Button variant="secondary" onClick={() => setPendingRebind(null)}>
            稍後再查
          </Button>
          <Button
            onClick={() =>
              void (async () => {
                if (!pendingRebind) return;
                try {
                  const res = await fetchOpsCardSubscriptionRebindStatus(
                    pendingRebind.subscriptionId,
                  );
                  if (
                    res.status === 'success' &&
                    res.data &&
                    !res.data.rebindPending &&
                    res.data.creditUpdated
                  ) {
                    toast('換卡約定完成', 'success');
                    setPendingRebind(null);
                    await loadSubscriptions();
                  } else {
                    toast('尚未收到約定回報，請稍候再試', 'info');
                  }
                } catch (e) {
                  toast(getErrorMessage(e, '查詢失敗'), 'error');
                }
              })()
            }
          >
            我已完成換卡
          </Button>
        </div>
      </Modal>
    </div>
  );
}
