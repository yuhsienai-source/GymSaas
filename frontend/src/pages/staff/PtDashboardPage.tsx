import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageSection,
  Select,
} from '../../components/ui';
import { useToast } from '../../contexts/ToastContext';
import { staffBranchLabel } from '../../lib/branchLabel';
import { fetchPtDashboard, getErrorMessage, scheduleGroupClass } from '../../lib/api';
import type { GroupCoursePlanOption, Trainer, Venue } from '../../types/api';
import { isManagerTrainer } from '../../lib/orgStructure';
import { formatMoney } from '../../lib/hrFormat';
import GroupSeriesAdminPanel from '../../components/staff/GroupSeriesAdminPanel';

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: '週一' },
  { value: 2, label: '週二' },
  { value: 3, label: '週三' },
  { value: 4, label: '週四' },
  { value: 5, label: '週五' },
  { value: 6, label: '週六' },
  { value: 0, label: '週日' },
];

type GroupClassRow = {
  id: number;
  title: string;
  capacity: number;
  startAt: string;
  endAt: string;
  seriesId?: number | null;
  venueName?: string | null;
  branchName?: string | null;
  stationName?: string | null;
  trainerName?: string | null;
  booked?: number;
};

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addMonthsYmd(ymd: string, months: number) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1 + months, d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function formatSession(isoStart: string, isoEnd: string) {
  const s = new Date(isoStart);
  const e = new Date(isoEnd);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '—';
  const day = s.toLocaleDateString('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
  const t0 = s.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  const t1 = e.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${t0}–${t1}`;
}

/** 粗估堂數（前端預覽；實際以後端為準） */
function estimateSessions(startDate: string, endDate: string, weekdays: number[]) {
  if (!startDate || !endDate || weekdays.length === 0 || endDate < startDate) return 0;
  let count = 0;
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const cursor = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  while (cursor <= end) {
    if (weekdays.includes(cursor.getDay()) && cursor >= today) count += 1;
    cursor.setDate(cursor.getDate() + 1);
    if (count > 80) return 80;
  }
  return count;
}

export default function PtDashboardPage() {
  const { toast } = useToast();
  const [venues, setVenues] = useState<Venue[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [upcoming, setUpcoming] = useState<GroupClassRow[]>([]);
  const [groupPlans, setGroupPlans] = useState<GroupCoursePlanOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [seriesReload, setSeriesReload] = useState(0);

  const [coursePlanId, setCoursePlanId] = useState<number | ''>('');
  const [title, setTitle] = useState('');
  const [venueId, setVenueId] = useState<number | ''>('');
  const [stationId, setStationId] = useState<number | ''>('');
  const [startDate, setStartDate] = useState(() => todayYmd());
  const [endDate, setEndDate] = useState(() => addMonthsYmd(todayYmd(), 2));
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [startTime, setStartTime] = useState('19:00');
  const [endTime, setEndTime] = useState('20:00');
  const [capacity, setCapacity] = useState('');
  const [enrollDeadline, setEnrollDeadline] = useState('');
  const [trainerId, setTrainerId] = useState<number | ''>('');

  const applyDashboard = useCallback(
    (data: {
      venues?: Venue[];
      trainers?: Trainer[];
      upcomingGroupClasses?: GroupClassRow[];
      groupCoursePlans?: GroupCoursePlanOption[];
    }) => {
      setVenues(data.venues || []);
      setTrainers(data.trainers || []);
      setUpcoming(data.upcomingGroupClasses || []);
      setGroupPlans(data.groupCoursePlans || []);
    },
    [],
  );

  const loadData = useCallback(async () => {
    try {
      const result = await fetchPtDashboard();
      if (result.status === 'success' && result.data) {
        applyDashboard(result.data as Parameters<typeof applyDashboard>[0]);
      }
    } catch (err) {
      toast(getErrorMessage(err, '載入團課資料失敗'), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast, applyDashboard]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchPtDashboard();
        if (cancelled) return;
        if (result.status === 'success' && result.data) {
          applyDashboard(result.data as Parameters<typeof applyDashboard>[0]);
        }
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入團課資料失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, applyDashboard]);

  const effectiveVenueId: number | '' =
    venueId !== '' && venues.some((v) => v.id === venueId)
      ? venueId
      : (venues[0]?.id ?? '');

  const venue = useMemo(
    () => venues.find((v) => v.id === effectiveVenueId) || null,
    [venues, effectiveVenueId],
  );
  const stations = venue?.stations || [];
  const stationResolved = stations.some((s) => s.id === stationId)
    ? stationId
    : stations[0]?.id ?? '';

  const trainersForVenue = useMemo(() => {
    if (!venue) return trainers;
    return trainers.filter(
      (t) =>
        isManagerTrainer(t) ||
        (t.branches || []).some((b) => b.branchId === venue.branchId),
    );
  }, [trainers, venue]);

  const effectiveTrainerId: number | '' =
    trainerId !== '' && trainersForVenue.some((t) => t.id === trainerId)
      ? trainerId
      : (trainersForVenue[0]?.id ?? '');

  /** 課程方案須屬場地分店或其上層健身房（後端強制） */
  const plansForVenue = useMemo(() => {
    if (!venue) return groupPlans;
    return groupPlans.filter(
      (p) => p.branchId === venue.branchId || (venue.branch?.parentId != null && p.branchId === venue.branch.parentId),
    );
  }, [groupPlans, venue]);

  const effectivePlanId: number | '' =
    coursePlanId !== '' && plansForVenue.some((p) => p.id === coursePlanId)
      ? coursePlanId
      : (plansForVenue[0]?.id ?? '');
  const plan = plansForVenue.find((p) => p.id === effectivePlanId) || null;

  const previewCount = estimateSessions(startDate, endDate, weekdays);

  function toggleWeekday(value: number) {
    setWeekdays((prev) =>
      prev.includes(value) ? prev.filter((x) => x !== value) : [...prev, value].sort((a, b) => a - b),
    );
  }

  async function handleSchedule(e: FormEvent) {
    e.preventDefault();
    if (!effectivePlanId || !effectiveVenueId || !effectiveTrainerId || !startTime || !endTime) {
      toast('請選擇課程方案、場地、教練與時段', 'error');
      return;
    }
    if (!startDate || !endDate) {
      toast('請填寫開始日期與結束日期', 'error');
      return;
    }
    if (weekdays.length === 0) {
      toast('請至少選擇一個上課日（每週幾）', 'error');
      return;
    }
    if (stations.length > 0 && !stationResolved) {
      toast('請選擇訓練站點', 'error');
      return;
    }
    const cap = capacity.trim() ? parseInt(capacity, 10) : null;
    if (cap !== null && (!Number.isInteger(cap) || cap < 1)) {
      toast('人數上限須為正整數', 'error');
      return;
    }

    setBusy(true);
    try {
      const result = await scheduleGroupClass({
        coursePlanId: Number(effectivePlanId),
        ...(title.trim() ? { title: title.trim() } : {}),
        venueId: Number(effectiveVenueId),
        ...(stationResolved ? { stationId: Number(stationResolved) } : {}),
        startDate,
        endDate,
        weekdays,
        startTime,
        endTime,
        ...(cap !== null ? { capacity: cap } : {}),
        trainerId: Number(effectiveTrainerId),
        ...(enrollDeadline ? { enrollDeadline } : {}),
      });
      toast(result.message || '期班排課成功', 'success');
      setTitle('');
      setSeriesReload((k) => k + 1);
      await loadData();
    } catch (err) {
      toast(getErrorMessage(err, '排課失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading && venues.length === 0) {
    return (
      <PageSection title="團課管理" desc="載入中…">
        <EmptyState icon="⏳" title="正在載入排課資料" />
      </PageSection>
    );
  }

  return (
    <>
      <PageSection
        title="團課管理"
        desc="付費期班 · 綁定團體課程方案（整期價／堂數／單堂價／最低開班人數）· 學員於會員端或櫃檯 POS 付款報名"
      >
        <Card
          title="新增團課期班"
          subtitle="依日期區間與每週上課日一次展開多堂，堂數須等於方案每期堂數；並做教練班表／場地防衝堂"
        >
          <form onSubmit={handleSchedule} className="form-stack">
            <Field label="使用場地">
              <Select
                value={effectiveVenueId ? String(effectiveVenueId) : ''}
                onChange={(e) => {
                  setVenueId(e.target.value ? Number(e.target.value) : '');
                  setStationId('');
                }}
                required
              >
                <option value="">— 請選擇 —</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>
                    {staffBranchLabel(v.branch)} · {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="團體課程方案" hint="價格與堂數快照自方案，開班後不隨方案變動">
              <Select
                value={effectivePlanId ? String(effectivePlanId) : ''}
                onChange={(e) => setCoursePlanId(e.target.value ? Number(e.target.value) : '')}
                required
              >
                <option value="">— 請選擇 —</option>
                {plansForVenue.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {formatMoney(p.price)}／{p.sessions ?? '—'} 堂
                  </option>
                ))}
              </Select>
            </Field>
            {plansForVenue.length === 0 ? (
              <Alert tone="warning">此場地分店尚無上架中的團體課程方案，請先至總部「課程方案」建立。</Alert>
            ) : null}
            {plan ? (
              <p className="text-sm text-muted" style={{ margin: 0 }}>
                整期 {formatMoney(plan.price)} · 每期 {plan.sessions ?? '—'} 堂 · 單堂{' '}
                {plan.dropInPrice ? formatMoney(plan.dropInPrice) : '不開放'} · 人數上限 {plan.capacity ?? '—'} ·
                最低開班 {plan.minEnrollment || '不設'}
              </p>
            ) : null}
            <Field label="期班名稱（選填）" hint="留空＝沿用方案名稱">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={plan?.name || '例：核心循環訓練 10 月班'}
              />
            </Field>
            {stations.length > 0 ? (
              <Field label="站點">
                <Select
                  value={stationResolved === '' ? '' : String(stationResolved)}
                  onChange={(e) =>
                    setStationId(e.target.value ? Number(e.target.value) : '')
                  }
                  required
                >
                  {stations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="授課教練" hint="團課須指定教練（防衝堂）">
              <Select
                value={effectiveTrainerId ? String(effectiveTrainerId) : ''}
                onChange={(e) =>
                  setTrainerId(e.target.value ? Number(e.target.value) : '')
                }
                required
              >
                <option value="">— 請選擇 —</option>
                {trainersForVenue.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {isManagerTrainer(t) ? '（主管）' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="coach-desk__time-row">
              <Field label="開始日期">
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </Field>
              <Field label="結束日期" hint="含當日">
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  required
                />
              </Field>
            </div>

            <Field label="每週幾" hint="可多選 · 僅展開區間內符合的日期">
              <div className="checkbox-group">
                {WEEKDAYS.map((d) => (
                  <label key={d.value} className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={weekdays.includes(d.value)}
                      onChange={() => toggleWeekday(d.value)}
                    />
                    {d.label}
                  </label>
                ))}
              </div>
            </Field>

            <div className="coach-desk__time-row">
              <Field label="上課開始">
                <Input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  required
                />
              </Field>
              <Field label="上課結束">
                <Input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  required
                />
              </Field>
            </div>

            <div className="coach-desk__time-row">
              <Field label="人數上限（選填）" hint="留空＝沿用方案">
                <Input
                  type="number"
                  min={1}
                  value={capacity}
                  placeholder={plan?.capacity ? String(plan.capacity) : ''}
                  onChange={(e) => setCapacity(e.target.value)}
                />
              </Field>
              <Field label="報名截止（選填）" hint="留空＝開課前 2 日">
                <Input type="date" value={enrollDeadline} onChange={(e) => setEnrollDeadline(e.target.value)} />
              </Field>
            </div>

            {previewCount > 0 ? (
              <AlertPreview count={previewCount} planSessions={plan?.sessions ?? null} />
            ) : (
              <p className="text-sm text-muted">請設定日期區間與每週幾以預覽堂數</p>
            )}

            <Button
              type="submit"
              loading={busy}
              disabled={
                !effectivePlanId ||
                !effectiveVenueId ||
                !effectiveTrainerId ||
                weekdays.length === 0 ||
                (stations.length > 0 && !stationResolved)
              }
            >
              確認建立期班
            </Button>
          </form>
        </Card>
      </PageSection>

      <GroupSeriesAdminPanel reloadSignal={seriesReload} />

      <PageSection title="即將到來的團課堂次" desc="未來單堂 · 依開始時間排序">
        {upcoming.length === 0 ? (
          <EmptyState icon="📅" title="尚無已排團課" desc="請於上方建立期班" />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>時段</th>
                  <th>團課名稱</th>
                  <th>場地</th>
                  <th>教練</th>
                  <th>名額</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((c) => (
                  <tr key={c.id}>
                    <td className="text-sm">{formatSession(c.startAt, c.endAt)}</td>
                    <td>
                      <strong>{c.title}</strong>
                      {c.seriesId ? (
                        <span className="text-muted text-sm"> · 期班#{c.seriesId}</span>
                      ) : null}
                    </td>
                    <td>
                      {c.branchName || '—'} {c.venueName || ''}
                      {c.stationName ? `／${c.stationName}` : ''}
                    </td>
                    <td>{c.trainerName || '—'}</td>
                    <td>
                      <Badge tone={(c.booked || 0) < c.capacity ? 'success' : 'neutral'}>
                        {c.booked || 0}/{c.capacity}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageSection>
    </>
  );
}

function AlertPreview({ count, planSessions }: { count: number; planSessions: number | null }) {
  const mismatch = planSessions != null && planSessions !== count;
  return (
    <p className="text-sm" style={{ color: mismatch ? 'var(--danger, #b42318)' : 'var(--text-muted)' }}>
      預估將產生約 <strong>{count}</strong> 堂
      {planSessions != null ? `；方案每期 ${planSessions} 堂${mismatch ? '，須一致才能開班' : ''}` : ''}
      （實際以後端為準）
    </p>
  );
}
