import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal } from '../ui';
import ReasonModal from './ReasonModal';
import { useToast } from '../../contexts/ToastContext';
import {
  approveOpsMemberLeave,
  completeOpsMemberLeave,
  createOpsMemberLeave,
  endOpsMemberLeave,
  fetchOpsMemberLeaves,
  getErrorMessage,
  rejectOpsMemberLeave,
  requestOpsMemberLeaveProofAccess,
  uploadOpsMemberLeaveProof,
} from '../../lib/api';
import { LEAVE_CATEGORY_OPTIONS, isDeferrableLeaveCategory, leaveStatusLabel } from '../../lib/memberLeave';
import type { MemberLeave, MemberLeaveCategory } from '../../types/api';

export type LeavePrefill = { subscriptionId: string; memberNo: string };

type Props = {
  /** 外部會員編號篩選（訂閱區共用） */
  memberNoFilter?: string;
  /** 訂閱列表點選時帶入代建表單 */
  prefill?: LeavePrefill | null;
  /** 生效／銷假會動到訂閱狀態 */
  onSubscriptionsChanged?: () => Promise<void> | void;
};

const OPEN_STATUSES = 'PENDING,APPROVED,ACTIVE';

function fmtDate(v?: string | null) {
  if (!v) return '—';
  return new Date(v).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
}

/** endAt 為迄日次日 00:00（不含） */
function lastDay(endAt: string) {
  return fmtDate(new Date(new Date(endAt).getTime() - 1).toISOString());
}

function todayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'PENDING') return 'warning';
  if (status === 'APPROVED') return 'info';
  if (status === 'ACTIVE') return 'success';
  if (status === 'REJECTED') return 'danger';
  return 'neutral';
}

export default function MemberLeaveReviewPanel({ memberNoFilter = '', prefill = null, onSubscriptionsChanged }: Props) {
  const { toast } = useToast();
  const [leaves, setLeaves] = useState<MemberLeave[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  const [memberNo, setMemberNo] = useState('');
  const [category, setCategory] = useState<MemberLeaveCategory | ''>('');
  const [startDate, setStartDate] = useState(todayIso);
  const [endDate, setEndDate] = useState(todayIso);
  const [subId, setSubId] = useState('');
  const [reason, setReason] = useState('');
  const [proofFile, setProofFile] = useState<File | null>(null);
  const proofInputRef = useRef<HTMLInputElement | null>(null);
  const [approveNow, setApproveNow] = useState(true);
  const [appliedPrefill, setAppliedPrefill] = useState<LeavePrefill | null>(null);
  if (prefill && prefill !== appliedPrefill) {
    setAppliedPrefill(prefill);
    setSubId(prefill.subscriptionId);
    setMemberNo(prefill.memberNo);
  }

  const [rejectTarget, setRejectTarget] = useState<MemberLeave | null>(null);
  const [proofTarget, setProofTarget] = useState<MemberLeave | null>(null);
  const [proofView, setProofView] = useState<{ leave: MemberLeave; url: string; expiresAt: string } | null>(null);

  const loadLeaves = useCallback(async () => {
    try {
      const params: { memberNo?: string; status?: string } = { status: OPEN_STATUSES };
      const no = (memberNo || memberNoFilter).trim().toUpperCase();
      if (/^[A-Z0-9]{6}$/.test(no)) params.memberNo = no;
      const res = await fetchOpsMemberLeaves(params);
      if (res.status === 'success' && Array.isArray(res.data)) setLeaves(res.data as MemberLeave[]);
    } catch (err) {
      toast(getErrorMessage(err, '讀取暫停申請失敗'), 'error');
    }
  }, [memberNo, memberNoFilter, toast]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await loadLeaves();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadLeaves]);

  const run = useCallback(
    async (fn: () => Promise<{ message?: string }>, fallback: string, refreshSubs = false) => {
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      setBusy(true);
      try {
        const r = await fn();
        toast(r.message || '已完成', 'success');
        await loadLeaves();
        if (refreshSubs) await onSubscriptionsChanged?.();
        return true;
      } catch (err) {
        toast(getErrorMessage(err, fallback), 'error');
        return false;
      } finally {
        inFlightRef.current = false;
        setBusy(false);
      }
    },
    [loadLeaves, onSubscriptionsChanged, toast],
  );

  async function handleCreate() {
    const no = memberNo.trim().toUpperCase();
    if (!no) return toast('請輸入會員編號', 'error');
    if (!category) return toast('請選擇暫停事由', 'error');
    if (!startDate || !endDate || endDate < startDate) return toast('暫停起迄日無效', 'error');
    if (!proofFile && !isDeferrableLeaveCategory(category)) return toast('此事由須檢附證明', 'error');
    if (approveNow && !proofFile) return toast('當場核准須先檢附證明', 'error');
    const ok = await run(
      () =>
        createOpsMemberLeave({
          memberNo: no,
          category,
          startDate,
          endDate,
          reason: reason || undefined,
          subscriptionId: subId.trim() || undefined,
          proofFile,
          approveNow,
        }),
      '建立暫停申請失敗',
      approveNow,
    );
    if (ok) {
      setReason('');
      setProofFile(null);
      if (proofInputRef.current) proofInputRef.current.value = '';
    }
  }

  async function openProof(lv: MemberLeave, reason: string) {
    if (reason.length < 4) {
      toast('請填寫調閱原因（至少 4 字）', 'error');
      return false;
    }
    try {
      const res = await requestOpsMemberLeaveProofAccess(lv.id, reason);
      if (res.status !== 'success' || !res.data?.url) {
        toast(res.message || '簽發調閱失敗', 'error');
        return false;
      }
      setProofView({ leave: lv, url: res.data.url, expiresAt: res.data.expiresAt });
      return true;
    } catch (err) {
      toast(getErrorMessage(err, '調閱失敗'), 'error');
      return false;
    }
  }

  return (
    <>
      <Card
        title="櫃檯代建會籍暫停（契約第十二條）"
        subtitle="會員自助申請一律待審；櫃檯代建可由值班主管核對證明後當場核准。核准生效後效期順延、月費進場暫停、定期定額暫停"
      >
        <div className="form-stack">
          <Field label="會員編號">
            <Input value={memberNo} onChange={(e) => setMemberNo(e.target.value)} placeholder="6 碼英數，例如 A1B2C3" />
          </Field>
          <Field label="暫停事由" hint={LEAVE_CATEGORY_OPTIONS.find((o) => o.value === category)?.hint}>
            <select
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value as MemberLeaveCategory | '')}
            >
              <option value="">請選擇</option>
              {LEAVE_CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="起始日" hint={isDeferrableLeaveCategory(category) ? '傷病／疫情可回溯 30 日' : '須事先申請'}>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (endDate < e.target.value) setEndDate(e.target.value);
              }}
            />
          </Field>
          <Field label="結束日">
            <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
          <Field label="訂閱編號（選填）" hint="不填則自動帶此會員 ACTIVE／PAUSED 訂閱">
            <Input value={subId} onChange={(e) => setSubId(e.target.value)} placeholder="CRS…" />
          </Field>
          <Field label="事由證明" hint="JPG／PNG／WebP；傷病／疫情可先送件 30 日內補附">
            <input
              ref={proofInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="input"
              onChange={(e) => setProofFile(e.target.files?.[0] || null)}
            />
          </Field>
          <Field label="備註（選填）">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <label className="checkbox-item">
            <input type="checkbox" checked={approveNow} onChange={(e) => setApproveNow(e.target.checked)} />
            已核對證明，當場核准（留審核紀錄）
          </label>
          <Button onClick={() => void handleCreate()} disabled={busy || !memberNo.trim() || !category}>
            {approveNow ? '建立並核准' : '建立待審申請'}
          </Button>
        </div>
      </Card>

      <Card title="暫停申請與進行中暫停" subtitle="待審須於七個工作日內審核；提早銷假只計實際凍結天數">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>狀態</th>
                <th>會員</th>
                <th>事由</th>
                <th>起迄（天數）</th>
                <th>證明</th>
                <th>期限</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {leaves.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-muted text-center">
                    尚無待審或進行中暫停
                  </td>
                </tr>
              ) : (
                leaves.map((lv) => (
                  <tr key={lv.id}>
                    <td>
                      <Badge tone={statusTone(lv.status)}>{leaveStatusLabel(lv.status)}</Badge>
                      {lv.source === 'STAFF' && <div className="text-sm text-muted">櫃檯代建</div>}
                    </td>
                    <td className="text-sm">
                      {lv.member?.name || `#${lv.memberId}`}
                      <div className="text-muted">{lv.member?.memberNo || '—'}</div>
                    </td>
                    <td className="text-sm">
                      {lv.categoryLabel || '—'}
                      {lv.reason && <div className="text-muted">{lv.reason}</div>}
                    </td>
                    <td className="text-sm">
                      {fmtDate(lv.startAt)}～{lastDay(lv.endAt)}（{lv.days}）
                    </td>
                    <td className="text-sm">
                      {lv.hasProof ? (
                        <Button size="sm" variant="ghost" onClick={() => setProofTarget(lv)}>
                          調閱
                        </Button>
                      ) : (
                        <span className="text-muted">未附（{fmtDate(lv.proofDueAt)} 前）</span>
                      )}
                    </td>
                    <td className="text-sm">
                      {lv.status === 'PENDING' && lv.reviewDueAt ? (
                        lv.reviewOverdue ? (
                          <Badge tone="danger">審核逾期</Badge>
                        ) : (
                          fmtDate(lv.reviewDueAt)
                        )
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <div className="btn-row">
                        {lv.status === 'PENDING' && (
                          <>
                            <Button
                              size="sm"
                              disabled={busy || !lv.hasProof}
                              onClick={() => {
                                if (!window.confirm(`核准 ${lv.member?.name || ''} 暫停 ${lv.days} 天？起日已到即生效並順延效期。`)) return;
                                void run(() => approveOpsMemberLeave(lv.id), '核准失敗', true);
                              }}
                            >
                              核准
                            </Button>
                            {!lv.hasProof && (
                              <label className="btn btn--secondary btn--sm">
                                補附證明
                                <input
                                  type="file"
                                  accept="image/jpeg,image/png,image/webp"
                                  hidden
                                  disabled={busy}
                                  onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    e.target.value = '';
                                    if (f) void run(() => uploadOpsMemberLeaveProof(lv.id, f), '補附證明失敗');
                                  }}
                                />
                              </label>
                            )}
                          </>
                        )}
                        {(lv.status === 'PENDING' || lv.status === 'APPROVED') && (
                          <Button size="sm" variant="danger" disabled={busy} onClick={() => setRejectTarget(lv)}>
                            退回
                          </Button>
                        )}
                        {lv.status === 'ACTIVE' && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => {
                                if (!window.confirm('確定提早銷假？將扣回未休天數之效期順延。')) return;
                                void run(() => endOpsMemberLeave(lv.id), '銷假失敗', true);
                              }}
                            >
                              提早銷假
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void run(() => completeOpsMemberLeave(lv.id), '結案失敗', true)}
                            >
                              期滿結案
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Button variant="secondary" onClick={() => void loadLeaves()} disabled={busy}>
          重新載入
        </Button>
      </Card>

      {rejectTarget && (
        <ReasonModal
          title={`退回暫停申請 #${rejectTarget.id}`}
          label="退回原因（會員可見，至少 2 字）"
          confirmLabel="退回"
          danger
          onClose={() => setRejectTarget(null)}
          onSubmit={(text) => run(() => rejectOpsMemberLeave(rejectTarget.id, text), '退回失敗')}
        />
      )}

      {proofTarget && (
        <ReasonModal
          title={`調閱暫停證明 #${proofTarget.id}`}
          label="調閱原因（至少 4 字，將寫入稽核紀錄）"
          confirmLabel="簽發短效連結"
          onClose={() => setProofTarget(null)}
          onSubmit={(text) => openProof(proofTarget, text)}
        >
          <p className="text-sm text-muted" style={{ marginTop: 0 }}>
            診斷證明等屬個資法特種個資；每次調閱皆記錄經辦、分店與來源 IP。
          </p>
        </ReasonModal>
      )}

      <Modal
        open={Boolean(proofView)}
        title={`暫停證明 #${proofView?.leave.id ?? ''}`}
        onClose={() => setProofView(null)}
        wide
      >
        {proofView && (
          <>
            <p className="text-sm text-muted" style={{ marginTop: 0 }}>
              連結於 {new Date(proofView.expiresAt).toLocaleTimeString('zh-TW')} 失效，請勿另存或轉傳。
            </p>
            <img
              src={proofView.url}
              alt="暫停事由證明"
              style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto' }}
            />
          </>
        )}
      </Modal>
    </>
  );
}
