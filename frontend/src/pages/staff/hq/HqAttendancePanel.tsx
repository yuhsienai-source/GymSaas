import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import { correctHqHrAttendance, createHqHrAttendance, fetchHqHrAttendance, getErrorMessage } from '../../../lib/api';
import {
  ATTENDANCE_FLAG_META,
  SCHEDULE_SOURCE_LABELS,
  addDaysKey,
  formatMinutes,
  hhmm,
  shiftRangeLabel,
  taipeiParts,
  taipeiRangeIso,
  weekdayLabel,
} from '../../../lib/hrFormat';
import { taipeiToday } from '../../../lib/laborLaw';
import type { AttendanceAbsence, AttendanceFlag, AttendanceOverview, AttendanceRecord } from '../../../types/api';
import type { HqDataProps } from './types';

type Props = Pick<HqDataProps, 'staffList' | 'branches'>;
type FlagFilter = AttendanceFlag | 'ABSENT' | '';
type View = 'detail' | 'staff';

const RANGE_DAYS = 7;
const FLAG_OPTIONS: { value: FlagFilter; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'LATE', label: '遲到' },
  { value: 'EARLY_LEAVE', label: '早退' },
  { value: 'MISSED_PUNCH_OUT', label: '未打下班卡' },
  { value: 'ABSENT', label: '曠職' },
  { value: 'OPEN', label: '上班中' },
  { value: 'UNSCHEDULED', label: '未排班出勤' },
  { value: 'CORRECTED', label: '已更正' },
  { value: 'BACKFILLED', label: '總部補登' },
];
const HIDDEN_BADGES: AttendanceFlag[] = ['LATE', 'EARLY_LEAVE'];

type BackfillPreset = {
  staffId: number;
  branchId: number | null;
  date: string;
  start: string;
  end: string;
  /** 自曠職列補登：綁定該班次 */
  scheduleId?: number;
  scheduleLabel?: string;
};

function staffName(s: { name: string; displayName?: string | null } | null | undefined, id: number) {
  return s?.displayName || s?.name || `#${id}`;
}

function FlagBadges({ row }: { row: AttendanceRecord }) {
  return (
    <span className="attendance__flags">
      {row.flags.includes('LATE') && <Badge tone="warning">遲到 {row.lateMinutes} 分</Badge>}
      {row.flags.includes('EARLY_LEAVE') && <Badge tone="warning">早退 {row.earlyMinutes} 分</Badge>}
      {row.flags
        .filter((f) => !HIDDEN_BADGES.includes(f))
        .map((f) => (
          <Badge key={f} tone={ATTENDANCE_FLAG_META[f].tone}>{ATTENDANCE_FLAG_META[f].label}</Badge>
        ))}
      {!row.flags.some((f) => f !== 'CORRECTED' && f !== 'BACKFILLED') && <Badge tone="success">正常</Badge>}
    </span>
  );
}

/** 總部考勤：打卡與已生效班表比對（遲到／早退／未打下班卡／曠職由後端判定），補登與更正必填原因 */
export default function HqAttendancePanel({ staffList, branches }: Props) {
  const { toast } = useToast();
  const [to, setTo] = useState(() => taipeiToday());
  const [from, setFrom] = useState(() => addDaysKey(taipeiToday(), -(RANGE_DAYS - 1)));
  const [branchId, setBranchId] = useState<number | ''>('');
  const [staffId, setStaffId] = useState<number | ''>('');
  const [flag, setFlag] = useState<FlagFilter>('');
  const [view, setView] = useState<View>('detail');
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<AttendanceOverview | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [editing, setEditing] = useState<AttendanceRecord | null>(null);
  const [preset, setPreset] = useState<BackfillPreset | null>(null);

  const queryKey = JSON.stringify({ from, to, branchId, staffId, flag, reloadKey });
  const loading = loadedKey !== queryKey;

  useEffect(() => {
    let cancelled = false;
    fetchHqHrAttendance({
      from,
      to,
      branchId: branchId || undefined,
      staffId: staffId || undefined,
      flag: flag || undefined,
    })
      .then((res) => {
        if (!cancelled) setData(res.data ?? null);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入考勤失敗'), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(queryKey);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, branchId, staffId, flag, queryKey, toast]);

  const branchName = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);
  const staffOptions = useMemo(
    () => staffList.filter((s) => branchId === '' || s.branchId === branchId),
    [staffList, branchId],
  );
  const reload = () => setReloadKey((k) => k + 1);

  function shiftRange(days: number) {
    setFrom((f) => addDaysKey(f, days));
    setTo((t) => addDaysKey(t, days));
  }

  function backfillFromAbsence(a: AttendanceAbsence) {
    const s = taipeiParts(a.startAt);
    setPreset({
      staffId: a.staffId,
      branchId: a.branchId,
      date: s.date,
      start: s.time,
      end: hhmm(a.endAt),
      scheduleId: a.id,
      scheduleLabel: `${s.date} ${shiftRangeLabel(a)}`,
    });
  }

  const summary = data?.summary;
  const branchLabel = (id: number | null) => (id ? branchName.get(id) ?? `#${id}` : '—');

  return (
    <>
      <Card title="考勤" className="hr-panel__card">
        <p className="text-muted text-sm">
          打卡與已生效班表（已發布四週排班、已核准週班表、既有總部臨時排班）比對；寬限 {data?.graceMinutes ?? 5} 分鐘。
          曠職＝已結束之班次無打卡且無核准請假。補登與更正必填原因並留存經辦人。
        </p>
        <div className="roster__toolbar">
          <Field label="起日">
            <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </Field>
          <Field label="迄日">
            <Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </Field>
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
          <Field label="狀態">
            <Select value={flag} onChange={(e) => setFlag(e.target.value as FlagFilter)}>
              {FLAG_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="roster__toolbar">
          <Button size="sm" variant="secondary" onClick={() => shiftRange(-RANGE_DAYS)}>← 前 7 日</Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const today = taipeiToday();
              setTo(today);
              setFrom(addDaysKey(today, -(RANGE_DAYS - 1)));
            }}
          >
            近 7 日
          </Button>
          <Button size="sm" variant="secondary" onClick={() => shiftRange(RANGE_DAYS)}>後 7 日 →</Button>
          <span className="hq-tabs hq-tabs--sub hr-panel__view" role="tablist">
            {(['detail', 'staff'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className={`hq-tabs__btn ${view === v ? 'is-active' : ''}`}
                onClick={() => setView(v)}
              >
                {v === 'detail' ? '打卡明細' : '員工彙總'}
              </button>
            ))}
          </span>
        </div>
        {summary && (
          <div className="hr-panel__chips">
            <Badge>出勤 {summary.records} 筆</Badge>
            <Badge>工時 {formatMinutes(summary.workedMinutes)}</Badge>
            <Badge tone={summary.late ? 'warning' : 'neutral'}>遲到 {summary.late}</Badge>
            <Badge tone={summary.earlyLeave ? 'warning' : 'neutral'}>早退 {summary.earlyLeave}</Badge>
            <Badge tone={summary.missedPunchOut ? 'danger' : 'neutral'}>未打下班卡 {summary.missedPunchOut}</Badge>
            <Badge tone={summary.absent ? 'danger' : 'neutral'}>曠職 {summary.absent}</Badge>
            <Badge tone="info">上班中 {summary.open}</Badge>
            <Badge>未排班出勤 {summary.unscheduled}</Badge>
          </div>
        )}
        {data?.truncated && <Alert tone="warning">資料過多僅顯示前 2000 筆，請縮小區間或加上篩選。</Alert>}
      </Card>

      <BackfillForm
        staffList={staffList}
        branches={branches}
        preset={preset}
        onDone={() => {
          setPreset(null);
          reload();
        }}
      />

      {loading && !data ? (
        <p className="text-muted">載入中…</p>
      ) : !data ? null : view === 'staff' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>員工</th>
                <th>排定班次</th>
                <th>出勤筆數</th>
                <th>工時</th>
                <th>遲到</th>
                <th>早退</th>
                <th>未打下班卡</th>
                <th>曠職</th>
              </tr>
            </thead>
            <tbody>
              {data.byStaff.map((s) => (
                <tr key={s.staffId}>
                  <td>{staffName(s.staff, s.staffId)}</td>
                  <td>{s.scheduled}</td>
                  <td>{s.records}</td>
                  <td>{formatMinutes(s.workedMinutes)}</td>
                  <td>{s.late || '—'}</td>
                  <td>{s.earlyLeave || '—'}</td>
                  <td>{s.missedPunchOut || '—'}</td>
                  <td>{s.absent ? <Badge tone="danger">{s.absent}</Badge> : '—'}</td>
                </tr>
              ))}
              {data.byStaff.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted text-center">此區間沒有排班或打卡</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {data.absences.length > 0 && (
            <Card title={`曠職 ${data.absences.length} 班`} className="hr-panel__card">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>員工</th>
                      <th>分店</th>
                      <th>班次</th>
                      <th>來源</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.absences.map((a) => (
                      <tr key={a.id}>
                        <td className="mono">{a.dateKey}（{weekdayLabel(a.dateKey)}）</td>
                        <td>{staffName(a.staff, a.staffId)}</td>
                        <td>{branchLabel(a.branchId)}</td>
                        <td>{shiftRangeLabel(a)}</td>
                        <td>{SCHEDULE_SOURCE_LABELS[a.source]}</td>
                        <td>
                          <Button size="sm" variant="ghost" onClick={() => backfillFromAbsence(a)}>補登</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          {data.rows.length === 0 ? (
            flag !== 'ABSENT' && <EmptyState icon="🕘" title="此區間沒有符合條件的打卡" desc="可調整日期或篩選條件" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>員工</th>
                    <th>分店</th>
                    <th>班次</th>
                    <th>上班</th>
                    <th>下班</th>
                    <th>工時</th>
                    <th>狀態</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.dateKey}（{weekdayLabel(r.dateKey)}）</td>
                      <td>{staffName(r.staff, r.staffId)}</td>
                      <td>{branchLabel(r.branchId)}</td>
                      <td className="text-sm">{r.schedule ? shiftRangeLabel(r.schedule) : '—'}</td>
                      <td className="mono">{hhmm(r.punchIn)}</td>
                      <td className="mono">
                        {r.punchOut ? (taipeiParts(r.punchOut).date !== r.dateKey ? `次日 ${hhmm(r.punchOut)}` : hhmm(r.punchOut)) : '—'}
                      </td>
                      <td>{formatMinutes(r.workedMinutes)}</td>
                      <td>
                        <FlagBadges row={r} />
                        {(r.correction?.reason || r.note) && (
                          <div className="text-muted text-sm">{r.correction?.reason ?? r.note}</div>
                        )}
                      </td>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>更正</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing && (
        <CorrectModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function BackfillForm({
  staffList,
  branches,
  preset,
  onDone,
}: Props & { preset: BackfillPreset | null; onDone: () => void }) {
  const { toast } = useToast();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [appliedPreset, setAppliedPreset] = useState<BackfillPreset | null>(null);
  const [staffId, setStaffId] = useState<number | ''>('');
  const [branchId, setBranchId] = useState<number | ''>('');
  const [date, setDate] = useState(() => taipeiToday());
  const [start, setStart] = useState('07:00');
  const [end, setEnd] = useState('15:30');
  const [reason, setReason] = useState('');
  const [bound, setBound] = useState<{ id: number; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  if (preset && preset !== appliedPreset) {
    setAppliedPreset(preset);
    setStaffId(preset.staffId);
    setBranchId(preset.branchId ?? '');
    setDate(preset.date);
    setStart(preset.start);
    setEnd(preset.end);
    setBound(preset.scheduleId ? { id: preset.scheduleId, label: preset.scheduleLabel ?? `#${preset.scheduleId}` } : null);
  }

  useEffect(() => {
    if (preset && detailsRef.current) {
      detailsRef.current.open = true;
      detailsRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [preset]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (staffId === '' || inFlightRef.current) return;
    const { startAt, endAt } = taipeiRangeIso(date, start, end || undefined);
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await createHqHrAttendance({
        staffId: Number(staffId),
        branchId: branchId || undefined,
        scheduleId: bound?.id,
        punchIn: startAt,
        punchOut: endAt,
        reason: reason.trim(),
      });
      toast(res.message || '已補登', 'success');
      setReason('');
      setBound(null);
      onDone();
    } catch (err) {
      toast(getErrorMessage(err, '補登失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <details ref={detailsRef} className="card schedule-overview__manual">
      <summary>＋ 補登打卡</summary>
      <p className="text-muted text-sm">
        員工忘記打卡、設備故障或班外出勤時使用；必填原因。下班時間留空＝仍在上班中；早於上班時間視為跨夜。
      </p>
      {bound && (
        <p className="text-sm">
          綁定班次：<Badge tone="info">{bound.label}</Badge>{' '}
          <Button size="sm" variant="ghost" type="button" onClick={() => setBound(null)}>
            不綁定
          </Button>
        </p>
      )}
      <form onSubmit={onSubmit} className="hr-holiday-form">
        <Field label="員工">
          <Select
            value={staffId === '' ? '' : String(staffId)}
            onChange={(e) => {
              setStaffId(e.target.value ? Number(e.target.value) : '');
              setBound(null);
            }}
            required
          >
            <option value="">選擇員工</option>
            {staffList.filter((s) => s.isActive).map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName || s.name}
                {s.branch?.name ? `（${s.branch.name}）` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="分店">
          <Select
            value={branchId === '' ? '' : String(branchId)}
            onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">員工本店</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="日期">
          <Input type="date" value={date} max={taipeiToday()} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="上班">
          <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
        </Field>
        <Field label="下班">
          <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="原因">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} required />
        </Field>
        <Button type="submit" loading={busy} disabled={staffId === '' || !reason.trim()}>補登</Button>
      </form>
    </details>
  );
}

function CorrectModal({ row, onClose, onSaved }: { row: AttendanceRecord; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const inParts = taipeiParts(row.punchIn);
  const [date, setDate] = useState(inParts.date);
  const [start, setStart] = useState(inParts.time);
  const [end, setEnd] = useState(row.punchOut ? hhmm(row.punchOut) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlightRef.current || !reason.trim()) return;
    const { startAt, endAt } = taipeiRangeIso(date, start, end || undefined);
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await correctHqHrAttendance(row.id, {
        punchIn: startAt,
        punchOut: endAt ?? null,
        reason: reason.trim(),
      });
      toast(res.message || '已更正', 'success');
      onSaved();
    } catch (err) {
      toast(getErrorMessage(err, '更正失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal open title={`更正打卡｜${row.staff?.displayName || row.staff?.name || `#${row.staffId}`}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="reason-modal">
        {row.schedule && <p className="text-sm">班次：{shiftRangeLabel(row.schedule)}</p>}
        {row.correction && (
          <p className="text-muted text-sm">前次更正：{row.correction.reason}</p>
        )}
        <div className="hr-holiday-form">
          <Field label="日期">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="上班">
            <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
          </Field>
          <Field label="下班" hint="留空＝仍在上班中；早於上班視為跨夜">
            <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="更正原因">
          <textarea
            className="input"
            rows={2}
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </Field>
        <div className="reason-modal__actions">
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={!reason.trim()}>儲存更正</Button>
        </div>
      </form>
    </Modal>
  );
}
