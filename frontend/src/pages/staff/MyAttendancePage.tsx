import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageSection, Select } from '../../components/ui';
import MyPayslipCard from '../../components/staff/MyPayslipCard';
import StaffNotificationsCard from '../../components/staff/StaffNotificationsCard';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  cancelMyLeave,
  fetchMyAttendance,
  fetchMyLeaves,
  getErrorMessage,
  staffHrLeaveRequest,
  staffHrPunchIn,
  staffHrPunchOut,
} from '../../lib/api';
import {
  ATTENDANCE_FLAG_META,
  DUTY_STATE_META,
  dutyShiftLabel,
  LEAVE_STATUS_TONE,
  formatMinutes,
  hhmm,
  leaveBalanceSummary,
  shiftRangeLabel,
  shortDateTime,
  taipeiParts,
  weekdayLabel,
} from '../../lib/hrFormat';
import type { LeaveType } from '../../lib/laborLaw';
import type { AttendanceRecord, MyAttendance, MyLeaves } from '../../types/api';

/** 員工自助：上下班打卡、今日班次、近 30 日考勤、請假申請、薪資單；身分一律取自員工 JWT */
export default function MyAttendancePage() {
  return (
    <PageSection title="我的出勤" desc="上下班打卡、查看班次與考勤、申請請假、薪資單、通知與 LINE 推播">
      <PunchSection />
      <LeaveSection />
      <MyPayslipCard />
      <StaffNotificationsCard />
    </PageSection>
  );
}

function RecordFlags({ row }: { row: AttendanceRecord }) {
  const shown = row.flags.filter((f) => f !== 'BACKFILLED');
  if (!shown.length) return <Badge tone="success">正常</Badge>;
  return (
    <span className="attendance__flags">
      {shown.map((f) => (
        <Badge key={f} tone={ATTENDANCE_FLAG_META[f].tone}>
          {ATTENDANCE_FLAG_META[f].label}
          {f === 'LATE' && ` ${row.lateMinutes} 分`}
          {f === 'EARLY_LEAVE' && ` ${row.earlyMinutes} 分`}
        </Badge>
      ))}
    </span>
  );
}

function PunchSection() {
  const { toast } = useToast();
  const { duty, setDuty, refreshDuty } = useStaffAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<MyAttendance | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const punchRef = useRef(false);
  const promptRequested = searchParams.get('punch') === '1';

  useEffect(() => {
    let cancelled = false;
    fetchMyAttendance()
      .then((res) => {
        if (!cancelled) setData(res.data ?? null);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入出勤失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  function closePrompt() {
    const next = new URLSearchParams(searchParams);
    next.delete('punch');
    setSearchParams(next, { replace: true });
  }

  async function punch(kind: 'in' | 'out') {
    if (punchRef.current) return;
    punchRef.current = true;
    setBusy(true);
    try {
      const res = kind === 'in' ? await staffHrPunchIn() : await staffHrPunchOut();
      const stale = kind === 'in' && (res.data as { staleClosedId?: number | null } | undefined)?.staleClosedId;
      toast(res.message || '打卡成功', stale ? 'info' : 'success');
      if (res.data?.duty) setDuty(res.data.duty);
    } catch (err) {
      toast(getErrorMessage(err, '打卡失敗'), 'error');
      void refreshDuty();
    } finally {
      punchRef.current = false;
      setBusy(false);
      setReloadKey((k) => k + 1);
      if (promptRequested) closePrompt();
    }
  }

  if (!data) return <p className="text-muted">載入中…</p>;
  const open = data.open && !data.open.stale ? data.open : null;
  const s = data.summary;
  const canPunchIn = !open && (duty ? duty.canPunchIn : true);
  const stateMeta = duty ? DUTY_STATE_META[duty.state] : null;

  return (
    <>
      <Modal
        open={promptRequested && Boolean(duty?.canPunchIn) && !open}
        title="班表值勤確認"
        onClose={closePrompt}
        footer={
          <div className="btn-row">
            <Button variant="ghost" onClick={closePrompt} disabled={busy}>
              稍後
            </Button>
            <Button onClick={() => void punch('in')} loading={busy}>
              打上班卡
            </Button>
          </div>
        }
      >
        <p>您是本時段班表值勤人員：</p>
        <p>
          <strong>{duty?.shift ? dutyShiftLabel(duty.shift) : '—'}</strong>
        </p>
        <p className="text-muted text-sm">
          上班卡將綁定此班次與分店；遲到／早退由系統依班表計算（寬限 {data.graceMinutes} 分鐘）。
        </p>
      </Modal>

      <Card title="今日打卡" className="hr-panel__card">
        <div className="my-hr__punch">
          <div>
            <p className="my-hr__status">
              {open ? (
                <>
                  <Badge tone="info" dot>上班中</Badge> 自 {hhmm(open.punchIn)} 起
                </>
              ) : (
                <Badge>未上班</Badge>
              )}
              {stateMeta && !duty?.exempt && (
                <>
                  {' '}
                  <Badge tone={stateMeta.tone}>{stateMeta.label}</Badge>
                </>
              )}
            </p>
            {duty && !duty.exempt && (
              <p className="text-sm">
                {duty.shift ? <>值勤班次：{dutyShiftLabel(duty.shift)}</> : duty.message}
                {duty.state === 'ON_LEAVE' && duty.leave && (
                  <span className="text-muted">（請假至 {shortDateTime(duty.leave.endAt)}）</span>
                )}
              </p>
            )}
            {data.open?.stale && (
              <Alert tone="warning">
                上一筆上班卡已逾 {data.maxShiftHours} 小時未下班，將記為「未打下班卡」，請洽主管更正。
              </Alert>
            )}
            <p className="text-sm">
              今日班次（{data.todayKey}）：
              {data.todayShifts.length ? data.todayShifts.map(shiftRangeLabel).join('、') : '無'}
            </p>
            {duty?.nextShift ? (
              <p className="text-muted text-sm">
                下一班：{dutyShiftLabel(duty.nextShift)}（{hhmm(duty.nextShift.punchInOpensAt)} 起可打卡）
              </p>
            ) : (
              data.nextShift && (
                <p className="text-muted text-sm">
                  下一班：{taipeiParts(data.nextShift.startAt).date}（{weekdayLabel(taipeiParts(data.nextShift.startAt).date)}）
                  {shiftRangeLabel(data.nextShift)}
                </p>
              )
            )}
            <p className="text-muted text-sm">
              上班卡僅限班表值勤時段（班次開始前 {duty?.earlyMinutes ?? 30} 分鐘起至班次結束）；班外出勤請洽總部補登。
            </p>
          </div>
          <div className="my-hr__punch-actions">
            <Button onClick={() => void punch('in')} loading={busy && !open} disabled={busy || !canPunchIn}>
              上班打卡
            </Button>
            <Button variant="secondary" onClick={() => void punch('out')} loading={busy && !!open} disabled={busy || !open}>
              下班打卡
            </Button>
          </div>
        </div>
      </Card>

      <Card title="近 30 日考勤" className="hr-panel__card">
        <div className="hr-panel__chips">
          <Badge>出勤 {s.records} 筆</Badge>
          <Badge>工時 {formatMinutes(s.workedMinutes)}</Badge>
          <Badge tone={s.late ? 'warning' : 'neutral'}>遲到 {s.late}</Badge>
          <Badge tone={s.earlyLeave ? 'warning' : 'neutral'}>早退 {s.earlyLeave}</Badge>
          <Badge tone={s.missedPunchOut ? 'danger' : 'neutral'}>未打下班卡 {s.missedPunchOut}</Badge>
          <Badge tone={s.absent ? 'danger' : 'neutral'}>曠職 {s.absent}</Badge>
        </div>
        <p className="text-muted text-sm">
          遲到／早退寬限 {data.graceMinutes} 分鐘；如有錯誤（忘記打卡、設備故障）請洽主管補登或更正。
        </p>
        {data.absences.length > 0 && (
          <Alert tone="warning">
            曠職：{data.absences.map((a) => `${a.dateKey} ${shiftRangeLabel(a)}`).join('、')}
          </Alert>
        )}
        {data.recent.length === 0 ? (
          <EmptyState icon="🕘" title="近 30 日沒有打卡紀錄" />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>班次</th>
                  <th>上班</th>
                  <th>下班</th>
                  <th>工時</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.dateKey}（{weekdayLabel(r.dateKey)}）</td>
                    <td className="text-sm">{r.schedule ? shiftRangeLabel(r.schedule) : '—'}</td>
                    <td className="mono">{hhmm(r.punchIn)}</td>
                    <td className="mono">{r.punchOut ? hhmm(r.punchOut) : '—'}</td>
                    <td>{formatMinutes(r.workedMinutes)}</td>
                    <td><RecordFlags row={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function LeaveSection() {
  const { toast } = useToast();
  const [data, setData] = useState<MyLeaves | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [leaveType, setLeaveType] = useState<LeaveType>('ANNUAL');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [hours, setHours] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchMyLeaves()
      .then((res) => {
        if (!cancelled) setData(res.data ?? null);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入請假失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!start || !end || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await staffHrLeaveRequest({
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        leaveType,
        hours: hours.trim() ? Number(hours) : undefined,
        reason: reason.trim() || undefined,
      });
      toast(res.message || '已送出', 'success');
      setStart('');
      setEnd('');
      setHours('');
      setReason('');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '請假申請失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  async function onCancel(id: number) {
    if (!window.confirm('撤回此請假申請？')) return;
    try {
      const res = await cancelMyLeave(id);
      toast(res.message || '已撤回', 'success');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '撤回失敗'), 'error');
    }
  }

  const balanceText = leaveBalanceSummary(data?.balance);

  return (
    <Card title="請假" className="hr-panel__card">
      {balanceText && <p className="text-sm">{balanceText}</p>}
      <form onSubmit={onSubmit} className="hr-holiday-form">
        <Field label="假別">
          <Select value={leaveType} onChange={(e) => setLeaveType(e.target.value as LeaveType)}>
            {(data?.leaveTypes ?? []).map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
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
        <Button type="submit" loading={busy}>送出申請</Button>
      </form>
      <p className="text-muted text-sm">特休／國休額度與重疊由系統檢查；送出後待主管審核，審核前可撤回。</p>

      {data && data.rows.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>假別</th>
                <th>期間</th>
                <th>時數</th>
                <th>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.leaveTypeLabel}</td>
                  <td className="mono text-sm">{shortDateTime(r.startAt)} – {shortDateTime(r.endAt)}</td>
                  <td>{r.hours ?? '—'}</td>
                  <td>
                    <Badge tone={LEAVE_STATUS_TONE[r.status]}>{r.statusLabel}</Badge>
                    {r.conflicts.length > 0 && r.status === 'APPROVED' && (
                      <div className="text-muted text-sm">已排 {r.conflicts.length} 班，請與店長確認調班</div>
                    )}
                    {r.review?.note && r.status !== 'APPROVED' && (
                      <div className="text-muted text-sm">{r.review.note}</div>
                    )}
                  </td>
                  <td>
                    {r.status === 'PENDING' && (
                      <Button size="sm" variant="ghost" onClick={() => void onCancel(r.id)}>撤回</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
