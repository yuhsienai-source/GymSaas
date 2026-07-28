import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Field, Input, PageSection, Select } from '../ui';
import { staffBranchLabel } from '../../lib/branchLabel';
import BranchScopeBar from './BranchScopeBar';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  cancelOpsCardSubscription,
  completeOpsMemberLeave,
  endOpsMemberLeave,
  fetchAllowanceSlip,
  fetchAllowanceSlips,
  fetchOpsCardSubscriptions,
  fetchOpsMemberLeaves,
  fetchReportBranches,
  getErrorMessage,
  opsCancelGate,
  opsCancelSale,
  pauseOpsCardSubscription,
  previewCancelCardSubscription,
  resumeOpsCardSubscription,
  startOpsMemberLeave,
} from '../../lib/api';
import { resolveBranchId } from '../../lib/resolveBranchId';
import type { Branch, CardSubscription, MemberLeave } from '../../types/api';
import { printAllowanceSlip, type AllowanceSlip } from '../../lib/printAllowanceSlip';
import HqReportsTab from '../../pages/staff/hq/HqReportsTab';

type TxSubTab = 'reports' | 'refund' | 'cancel' | 'subscription';

const TX_TABS: { key: TxSubTab; label: string }[] = [
  { key: 'reports', label: '一般報表' },
  { key: 'refund', label: '折讓單據' },
  { key: 'subscription', label: '月卡訂閱／請假' },
  { key: 'cancel', label: '取消進出場/交易' },
];

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

  const [refundAllowanceNo, setRefundAllowanceNo] = useState('');
  const [lastAllowanceSlip, setLastAllowanceSlip] = useState<AllowanceSlip | null>(null);
  const [allowanceList, setAllowanceList] = useState<AllowanceSlip[]>([]);
  const [cancelSaleId, setCancelSaleId] = useState('');
  const [cancelSaleReason, setCancelSaleReason] = useState('');
  const [cancelGateId, setCancelGateId] = useState('');
  const [cancelGateReason, setCancelGateReason] = useState('');
  const [busy, setBusy] = useState(false);

  const [subs, setSubs] = useState<CardSubscription[]>([]);
  const [leaves, setLeaves] = useState<MemberLeave[]>([]);
  const [subMemberFilter, setSubMemberFilter] = useState('');
  const [selectedSubId, setSelectedSubId] = useState('');
  const [expirePolicy, setExpirePolicy] = useState<ExpirePolicy>('KEEP');
  const [cancelSubReason, setCancelSubReason] = useState('');
  const [doAllowance, setDoAllowance] = useState(true);
  const [previewText, setPreviewText] = useState('');
  const [leaveMemberId, setLeaveMemberId] = useState('');
  const [leaveDays, setLeaveDays] = useState('7');
  const [leaveReason, setLeaveReason] = useState('');
  const [leaveSubId, setLeaveSubId] = useState('');

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
      const params: { memberId?: number; status?: string } = {};
      const mid = Number(subMemberFilter);
      if (Number.isInteger(mid) && mid > 0) params.memberId = mid;
      const res = await fetchOpsCardSubscriptions(params);
      if (res.status === 'success' && Array.isArray(res.data)) {
        setSubs(res.data);
      }
    } catch (err) {
      toast(getErrorMessage(err, '讀取訂閱失敗'), 'error');
    }
  }, [subMemberFilter, toast]);

  const loadLeaves = useCallback(async () => {
    try {
      const params: { memberId?: number; status?: string } = { status: 'ACTIVE' };
      const mid = Number(leaveMemberId || subMemberFilter);
      if (Number.isInteger(mid) && mid > 0) params.memberId = mid;
      const res = await fetchOpsMemberLeaves(params);
      if (res.status === 'success' && Array.isArray(res.data)) {
        setLeaves(res.data as MemberLeave[]);
      }
    } catch (err) {
      toast(getErrorMessage(err, '讀取請假失敗'), 'error');
    }
  }, [leaveMemberId, subMemberFilter, toast]);

  useEffect(() => {
    if (subTab !== 'subscription') return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await loadSubscriptions();
      if (cancelled) return;
      await loadLeaves();
    })();
    return () => {
      cancelled = true;
    };
  }, [subTab, loadSubscriptions, loadLeaves]);

  const handleLoadRecentAllowances = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetchAllowanceSlips({ take: 30 });
      const slips = Array.isArray(res.data) ? (res.data as AllowanceSlip[]) : [];
      setAllowanceList(slips);
      toast(slips.length ? `已載入 ${slips.length} 筆折讓一覽` : '尚無折讓單據', 'info');
    } catch (err) {
      toast(getErrorMessage(err, '讀取折讓一覽失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }, [toast]);

  useEffect(() => {
    if (subTab !== 'refund') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchAllowanceSlips({ take: 30 });
        if (cancelled) return;
        const slips = Array.isArray(res.data) ? (res.data as AllowanceSlip[]) : [];
        setAllowanceList(slips);
      } catch {
        // ignore auto-load errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subTab]);

  const handleRefundLookup = useCallback(async () => {
    const no = refundAllowanceNo.trim();
    if (!no) {
      toast('請填折讓單據號碼', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await fetchAllowanceSlip(no);
      const slip = res.data as AllowanceSlip;
      setLastAllowanceSlip(slip);
      setAllowanceList((prev) => [
        slip,
        ...prev.filter((s) => s.allowanceNo !== slip.allowanceNo),
      ]);
      toast(`折讓單據號碼：${slip.allowanceNo}`, 'success');
    } catch (err) {
      toast(getErrorMessage(err, '查詢失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }, [refundAllowanceNo, toast]);

  const handleReprintAllowance = useCallback(async () => {
    if (!lastAllowanceSlip?.allowanceNo) return;
    setBusy(true);
    try {
      const res = await fetchAllowanceSlip(lastAllowanceSlip.allowanceNo);
      const slip = res.data as AllowanceSlip;
      setLastAllowanceSlip(slip);
      printAllowanceSlip(slip);
      toast(`折讓單據號碼：${slip.allowanceNo}`, 'info');
    } catch (err) {
      try {
        printAllowanceSlip(lastAllowanceSlip);
        toast(`折讓單據號碼：${lastAllowanceSlip.allowanceNo}`, 'info');
      } catch {
        toast(getErrorMessage(err, '列印失敗'), 'error');
      }
    } finally {
      setBusy(false);
    }
  }, [lastAllowanceSlip, toast]);

  const handlePrintSlip = useCallback(
    (slip: AllowanceSlip) => {
      setLastAllowanceSlip(slip);
      setRefundAllowanceNo(slip.allowanceNo);
      try {
        printAllowanceSlip(slip);
        toast(`折讓單據號碼：${slip.allowanceNo}`, 'info');
      } catch (err) {
        toast(getErrorMessage(err, '列印失敗'), 'error');
      }
    },
    [toast],
  );
  const handleCancelSale = useCallback(async () => {
    const saleId = cancelSaleId.trim();
    if (!saleId) return;
    if (
      !window.confirm(
        `確定取消銷貨單 ${saleId}？已成交將回補庫存並退回零錢包；有發票時會先呼叫 ezPay 作廢或折讓。`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await opsCancelSale(saleId, cancelSaleReason);
      toast(result.message || '銷貨已取消', 'success');
      setCancelSaleId('');
      setCancelSaleReason('');
    } catch (err) {
      toast(getErrorMessage(err, '取消銷貨失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }, [cancelSaleId, cancelSaleReason, toast]);

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
        estimatedAllowance?: number;
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
          `本期天數：${d.periodDays ?? '—'}`,
          `最近訂單：${d.latestOrder?.id || '無'}／發票 ${d.latestOrder?.invoiceNumber || '無'}／$${d.latestOrder?.amount ?? 0}`,
          `預估折讓：$${d.estimatedAllowance ?? 0}（僅 CUT_UNUSED + 開折讓）`,
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
          ? '停續扣、截斷效期，並對未使用天數開立 ezPay 折讓'
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
      toast(result.message || '訂閱已取消', 'success');
      const slip = (result.data as { allowanceSlip?: AllowanceSlip | null } | undefined)
        ?.allowanceSlip;
      if (slip?.allowanceNo) {
        setLastAllowanceSlip(slip);
        setRefundAllowanceNo(slip.allowanceNo);
        setAllowanceList((prev) => [slip, ...prev.filter((s) => s.allowanceNo !== slip.allowanceNo)]);
        toast(`折讓單據號碼：${slip.allowanceNo}`, 'success');
        try {
          printAllowanceSlip(slip);
        } catch (printErr) {
          toast(getErrorMessage(printErr, `單號 ${slip.allowanceNo} 已開立，請至「折讓單據」查詢`), 'error');
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
  }, [selectedSubId, expirePolicy, doAllowance, cancelSubReason, toast, loadSubscriptions]);

  const handleStartLeave = useCallback(async () => {
    const memberId = Number(leaveMemberId);
    const days = Number(leaveDays);
    if (!Number.isInteger(memberId) || memberId <= 0) {
      toast('請輸入會員 ID', 'error');
      return;
    }
    if (!Number.isInteger(days) || days <= 0) {
      toast('請假天數須為正整數', 'error');
      return;
    }
    if (
      !window.confirm(
        `確定為會員 #${memberId} 請假 ${days} 天？\n效期將預先順延、進場暫停月費通行，定期定額暫停並順延扣款日。`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await startOpsMemberLeave({
        memberId,
        days,
        reason: leaveReason || undefined,
        subscriptionId: leaveSubId.trim() || undefined,
      });
      toast(result.message || '請假已建立', 'success');
      setLeaveReason('');
      await loadLeaves();
      await loadSubscriptions();
    } catch (err) {
      toast(getErrorMessage(err, '請假失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }, [leaveMemberId, leaveDays, leaveReason, leaveSubId, toast, loadLeaves, loadSubscriptions]);

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
        />
      )}

      {subTab === 'refund' && (
        <PageSection
          title="折讓單據"
          desc={
            branchName
              ? `目前作業分店：${branchName} · 以折讓單據號碼查詢／列印；退費折讓請於「一般報表」操作`
              : '以折讓單據號碼查詢／列印；退費折讓請於「一般報表」操作'
          }
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 360px)',
              gap: '1rem',
              alignItems: 'start',
            }}
            className="allowance-layout"
          >
            <div className="form-stack" style={{ gap: '1rem' }}>
              <Card
                title="查詢折讓單據"
                subtitle="僅需折讓單據號碼即可查詢並列印"
              >
                <div className="form-stack">
                  <Field label="折讓單據號碼" hint="退費折讓完成後顯示／列印的號碼">
                    <Input
                      value={refundAllowanceNo}
                      onChange={(e) => setRefundAllowanceNo(e.target.value.trim())}
                      placeholder="貼上折讓單據號碼"
                      className="mono"
                    />
                  </Field>
                  <div className="btn-row">
                    <Button
                      onClick={() => void handleRefundLookup()}
                      disabled={busy || !refundAllowanceNo.trim()}
                    >
                      查詢
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void handleReprintAllowance()}
                      disabled={busy || !lastAllowanceSlip?.allowanceNo}
                    >
                      列印單號
                    </Button>
                  </div>
                </div>
              </Card>

              {lastAllowanceSlip && (
                <Card
                  title="查詢結果"
                  subtitle={`折讓單據號碼 ${lastAllowanceSlip.allowanceNo}`}
                >
                  <div className="form-stack">
                    <p
                      className="mono"
                      style={{
                        fontSize: '1.25rem',
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        margin: 0,
                      }}
                    >
                      {lastAllowanceSlip.allowanceNo}
                    </p>
                    <p className="text-sm text-muted" style={{ margin: 0 }}>
                      原發票 {lastAllowanceSlip.invoiceNumber || '—'}
                      {' · '}
                      含稅 ${lastAllowanceSlip.totalAmt}
                      {lastAllowanceSlip.orderId || lastAllowanceSlip.saleOrderId
                        ? ` · 訂單 ${lastAllowanceSlip.orderId || lastAllowanceSlip.saleOrderId}`
                        : ''}
                    </p>
                    <Button onClick={() => void handleReprintAllowance()} disabled={busy}>
                      列印折讓單據號碼
                    </Button>
                  </div>
                </Card>
              )}
            </div>

            <Card
              title="退費折讓一覽"
              subtitle={
                allowanceList.length
                  ? `最近 ${allowanceList.length} 筆`
                  : '尚無資料'
              }
            >
              <div className="form-stack">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleLoadRecentAllowances()}
                  disabled={busy}
                >
                  重新載入
                </Button>
                {allowanceList.length === 0 ? (
                  <p className="text-sm text-muted" style={{ margin: 0 }}>
                    完成退費折讓後會出現於此，亦可輸入單號查詢。
                  </p>
                ) : (
                  <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>折讓單據號碼</th>
                          <th>金額</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {allowanceList.map((slip) => (
                          <tr
                            key={slip.allowanceNo}
                            style={
                              lastAllowanceSlip?.allowanceNo === slip.allowanceNo
                                ? { background: 'var(--color-muted-bg, #f5f5f5)' }
                                : undefined
                            }
                          >
                            <td>
                              <button
                                type="button"
                                className="mono text-sm"
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: 0,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  color: 'inherit',
                                  textDecoration: 'underline',
                                }}
                                onClick={() => {
                                  setRefundAllowanceNo(slip.allowanceNo);
                                  setLastAllowanceSlip(slip);
                                }}
                                title="帶入查詢"
                              >
                                {slip.allowanceNo}
                              </button>
                              <div className="text-muted" style={{ fontSize: 11 }}>
                                {slip.issuedAt
                                  ? new Date(slip.issuedAt).toLocaleString('zh-TW')
                                  : '—'}
                              </div>
                            </td>
                            <td>${slip.totalAmt}</td>
                            <td>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => handlePrintSlip(slip)}
                              >
                                列印
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
          </div>
          <style>{`
            @media (max-width: 900px) {
              .allowance-layout {
                grid-template-columns: 1fr !important;
              }
            }
          `}</style>
        </PageSection>
      )}

      {subTab === 'subscription' && (
        <PageSection
          title="月卡訂閱／請假"
          desc="取消訂閱可保留或截斷效期，並對未使用天數開立 ezPay 折讓；請假會順延效期與定期定額扣款日"
        >
          <div className="form-stack" style={{ gap: '1rem' }}>
            <Card title="訂閱一覽" subtitle="定期定額 CRS…">
              <div className="form-stack">
                <div className="list-toolbar">
                  <Field label="會員 ID（選填）">
                    <Input
                      value={subMemberFilter}
                      onChange={(e) => setSubMemberFilter(e.target.value)}
                      placeholder="例如 12"
                      inputMode="numeric"
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
                          <td colSpan={8} className="text-muted text-center">
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
                                  setLeaveSubId(s.id);
                                  setLeaveMemberId(String(s.memberId));
                                }}
                              />
                            </td>
                            <td className="text-sm">{s.id}</td>
                            <td className="text-sm">
                              {s.member?.name || `#${s.memberId}`}
                            </td>
                            <td className="text-sm">{s.promotion?.name || s.promotionId}</td>
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
                                          toast(r.message || '已恢復', 'success');
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
              subtitle="可貼訂閱編號 CRS，或首期／續扣訂單號（CRS／舊 TYK）自動反查；KEEP=保留效期｜CUT_UNUSED=截斷並折讓｜CUT_NO_ALLOWANCE=截斷不折讓"
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
                    <option value="CUT_UNUSED">CUT_UNUSED：截斷效期 + 未使用折讓</option>
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
                    呼叫 ezPay 開立折讓（依未使用天數／本期天數比例）
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

            <Card
              title="無限使用請假"
              subtitle="效期預先順延；請假期間禁止月費進場；定期定額暫停並順延 nextChargeAt"
            >
              <div className="form-stack">
                <Field label="會員 ID">
                  <Input
                    value={leaveMemberId}
                    onChange={(e) => setLeaveMemberId(e.target.value)}
                    placeholder="會員主鍵 ID"
                    inputMode="numeric"
                  />
                </Field>
                <Field label="請假天數">
                  <Input
                    value={leaveDays}
                    onChange={(e) => setLeaveDays(e.target.value)}
                    inputMode="numeric"
                  />
                </Field>
                <Field label="訂閱編號（選填）" hint="不填則自動帶此會員 ACTIVE／PAUSED 訂閱">
                  <Input
                    value={leaveSubId}
                    onChange={(e) => setLeaveSubId(e.target.value)}
                    placeholder="CRS…"
                  />
                </Field>
                <Field label="原因（選填）">
                  <Input
                    value={leaveReason}
                    onChange={(e) => setLeaveReason(e.target.value)}
                    placeholder="例：出國、傷病"
                  />
                </Field>
                <Button
                  onClick={() => void handleStartLeave()}
                  disabled={busy || !leaveMemberId.trim()}
                >
                  開始請假
                </Button>
              </div>
            </Card>

            <Card title="進行中請假" subtitle="提早銷假會扣回未休天數的效期與扣款順延">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>會員</th>
                      <th>天數</th>
                      <th>起迄</th>
                      <th>訂閱</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaves.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-muted text-center">
                          尚無進行中請假
                        </td>
                      </tr>
                    ) : (
                      leaves.map((lv) => (
                        <tr key={lv.id}>
                          <td>{lv.id}</td>
                          <td className="text-sm">
                            {lv.member?.name || `#${lv.memberId}`}
                          </td>
                          <td>{lv.days}</td>
                          <td className="text-sm">
                            {fmtDate(lv.startAt)}～{fmtDate(lv.endAt)}
                          </td>
                          <td className="text-sm">{lv.subscriptionId || '—'}</td>
                          <td>
                            <div className="btn-row">
                              <Button
                                variant="secondary"
                                disabled={busy}
                                onClick={() =>
                                  void (async () => {
                                    if (!window.confirm('確定提早銷假？')) return;
                                    setBusy(true);
                                    try {
                                      const r = await endOpsMemberLeave(lv.id);
                                      toast(r.message || '已銷假', 'success');
                                      await loadLeaves();
                                      await loadSubscriptions();
                                    } catch (e) {
                                      toast(getErrorMessage(e, '銷假失敗'), 'error');
                                    } finally {
                                      setBusy(false);
                                    }
                                  })()
                                }
                              >
                                提早銷假
                              </Button>
                              <Button
                                variant="secondary"
                                disabled={busy}
                                onClick={() =>
                                  void (async () => {
                                    setBusy(true);
                                    try {
                                      const r = await completeOpsMemberLeave(lv.id);
                                      toast(r.message || '已結案', 'success');
                                      await loadLeaves();
                                      await loadSubscriptions();
                                    } catch (e) {
                                      toast(getErrorMessage(e, '結案失敗'), 'error');
                                    } finally {
                                      setBusy(false);
                                    }
                                  })()
                                }
                              >
                                期滿結案
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <Button variant="secondary" onClick={() => void loadLeaves()} disabled={busy}>
                重新載入請假
              </Button>
            </Card>
          </div>
        </PageSection>
      )}

      {subTab === 'cancel' && (
        <PageSection
          title="取消進出場/交易"
          desc={
            branchName
              ? `目前作業分店：${branchName} · 銷貨 SAL…、進出場 ACC＋日期時間；儲值／銷售退費折讓請用「一般報表」；折讓單列印請用「折讓單據」`
              : '依單號處理：銷貨 SAL…、進出場 ACC＋日期時間；折讓單列印請用「折讓單據」'
          }
        >
          <div className="form-stack" style={{ gap: '1rem' }}>
            <Card
              title="取消商品銷售"
              subtitle="回補庫存、零錢包自動退回；有發票時自動 ezPay 作廢（失敗則折讓）。現金／刷卡／抵用券請人工退款"
            >
              <div className="form-stack">
                <Field label="銷貨單號" hint="一般報表「商品銷售」可查 SAL…">
                  <Input
                    value={cancelSaleId}
                    onChange={(e) => setCancelSaleId(e.target.value)}
                    placeholder="SAL20260722xxxxxx"
                  />
                </Field>
                <Field label="取消原因（選填）" hint="會寫入單據；作廢原因送 ezPay 時最多中文 6 字">
                  <Input
                    value={cancelSaleReason}
                    onChange={(e) => setCancelSaleReason(e.target.value)}
                    placeholder="例：錯賣、重複結帳"
                  />
                </Field>
                <Button
                  variant="danger"
                  onClick={() => void handleCancelSale()}
                  disabled={busy || !cancelSaleId.trim()}
                >
                  取消銷貨
                </Button>
              </div>
            </Card>
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
    </div>
  );
}
