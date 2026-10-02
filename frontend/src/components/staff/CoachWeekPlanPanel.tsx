import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import { fetchMyCoachPlans, getErrorMessage, saveMyCoachPlan, submitMyCoachPlan, withdrawMyCoachPlan } from '../../lib/api';
import { EMPLOYMENT_TYPE_LABELS } from '../../lib/laborLaw';
import { positionLabel } from '../../lib/orgStructure';
import type { CoachPlanIssue, CoachPlanSlot, CoachPlanStatus, CoachWeekPlan, MyCoachPlans } from '../../types/api';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const STATUS_TONE: Record<CoachPlanStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  DRAFT: 'neutral',
  SUBMITTED: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
};
const DEFAULT_SLOTS = [
  { start: '09:00', end: '13:00' },
  { start: '14:00', end: '18:00' },
];
type DayKind = 'WORK' | 'REGULAR_OFF' | 'REST_DAY' | 'NONE';
type Draft = { regularOffDate: string | null; restDayDate: string | null; slots: CoachPlanSlot[]; note: string };

const addDays = (key: string, n: number) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const shortDate = (key: string) => key.slice(5).replace('-', '/');
const hours = (min: number) => `${(min / 60).toFixed(1).replace(/\.0$/, '')}h`;

function draftFromPlan(p: CoachWeekPlan): Draft {
  return {
    regularOffDate: p.regularOffDate,
    restDayDate: p.restDayDate,
    slots: p.slots.map((s) => ({ date: s.date, start: s.start, end: s.end, branchId: s.branchId ?? null })),
    note: p.note ?? '',
  };
}

const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/** 週班表：轉正教練（FM／店長核准）與店長・GM・FM（總公司核准）本人提報，核准後生效；勞基法檢查一律以後端結果為準 */
export default function CoachWeekPlanPanel() {
  const { toast } = useToast();
  const lockRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<MyCoachPlans | null>(null);
  const [error, setError] = useState('');
  const [weekStart, setWeekStart] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [submitIssues, setSubmitIssues] = useState<CoachPlanIssue[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyCoachPlans()
      .then((res) => {
        if (!alive || !res.data) return;
        setData(res.data);
        const firstOpen = res.data.weeks.find((w) => w.weekStart > res.data!.today && w.status !== 'APPROVED');
        setWeekStart((firstOpen ?? res.data.weeks[0]).weekStart);
      })
      .catch((err) => alive && setError(getErrorMessage(err, '讀取週班表失敗')));
    return () => {
      alive = false;
    };
  }, []);

  const week = data?.weeks.find((w) => w.weekStart === weekStart) ?? null;
  const saved = useMemo(() => (week ? draftFromPlan(week) : null), [week]);
  const draft = (week && drafts[week.weekStart]) || saved;
  const dirty = Boolean(draft && saved && !sameDraft(draft, saved));
  const days = useMemo(() => (weekStart ? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)) : []), [weekStart]);
  const branchName = useMemo(() => new Map((data?.branches ?? []).map((b) => [b.id, b.name])), [data]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data || !week || !draft) return <p className="text-muted">載入中…</p>;

  const today = data.today;
  const editable = week.editable;
  const rules = data.rules;
  const statByDate = new Map((week.evaluation?.stats.days ?? []).map((d) => [d.date, d]));
  const holidayByDate = new Map((week.holidays ?? []).map((h) => [h.date, h.name]));
  const issues = submitIssues ?? week.evaluation?.issues ?? [];

  function patch(next: Partial<Draft>) {
    setSubmitIssues(null);
    setDrafts((prev) => ({ ...prev, [weekStart]: { ...draft!, ...next } }));
  }

  function kindOf(date: string): DayKind {
    if (draft!.regularOffDate === date) return 'REGULAR_OFF';
    if (draft!.restDayDate === date) return 'REST_DAY';
    return draft!.slots.some((s) => s.date === date) ? 'WORK' : 'NONE';
  }

  function setKind(date: string, kind: DayKind) {
    const others = draft!.slots.filter((s) => s.date !== date);
    const next: Partial<Draft> = {
      regularOffDate: draft!.regularOffDate === date ? null : draft!.regularOffDate,
      restDayDate: draft!.restDayDate === date ? null : draft!.restDayDate,
      slots: others,
    };
    if (kind === 'REGULAR_OFF') next.regularOffDate = date;
    if (kind === 'REST_DAY') next.restDayDate = date;
    if (kind === 'WORK') {
      next.slots = [...others, ...DEFAULT_SLOTS.map((s) => ({ date, ...s, branchId: data!.defaultBranchId }))];
    }
    patch(next);
  }

  function updateSlot(date: string, idx: number, field: 'start' | 'end' | 'branchId', value: string) {
    let n = -1;
    patch({
      slots: draft!.slots.map((s) => {
        if (s.date !== date) return s;
        n += 1;
        if (n !== idx) return s;
        return field === 'branchId' ? { ...s, branchId: Number(value) || null } : { ...s, [field]: value };
      }),
    });
  }

  function removeSlot(date: string, idx: number) {
    let n = -1;
    patch({
      slots: draft!.slots.filter((s) => {
        if (s.date !== date) return true;
        n += 1;
        return n !== idx;
      }),
    });
  }

  function addSlot(date: string) {
    const last = draft!.slots.filter((s) => s.date === date).at(-1);
    const start = last?.end && last.end < '23:00' ? last.end : '09:00';
    const [h, m] = start.split(':').map(Number);
    const end = `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    patch({ slots: [...draft!.slots, { date, start, end, branchId: last?.branchId ?? data!.defaultBranchId }] });
  }

  function copyMondayToWeekdays() {
    const mon = days[0];
    const monSlots = draft!.slots.filter((s) => s.date === mon);
    if (!monSlots.length) {
      toast('請先排定週一時段', 'info');
      return;
    }
    const targets = days.slice(1, 5).filter((d) => d >= today && d !== draft!.regularOffDate && d !== draft!.restDayDate);
    patch({
      slots: [
        ...draft!.slots.filter((s) => !targets.includes(s.date)),
        ...targets.flatMap((d) => monSlots.map((s) => ({ ...s, date: d }))),
      ],
    });
  }

  function applyPlan(plan: CoachWeekPlan) {
    setData((prev) =>
      prev
        ? { ...prev, weeks: prev.weeks.map((w) => (w.weekStart === plan.weekStart ? { ...plan, holidays: w.holidays } : w)) }
        : prev,
    );
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[plan.weekStart];
      return next;
    });
  }

  async function run(task: () => Promise<void>) {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    try {
      await task();
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }

  const payload = () => ({
    regularOffDate: draft!.regularOffDate,
    restDayDate: draft!.restDayDate,
    slots: draft!.slots,
    note: draft!.note.trim() || undefined,
  });

  const save = () =>
    run(async () => {
      try {
        const res = await saveMyCoachPlan(weekStart, payload());
        if (res.data) applyPlan(res.data);
        toast(res.message || '已儲存', res.data?.evaluation?.hasError ? 'info' : 'success');
      } catch (err) {
        toast(getErrorMessage(err, '儲存週班表失敗'), 'error');
      }
    });

  const submit = () =>
    run(async () => {
      try {
        if (dirty) {
          const res = await saveMyCoachPlan(weekStart, payload());
          if (res.data) applyPlan(res.data);
        }
        const res = await submitMyCoachPlan(weekStart);
        if (res.data) applyPlan(res.data);
        toast(res.message || '已送出審核', 'success');
      } catch (err) {
        const detail = (err as { response?: { data?: { data?: { issues?: CoachPlanIssue[] } } } }).response?.data?.data?.issues;
        if (detail) setSubmitIssues(detail);
        toast(getErrorMessage(err, '送出審核失敗'), 'error');
      }
    });

  const withdraw = () =>
    run(async () => {
      try {
        const res = await withdrawMyCoachPlan(weekStart);
        if (res.data) applyPlan(res.data);
        toast(res.message || '已撤回', 'success');
      } catch (err) {
        toast(getErrorMessage(err, '撤回失敗'), 'error');
      }
    });

  const stats = week.evaluation?.stats;
  const isCoach = data.planRole === 'COACH';
  const showBranchSelect = data.branches.length > 1 || data.allowNoBranch;
  return (
    <div className="my-roster coach-plan">
      <p className="text-muted text-sm">
        {data.staff.name}・{positionLabel(data.staff.role)}・
        {EMPLOYMENT_TYPE_LABELS[data.staff.employmentType] ?? data.staff.employmentType}。每週提報出勤時段，經{data.approverLabel}
        核准後生效，
        {isCoach ? (
          <strong>僅核准班表內之時段可開課／受預約</strong>
        ) : (
          <strong>僅核准班表內之時段列為值勤、可打卡並使用管理功能</strong>
        )}
        {isCoach ? '（扣除請假與不開放預約時段）' : ''}。勞基法：每日正常工時 ≤
        {rules.maxDailyNormalMinutes / 60} 小時、每週 ≤{rules.maxWeeklyNormalMinutes / 60} 小時（§30）；連續 4 小時須休息
        {rules.breakMinutes} 分鐘（§35，時段間隔不足 {rules.breakMinutes} 分鐘視為連續、自動扣除）；每 7 日 1 例假＋1 休息日、
        最多連續 {rules.maxConsecutiveWorkDays} 日（§36）；工作日間隔 ≥{rules.minRestBetweenDaysHours} 小時（§34）。休假請於「我的出勤」申請請假。
      </p>

      <div className="coach-plan__weeks" role="tablist" aria-label="週次">
        {data.weeks.map((w) => (
          <button
            key={w.weekStart}
            type="button"
            role="tab"
            aria-selected={w.weekStart === weekStart}
            className={`coach-plan__week${w.weekStart === weekStart ? ' is-active' : ''}`}
            onClick={() => {
              setWeekStart(w.weekStart);
              setSubmitIssues(null);
            }}
          >
            <span className="mono">
              {shortDate(w.weekStart)}–{shortDate(w.weekEnd)}
            </span>
            <small>
              {w.status ? w.statusLabel : '未提報'}
              {drafts[w.weekStart] ? '・未儲存' : ''}
            </small>
          </button>
        ))}
      </div>

      <Card title={`週班表：${week.weekStart} ～ ${week.weekEnd}`}>
        <div className="my-roster__status">
          <Badge tone={week.status ? STATUS_TONE[week.status] : 'neutral'}>{week.statusLabel}</Badge>
          {stats && (
            <Badge tone="info">
              排定工時 {hours(stats.weekWorkMinutes)}
              {stats.leaveMinutes > 0 ? `＋請假 ${hours(stats.leaveMinutes)}` : ''}
              {stats.agreedMinutes != null ? `／約定 ${hours(stats.agreedMinutes)}` : ''}
            </Badge>
          )}
          {week.evaluation && (
            <Badge tone={week.evaluation.hasError ? 'danger' : 'success'}>
              {week.evaluation.hasError ? '未符合勞基法，不可送審' : '符合工時規定'}
            </Badge>
          )}
          {dirty && <Badge tone="warning">有未儲存變更（檢查結果為上次儲存版本）</Badge>}
        </div>

        {week.status === 'REJECTED' && week.reviewNote && (
          <Alert tone="error">
            審核退回：「{week.reviewNote}」{week.reviewedBy?.name ? `（${week.reviewedBy.name}）` : ''}，請修正後重新送審。
          </Alert>
        )}
        {week.status === 'DRAFT' && week.reviewNote && (
          <Alert tone="warning">審核主管已撤回核准：「{week.reviewNote}」，請調整後重新送審。</Alert>
        )}
        {week.status === 'SUBMITTED' && <Alert tone="info">已送出，待{data.approverLabel}審核；如需修改請先撤回送審。</Alert>}
        {week.status === 'APPROVED' && (
          <Alert tone="success">
            已核准{week.reviewedBy?.name ? `（${week.reviewedBy.name}）` : ''}，班表生效。如需調整請洽{data.approverLabel}撤回核准。
          </Alert>
        )}

        <div className="coach-plan__days">
          {days.map((date, i) => {
            const kind = kindOf(date);
            const past = date < today;
            const locked = !editable || past || busy;
            const daySlots = draft.slots.filter((s) => s.date === date);
            const stat = statByDate.get(date);
            const holiday = holidayByDate.get(date);
            const classes = week.classes.filter((c) => c.date === date);
            return (
              <div key={date} className={`coach-plan__day coach-plan__day--${kind}${past ? ' is-past' : ''}`}>
                <div className="coach-plan__day-head">
                  <strong className={holiday ? 'coach-plan__holiday' : undefined}>
                    {shortDate(date)}（{WEEKDAYS[(i + 1) % 7]}）
                  </strong>
                  {holiday && <Badge tone="danger">{holiday}</Badge>}
                  <Select
                    aria-label={`${date} 類型`}
                    value={kind}
                    disabled={locked}
                    onChange={(e) => setKind(date, e.target.value as DayKind)}
                  >
                    <option value="WORK">出勤</option>
                    <option value="REGULAR_OFF">例假</option>
                    <option value="REST_DAY">休息日</option>
                    <option value="NONE">未排（請假／其他）</option>
                  </Select>
                  {stat && stat.kind === 'WORK' && !dirty && (
                    <span className="text-muted text-sm">
                      工時 {hours(stat.workMinutes)}
                      {stat.breakMinutes > 0 ? `（扣休息 ${stat.breakMinutes} 分）` : ''}
                    </span>
                  )}
                  {stat && stat.leaveMinutes > 0 && <Badge tone="warning">請假 {hours(stat.leaveMinutes)}</Badge>}
                </div>
                {kind === 'WORK' && (
                  <div className="coach-plan__slots">
                    {daySlots.map((s, idx) => (
                      <div key={`${date}-${idx}`} className="coach-plan__slot">
                        <Input
                          type="time"
                          step={300}
                          aria-label="開始"
                          value={s.start}
                          disabled={locked}
                          onChange={(e) => updateSlot(date, idx, 'start', e.target.value)}
                        />
                        <span>–</span>
                        <Input
                          type="time"
                          step={300}
                          aria-label="結束"
                          value={s.end === '24:00' ? '23:59' : s.end}
                          disabled={locked}
                          onChange={(e) => updateSlot(date, idx, 'end', e.target.value)}
                        />
                        {showBranchSelect ? (
                          <Select
                            aria-label="出勤分店"
                            value={String(s.branchId ?? data.defaultBranchId ?? '')}
                            disabled={locked}
                            onChange={(e) => updateSlot(date, idx, 'branchId', e.target.value)}
                          >
                            {data.allowNoBranch && <option value="">總部（不指定分店）</option>}
                            {data.branches.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name}
                              </option>
                            ))}
                          </Select>
                        ) : null}
                        {!locked && (
                          <Button variant="ghost" size="sm" onClick={() => removeSlot(date, idx)} aria-label="移除時段">
                            ✕
                          </Button>
                        )}
                      </div>
                    ))}
                    {!locked && daySlots.length < rules.maxSlotsPerDay && (
                      <Button variant="ghost" size="sm" onClick={() => addSlot(date)}>
                        ＋ 時段
                      </Button>
                    )}
                  </div>
                )}
                {classes.length > 0 && (
                  <p className="text-muted text-sm">
                    已排課程：
                    {classes.map((c) => `${c.start}–${c.end} ${c.title}`).join('、')}
                  </p>
                )}
                {kind === 'WORK' && showBranchSelect && daySlots.length > 0 && locked && (
                  <p className="text-muted text-sm">
                    {[...new Set(daySlots.map((s) => (s.branchId ? branchName.get(s.branchId) : '總部')).filter(Boolean))].join('、')}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {issues.length > 0 && (
          <ul className="roster__issues">
            {issues.map((it, idx) => (
              <li key={`${it.code}-${it.date ?? ''}-${idx}`}>
                <Badge tone={it.level === 'ERROR' ? 'danger' : 'warning'}>{it.level === 'ERROR' ? '違規' : '提醒'}</Badge>{' '}
                {it.date ? <span className="mono">{shortDate(it.date)} </span> : null}
                {it.message}
              </li>
            ))}
          </ul>
        )}

        {editable ? (
          <div className="my-roster__form">
            <Field label="備註（選填）">
              <Input value={draft.note} maxLength={200} onChange={(e) => patch({ note: e.target.value })} />
            </Field>
            <div className="staff-photo-panel__actions">
              <Button variant="ghost" disabled={busy} onClick={copyMondayToWeekdays}>
                週一時段套用至週二～五
              </Button>
              <Button variant="secondary" disabled={busy || !dirty} onClick={() => void save()}>
                儲存草稿並檢查
              </Button>
              <Button disabled={busy} onClick={() => void submit()}>
                送出審核
              </Button>
            </div>
          </div>
        ) : week.status === 'SUBMITTED' ? (
          <div className="staff-photo-panel__actions">
            <Button variant="secondary" disabled={busy} onClick={() => void withdraw()}>
              撤回送審
            </Button>
          </div>
        ) : null}
      </Card>

      {data.weeks.every((w) => !w.status) && (
        <EmptyState
          icon="🗓️"
          title="尚未提報任何週班表"
          desc={isCoach ? '未核准週次不開放學員預約與開課，請提早提報。' : '未核准週次不列值勤（僅能使用「我的出勤」），請提早提報。'}
        />
      )}
    </div>
  );
}
