import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select } from '../../../components/ui';
import ReasonModal from '../../../components/staff/ReasonModal';
import { useToast } from '../../../contexts/ToastContext';
import { createHqHrLeave, fetchHqHrLeaves, getErrorMessage, patchHqHrLeave } from '../../../lib/api';
import { LEAVE_STATUS_TONE, leaveBalanceSummary, shiftRangeLabel, shortDateTime } from '../../../lib/hrFormat';
import { ALL_LEAVE_TYPES, LEAVE_TYPE_LABELS, type LeaveType } from '../../../lib/laborLaw';
import type { LeaveOverview, LeaveStatus, StaffLeaveRow } from '../../../types/api';
import type { HqDataProps } from './types';

type Props = Pick<HqDataProps, 'staffList' | 'branches' | 'onReload'>;
type StatusTab = LeaveStatus | 'ALL';

const STATUS_TABS: { key: StatusTab; label: string }[] = [
  { key: 'PENDING', label: '待審' },
  { key: 'APPROVED', label: '已核准' },
  { key: 'REJECTED', label: '已拒絕' },
  { key: 'CANCELLED', label: '已撤銷' },
  { key: 'ALL', label: '全部' },
];

type Pending = { row: StaffLeaveRow; action: 'REJECTED' | 'CANCELLED' };

function staffName(r: StaffLeaveRow) {
  return r.staff?.displayName || r.staff?.name || `#${r.staffId}`;
}

function ConflictBadge({ row }: { row: StaffLeaveRow }) {
  if (!row.conflicts.length) return null;
  return (
    <span title={row.conflicts.map(shiftRangeLabel).join('\n')}>
      <Badge tone="warning">班表衝突 {row.conflicts.length} 班</Badge>
    </span>
  );
}

/** 總部請假：待審優先；核准／拒絕／撤銷走後端狀態機（額度、重疊、原因必填皆由後端檢查） */
export default function HqLeavePanel({ staffList, branches, onReload }: Props) {
  const { toast } = useToast();
  const [tab, setTab] = useState<StatusTab>('PENDING');
  const [branchId, setBranchId] = useState<number | ''>('');
  const [staffId, setStaffId] = useState<number | ''>('');
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<LeaveOverview | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const approvingRef = useRef<number | null>(null);

  const queryKey = JSON.stringify({ tab, branchId, staffId, reloadKey });
  const loading = loadedKey !== queryKey;

  useEffect(() => {
    let cancelled = false;
    fetchHqHrLeaves({
      status: tab === 'ALL' ? undefined : tab,
      branchId: branchId || undefined,
      staffId: staffId || undefined,
    })
      .then((res) => {
        if (!cancelled) setData(res.data ?? null);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入請假失敗'), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(queryKey);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, branchId, staffId, queryKey, toast]);

  const staffOptions = useMemo(
    () => staffList.filter((s) => branchId === '' || s.branchId === branchId),
    [staffList, branchId],
  );

  function afterChange() {
    setReloadKey((k) => k + 1);
    void onReload();
  }

  async function approve(row: StaffLeaveRow) {
    if (approvingRef.current) return;
    if (row.conflicts.length && !window.confirm(`此請假與 ${row.conflicts.length} 個已生效班次重疊，核准後須由店長調整班表。確定核准？`)) {
      return;
    }
    approvingRef.current = row.id;
    try {
      const res = await patchHqHrLeave(row.id, { status: 'APPROVED' });
      toast(res.message || '已核准', 'success');
      afterChange();
    } catch (err) {
      toast(getErrorMessage(err, '核准失敗'), 'error');
    } finally {
      approvingRef.current = null;
    }
  }

  async function submitReason(reason: string) {
    if (!pending) return false;
    try {
      const res = await patchHqHrLeave(pending.row.id, { status: pending.action, note: reason });
      toast(res.message || '已更新', 'success');
      afterChange();
      return true;
    } catch (err) {
      toast(getErrorMessage(err, '操作失敗'), 'error');
      return false;
    }
  }

  const counts = data?.counts;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <Card title="請假" className="hr-panel__card">
        <p className="text-muted text-sm">
          待審 → 核准／拒絕；已核准可撤銷（特休／國休額度自動回補）。拒絕與撤銷須填原因。與已生效班次重疊者標示「班表衝突」，
          核准後請通知店長調整四週排班（已發布須先撤回）。
        </p>
        <nav className="hq-tabs hq-tabs--leave" role="tablist">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`hq-tabs__btn ${tab === t.key ? 'is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {counts && ` ${t.key === 'ALL' ? total : counts[t.key]}`}
            </button>
          ))}
        </nav>
        <div className="roster__toolbar">
          <Field label="分店">
            <Select
              value={branchId === '' ? '' : String(branchId)}
              onChange={(e) => {
                setBranchId(e.target.value ? Number(e.target.value) : '');
                setStaffId('');
              }}
            >
              <option value="">全部分店</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="員工">
            <Select
              value={staffId === '' ? '' : String(staffId)}
              onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">全部員工</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.displayName || s.name}</option>
              ))}
            </Select>
          </Field>
        </div>
        {data?.truncated && <Alert tone="warning">僅顯示前 300 筆，請加上分店／員工篩選。</Alert>}
      </Card>

      <HqLeaveForm staffList={staffList} onCreated={afterChange} />

      {loading && !data ? (
        <p className="text-muted">載入中…</p>
      ) : !data || data.rows.length === 0 ? (
        <EmptyState icon="🌴" title={tab === 'PENDING' ? '沒有待審的請假' : '沒有符合條件的請假'} />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>員工</th>
                <th>假別</th>
                <th>期間</th>
                <th>時數</th>
                <th>事由</th>
                <th>狀態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {staffName(r)}
                    {!r.requestedBySelf && <div className="text-muted text-sm">總部代登</div>}
                  </td>
                  <td>{r.leaveTypeLabel}</td>
                  <td className="mono text-sm">
                    {shortDateTime(r.startAt)} – {shortDateTime(r.endAt)}
                  </td>
                  <td>{r.hours ?? '—'}</td>
                  <td className="text-sm">{r.reason || '—'}</td>
                  <td>
                    <Badge tone={LEAVE_STATUS_TONE[r.status]}>{r.statusLabel}</Badge> <ConflictBadge row={r} />
                    {r.review?.note && r.status !== 'APPROVED' && (
                      <div className="text-muted text-sm">{r.review.note}</div>
                    )}
                  </td>
                  <td className="hr-panel__actions">
                    {r.status === 'PENDING' && (
                      <>
                        <Button size="sm" onClick={() => void approve(r)}>核准</Button>
                        <Button size="sm" variant="danger" onClick={() => setPending({ row: r, action: 'REJECTED' })}>
                          拒絕
                        </Button>
                      </>
                    )}
                    {r.status === 'APPROVED' && (
                      <Button size="sm" variant="ghost" onClick={() => setPending({ row: r, action: 'CANCELLED' })}>
                        撤銷
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending && (
        <ReasonModal
          title={`${pending.action === 'REJECTED' ? '拒絕' : '撤銷'}請假｜${staffName(pending.row)}`}
          label={pending.action === 'REJECTED' ? '拒絕原因' : '撤銷原因'}
          confirmLabel={pending.action === 'REJECTED' ? '拒絕' : '撤銷'}
          danger
          onSubmit={submitReason}
          onClose={() => setPending(null)}
        >
          <p className="text-sm">
            {pending.row.leaveTypeLabel}｜{shortDateTime(pending.row.startAt)} – {shortDateTime(pending.row.endAt)}
            {pending.action === 'CANCELLED' && '（撤銷後額度回補）'}
          </p>
        </ReasonModal>
      )}
    </>
  );
}

function HqLeaveForm({ staffList, onCreated }: { staffList: Props['staffList']; onCreated: () => void }) {
  const { toast } = useToast();
  const [staffId, setStaffId] = useState<number | ''>('');
  const [leaveType, setLeaveType] = useState<LeaveType>('ANNUAL');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [hours, setHours] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  const selected = staffList.find((s) => s.id === staffId);
  const balanceText = leaveBalanceSummary(selected?.leaveBalance);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (staffId === '' || !start || !end || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await createHqHrLeave({
        staffId: Number(staffId),
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        leaveType,
        hours: hours.trim() ? Number(hours) : undefined,
        reason: reason.trim() || undefined,
      });
      toast(res.message || '已建立', 'success');
      setHours('');
      setReason('');
      onCreated();
    } catch (err) {
      toast(getErrorMessage(err, '建立失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <details className="card schedule-overview__manual">
      <summary>＋ 總部代登請假（直接核准）</summary>
      <form onSubmit={onSubmit} className="hr-holiday-form">
        <Field label="員工">
          <Select
            value={staffId === '' ? '' : String(staffId)}
            onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : '')}
            required
          >
            <option value="">選擇員工</option>
            {staffList.map((s) => (
              <option key={s.id} value={s.id}>{s.displayName || s.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="假別">
          <Select value={leaveType} onChange={(e) => setLeaveType(e.target.value as LeaveType)}>
            {ALL_LEAVE_TYPES.map((t) => (
              <option key={t} value={t}>{LEAVE_TYPE_LABELS[t]}</option>
            ))}
          </Select>
        </Field>
        <Field label="開始">
          <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
        </Field>
        <Field label="結束">
          <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </Field>
        <Field label="時數（選填）" hint="未填：同日依起訖（上限 8），跨日以日數 × 8">
          <Input type="number" inputMode="decimal" min={0.5} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        <Field label="事由">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
        <Button type="submit" loading={busy} disabled={staffId === ''}>代登</Button>
      </form>
      {balanceText && <p className="text-muted text-sm">{balanceText}</p>}
    </details>
  );
}
