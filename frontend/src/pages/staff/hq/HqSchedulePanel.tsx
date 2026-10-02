import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select } from '../../../components/ui';
import CoachPlanReviewPanel from '../../../components/staff/CoachPlanReviewPanel';
import ShiftRosterPanel from '../../../components/staff/ShiftRosterPanel';
import { useToast } from '../../../contexts/ToastContext';
import { deleteHqHrSchedule, fetchHqHrSchedules, getErrorMessage } from '../../../lib/api';
import { addDaysKey, hhmm, weekdayLabel } from '../../../lib/hrFormat';
import { taipeiToday } from '../../../lib/laborLaw';
import type { ScheduleOverview, ScheduleOverviewRow, ScheduleSource } from '../../../types/api';
import type { HqDataProps } from './types';

const VIEWS = { roster: '四週排班（分店班表）', review: '週班表審核', overview: '班表總覽' } as const;
type View = keyof typeof VIEWS;

const SOURCE_OPTIONS: { value: ScheduleSource | ''; label: string }[] = [
  { value: '', label: '全部來源' },
  { value: 'ROSTER', label: '四週排班' },
  { value: 'FREE', label: '週班表（教練／管理職）' },
  { value: 'MANUAL', label: '總部臨時排班' },
];
const RANGE_DAYS = 14;

function SourceBadge({ row }: { row: ScheduleOverviewRow }) {
  if (row.source === 'ROSTER') {
    return row.rosterStatus === 'PUBLISHED' ? (
      <Badge tone="info">四週排班</Badge>
    ) : (
      <Badge tone="warning">四週排班・草稿</Badge>
    );
  }
  if (row.source === 'FREE') {
    return row.coachPlanId && row.coachPlanStatus !== 'APPROVED' ? (
      <Badge tone="warning">{row.sourceLabel}・{row.coachPlanStatusLabel ?? '未核准'}</Badge>
    ) : (
      <Badge tone="success">{row.sourceLabel}</Badge>
    );
  }
  return <Badge tone="neutral">{row.sourceLabel}</Badge>;
}

type Props = Pick<HqDataProps, 'staffList' | 'branches'>;

/** 總部 HR「排班」：四週排班（分店班表）＋週班表審核（店長／GM／FM；可代審教練）＋跨店班表總覽 */
export default function HqSchedulePanel({ staffList, branches }: Props) {
  const [view, setView] = useState<View>('roster');
  return (
    <>
      <nav className="hq-tabs hq-tabs--sub" role="tablist">
        {(Object.keys(VIEWS) as View[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            className={`hq-tabs__btn ${view === key ? 'is-active' : ''}`}
            onClick={() => setView(key)}
          >
            {VIEWS[key]}
          </button>
        ))}
      </nav>
      {view === 'roster' ? (
        <ShiftRosterPanel />
      ) : view === 'review' ? (
        <CoachPlanReviewPanel />
      ) : (
        <ScheduleOverviewView staffList={staffList} branches={branches} onOpenRoster={() => setView('roster')} />
      )}
    </>
  );
}

function ScheduleOverviewView({ staffList, branches, onOpenRoster }: Props & { onOpenRoster: () => void }) {
  const { toast } = useToast();
  const [from, setFrom] = useState(() => taipeiToday());
  const [to, setTo] = useState(() => addDaysKey(taipeiToday(), RANGE_DAYS - 1));
  const [branchId, setBranchId] = useState<number | ''>('');
  const [staffId, setStaffId] = useState<number | ''>('');
  const [source, setSource] = useState<ScheduleSource | ''>('');
  const [includeOff, setIncludeOff] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<ScheduleOverview | null>(null);
  const [loadedKey, setLoadedKey] = useState('');

  const queryKey = JSON.stringify({ from, to, branchId, staffId, source, includeOff, reloadKey });
  const loading = loadedKey !== queryKey;

  useEffect(() => {
    let cancelled = false;
    fetchHqHrSchedules({
      from,
      to,
      branchId: branchId || undefined,
      staffId: staffId || undefined,
      source: source || undefined,
      includeOff,
    })
      .then((res) => {
        if (!cancelled) setData(res.data ?? null);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入班表失敗'), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(queryKey);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, branchId, staffId, source, includeOff, queryKey, toast]);

  const branchName = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches]);
  const staffOptions = useMemo(
    () => staffList.filter((s) => branchId === '' || s.branchId === branchId),
    [staffList, branchId],
  );

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const grouped = useMemo(() => {
    const map = new Map<string, ScheduleOverviewRow[]>();
    for (const r of rows) {
      const list = map.get(r.dateKey) ?? [];
      list.push(r);
      map.set(r.dateKey, list);
    }
    return [...map.entries()];
  }, [rows]);

  const summary = useMemo(() => {
    const work = rows.filter((r) => !r.isOff);
    return {
      total: work.length,
      roster: work.filter((r) => r.source === 'ROSTER').length,
      draft: work.filter((r) => r.source === 'ROSTER' && r.rosterStatus !== 'PUBLISHED').length,
      free: work.filter((r) => r.source === 'FREE').length,
      manual: work.filter((r) => r.source === 'MANUAL').length,
    };
  }, [rows]);

  function shiftRange(days: number) {
    setFrom((f) => addDaysKey(f, days));
    setTo((t) => addDaysKey(t, days));
  }

  async function onDelete(row: ScheduleOverviewRow) {
    const who = row.staff?.displayName || row.staff?.name || `#${row.staffId}`;
    if (!window.confirm(`刪除 ${row.dateKey} ${who} 的${row.sourceLabel}？`)) return;
    try {
      const res = await deleteHqHrSchedule(row.id);
      toast(res.message || '已刪除', 'success');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '刪除失敗'), 'error');
    }
  }

  return (
    <>
      <Card title="班表總覽" className="schedule-overview__card">
        <p className="text-muted text-sm">
          彙整各店四週排班、週班表與既有總部臨時排班（唯讀總覽）。四週排班之班次僅能於「四週排班」編修（已發布須先撤回）；
          週班表由本人提報：轉正教練經 FM／該分店店長核准，店長／GM／FM 經總公司於「週班表審核」核准後生效（未核准者標示狀態、不計入考勤與值勤）。
          總公司帳號免排班，已不再新增臨時排班。
        </p>
        <div className="roster__toolbar">
          <Field label="起日">
            <Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
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
          <Field label="來源">
            <Select value={source} onChange={(e) => setSource(e.target.value as ScheduleSource | '')}>
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <label className="schedule-overview__check">
            <input type="checkbox" checked={includeOff} onChange={(e) => setIncludeOff(e.target.checked)} />
            顯示例假／休息日／排休
          </label>
        </div>
        <div className="roster__toolbar">
          <Button size="sm" variant="secondary" onClick={() => shiftRange(-RANGE_DAYS)}>← 前 2 週</Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const today = taipeiToday();
              setFrom(today);
              setTo(addDaysKey(today, RANGE_DAYS - 1));
            }}
          >
            今日起 2 週
          </Button>
          <Button size="sm" variant="secondary" onClick={() => shiftRange(RANGE_DAYS)}>後 2 週 →</Button>
          <span className="text-sm">
            班次 {summary.total}｜四週排班 {summary.roster}
            {summary.draft > 0 && <>（草稿 {summary.draft}）</>}｜週班表 {summary.free}｜臨時排班 {summary.manual}
          </span>
        </div>
        {data?.truncated && <Alert tone="warning">資料過多僅顯示前 1000 筆，請縮小區間或加上分店／員工篩選。</Alert>}
      </Card>

      {loading && !data ? (
        <p className="text-muted">載入中…</p>
      ) : grouped.length === 0 ? (
        <EmptyState icon="🗓" title="此區間沒有排班" desc="可調整日期或篩選條件" />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>時段</th>
                <th>員工</th>
                <th>分店</th>
                <th>班別</th>
                <th>來源</th>
                <th>備註</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(([dateKey, list]) => (
                <DateGroup
                  key={dateKey}
                  dateKey={dateKey}
                  rows={list}
                  branchName={branchName}
                  onDelete={onDelete}
                  onOpenRoster={onOpenRoster}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function DateGroup({
  dateKey,
  rows,
  branchName,
  onDelete,
  onOpenRoster,
}: {
  dateKey: string;
  rows: ScheduleOverviewRow[];
  branchName: Map<number, string>;
  onDelete: (row: ScheduleOverviewRow) => void;
  onOpenRoster: () => void;
}) {
  const workCount = rows.filter((r) => !r.isOff).length;
  return (
    <>
      <tr className="schedule-overview__date">
        <td colSpan={7}>
          <strong>{dateKey}（{weekdayLabel(dateKey)}）</strong>
          <span className="text-muted text-sm"> 出勤 {workCount} 人次</span>
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.id} className={r.isOff ? 'text-muted' : undefined}>
          <td className="mono">{r.isOff ? '全日' : `${hhmm(r.startAt)}–${hhmm(r.endAt)}`}</td>
          <td>
            {r.staff?.displayName || r.staff?.name || `#${r.staffId}`}
            {r.staff?.rosterRoleLabel && <span className="text-muted text-sm">｜{r.staff.rosterRoleLabel}</span>}
          </td>
          <td>{r.branchId ? branchName.get(r.branchId) ?? `#${r.branchId}` : '—'}</td>
          <td>{r.label}</td>
          <td><SourceBadge row={r} /></td>
          <td className="text-sm">{r.note || '—'}</td>
          <td>
            {r.deletable ? (
              <Button size="sm" variant="ghost" onClick={() => onDelete(r)}>刪除</Button>
            ) : r.source === 'ROSTER' ? (
              <Button size="sm" variant="ghost" onClick={onOpenRoster}>至四週排班</Button>
            ) : (
              <span className="text-muted text-sm">店長審核</span>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

