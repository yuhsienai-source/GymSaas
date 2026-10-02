import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Select } from '../ui';
import ReasonModal from './ReasonModal';
import { useToast } from '../../contexts/ToastContext';
import { fetchCoachPlanReviews, getErrorMessage, reviewCoachPlan } from '../../lib/api';
import { EMPLOYMENT_TYPE_LABELS } from '../../lib/laborLaw';
import { positionLabel } from '../../lib/orgStructure';
import type { CoachPlanReviewList, CoachPlanStatus, CoachWeekPlan, WeekPlanRole } from '../../types/api';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const STATUS_TONE: Record<CoachPlanStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  DRAFT: 'neutral',
  SUBMITTED: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
};
const shortDate = (key: string) => key.slice(5).replace('-', '/');
const hours = (min: number) => `${(min / 60).toFixed(1).replace(/\.0$/, '')}h`;

type Pending = { plan: CoachWeekPlan; action: 'reject' | 'reopen' };

const KIND_TITLES: Record<WeekPlanRole | 'ALL', string> = {
  ALL: '週班表審核',
  COACH: '教練週班表審核',
  MANAGER: '管理職週班表審核（店長／GM／FM）',
};

type Props = {
  /** 固定審核類別；未指定時依後端回傳可審類別，多類別可切換 */
  kind?: WeekPlanRole;
};

/** 週班表審核：教練 → FM／該分店店長；店長・GM・FM → ADMIN。可審範圍與勞基法檢查皆由後端判定，有違規不可核准 */
export default function CoachPlanReviewPanel({ kind }: Props) {
  const { toast } = useToast();
  const lockRef = useRef(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [status, setStatus] = useState<CoachPlanStatus | 'ALL'>('SUBMITTED');
  const [kindFilter, setKindFilter] = useState<WeekPlanRole | 'ALL'>(kind ?? 'ALL');
  const [data, setData] = useState<CoachPlanReviewList | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCoachPlanReviews({ status, kind: kindFilter === 'ALL' ? undefined : kindFilter })
      .then((res) => {
        if (cancelled) return;
        setData(res.data ?? null);
        setError('');
      })
      .catch((err) => !cancelled && setError(getErrorMessage(err, '讀取週班表失敗')));
    return () => {
      cancelled = true;
    };
  }, [status, kindFilter, reloadKey]);

  const canSwitchKind = !kind && (data?.kinds?.length ?? 0) > 1;
  const effectiveKind: WeekPlanRole | 'ALL' =
    kindFilter !== 'ALL' ? kindFilter : data?.kinds?.length === 1 ? data.kinds[0] : 'ALL';

  async function act(plan: CoachWeekPlan, action: 'approve' | 'reject' | 'reopen', reason?: string) {
    if (lockRef.current || !plan.id) return false;
    lockRef.current = true;
    setBusyId(plan.id);
    try {
      const res = await reviewCoachPlan(plan.id, action, reason);
      toast(res.message || '已處理', 'success');
      setReloadKey((k) => k + 1);
      return true;
    } catch (err) {
      toast(getErrorMessage(err, '審核失敗'), 'error');
      setReloadKey((k) => k + 1);
      return false;
    } finally {
      lockRef.current = false;
      setBusyId(null);
    }
  }

  const items = data?.items ?? [];
  return (
    <Card
      title={`${KIND_TITLES[effectiveKind]}${status === 'SUBMITTED' && items.length ? `（待審 ${items.length}）` : ''}`}
      className="mt-md"
    >
      <p className="text-muted text-sm">
        {effectiveKind === 'MANAGER'
          ? '店長、店務部主管（GM）、教練部主管（FM）每週自行提報出勤時段，經總公司核准後生效，作為值勤判定與出勤打卡依據。'
          : effectiveKind === 'COACH'
            ? '轉正教練每週自行提報出勤時段（不列入四週排班編制），經教練部主管（FM）或該分店店長核准後生效並開放開課／預約。'
            : '轉正教練週班表由 FM／該分店店長審核；店長／GM／FM 週班表由總公司審核。核准後才生效。'}
        系統依勞基法 §30（日 8h／週 40h）、§35（連續 4h 休息 30 分）、§36（例假＋休息日、最多連續 6 日）、§34（間隔 11h）檢查；有違規項目不可核准。
        核准後如需調整，請撤回核准（附原因）由提報人修改重送；不得審核本人班表。
      </p>
      <div className="roster__toolbar">
        {canSwitchKind && (
          <Field label="類別">
            <Select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as WeekPlanRole | 'ALL')}>
              <option value="ALL">全部</option>
              <option value="MANAGER">管理職（店長／GM／FM）</option>
              <option value="COACH">教練</option>
            </Select>
          </Field>
        )}
        <Field label="狀態">
          <Select value={status} onChange={(e) => setStatus(e.target.value as CoachPlanStatus | 'ALL')}>
            <option value="SUBMITTED">待審核</option>
            <option value="APPROVED">已核准</option>
            <option value="REJECTED">已退回</option>
            <option value="ALL">全部（不含草稿）</option>
          </Select>
        </Field>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!error && data && items.length === 0 && <p className="text-muted text-sm">目前沒有符合條件的週班表。</p>}
      <div className="coach-plan__days">
        {items.map((p) => {
          const ev = p.evaluation;
          const days = ev?.stats.days ?? [];
          return (
            <div key={p.id} className="coach-plan__day">
              <div className="coach-plan__day-head">
                <strong>{p.staff?.name ?? `#${p.staffId}`}</strong>
                {p.staffRole && <Badge tone={p.planRole === 'MANAGER' ? 'warning' : 'neutral'}>{positionLabel(p.staffRole)}</Badge>}
                {p.employmentType && <Badge tone="neutral">{EMPLOYMENT_TYPE_LABELS[p.employmentType] ?? p.employmentType}</Badge>}
                {p.branchName && <span className="text-muted text-sm">{p.branchName}</span>}
                <span className="mono">
                  {p.weekStart} ～ {p.weekEnd}
                </span>
                {p.status && <Badge tone={STATUS_TONE[p.status]}>{p.statusLabel}</Badge>}
                {ev && (
                  <Badge tone="info">
                    工時 {hours(ev.stats.weekWorkMinutes)}
                    {ev.stats.leaveMinutes > 0 ? `＋請假 ${hours(ev.stats.leaveMinutes)}` : ''}
                    {ev.stats.agreedMinutes != null ? `／約定 ${hours(ev.stats.agreedMinutes)}` : ''}
                  </Badge>
                )}
                {ev && <Badge tone={ev.hasError ? 'danger' : 'success'}>{ev.hasError ? '有違規' : '符合規定'}</Badge>}
              </div>
              <ul className="roster__requests">
                {days.map((d) => (
                  <li key={d.date}>
                    <span className="mono">
                      {shortDate(d.date)}（{WEEKDAYS[d.weekday]}）
                    </span>
                    <Badge tone={d.kind === 'REGULAR_OFF' ? 'danger' : d.kind === 'REST_DAY' ? 'success' : d.kind === 'WORK' ? 'info' : 'neutral'}>
                      {d.kindLabel}
                    </Badge>
                    {d.slots.length > 0 && <span>{d.slots.map((s) => `${s.start}–${s.end}`).join('、')}</span>}
                    {d.kind === 'WORK' && (
                      <span className="text-muted text-sm">
                        {hours(d.workMinutes)}
                        {d.breakMinutes > 0 ? `（扣休息 ${d.breakMinutes} 分）` : ''}
                      </span>
                    )}
                    {d.holiday && <Badge tone="danger">{d.holiday}</Badge>}
                    {d.leaveMinutes > 0 && <Badge tone="warning">請假 {hours(d.leaveMinutes)}</Badge>}
                  </li>
                ))}
              </ul>
              {p.classes.length > 0 && (
                <p className="text-muted text-sm">
                  已排課程 {p.classes.length} 堂：
                  {p.classes
                    .slice(0, 6)
                    .map((c) => `${shortDate(c.date)} ${c.start} ${c.title}`)
                    .join('、')}
                  {p.classes.length > 6 ? '…' : ''}
                </p>
              )}
              {ev && ev.issues.length > 0 && (
                <ul className="roster__issues">
                  {ev.issues.map((it, idx) => (
                    <li key={`${it.code}-${it.date ?? ''}-${idx}`}>
                      <Badge tone={it.level === 'ERROR' ? 'danger' : 'warning'}>{it.level === 'ERROR' ? '違規' : '提醒'}</Badge>{' '}
                      {it.date ? <span className="mono">{shortDate(it.date)} </span> : null}
                      {it.message}
                    </li>
                  ))}
                </ul>
              )}
              {p.note && <p className="text-sm">提報人備註：「{p.note}」</p>}
              {p.canReview === false && p.status !== 'DRAFT' && (
                <p className="text-muted text-sm">此班表不在您的審核權限內（僅供檢視）。</p>
              )}
              {p.reviewNote && p.status !== 'SUBMITTED' && (
                <p className="text-muted text-sm">
                  審核意見：「{p.reviewNote}」{p.reviewedBy?.name ? `（${p.reviewedBy.name}）` : ''}
                </p>
              )}
              <div className="staff-photo-panel__actions">
                {p.canReview !== false && p.status === 'SUBMITTED' && (
                  <>
                    <Button
                      size="sm"
                      disabled={busyId !== null || ev?.hasError}
                      loading={busyId === p.id}
                      onClick={() => void act(p, 'approve')}
                    >
                      核准
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busyId !== null} onClick={() => setPending({ plan: p, action: 'reject' })}>
                      退回
                    </Button>
                  </>
                )}
                {p.canReview !== false && p.status === 'APPROVED' && (
                  <Button size="sm" variant="ghost" disabled={busyId !== null} onClick={() => setPending({ plan: p, action: 'reopen' })}>
                    撤回核准
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {pending && (
        <ReasonModal
          title={pending.action === 'reject' ? '退回週班表' : '撤回已核准班表'}
          label={pending.action === 'reject' ? '退回原因（提報人可見）' : '撤回原因（提報人可見）'}
          confirmLabel={pending.action === 'reject' ? '退回' : '撤回核准'}
          danger
          onSubmit={(reason) => act(pending.plan, pending.action, reason)}
          onClose={() => setPending(null)}
        >
          <p className="text-sm">
            {pending.plan.staff?.name}・{pending.plan.weekStart} ～ {pending.plan.weekEnd}
            {pending.action === 'reopen'
              ? pending.plan.planRole === 'MANAGER'
                ? '。撤回後班表回到草稿、該週不列值勤（僅能使用「我的出勤」），須由本人修改重送。'
                : '。撤回後班表回到草稿、該週不開放新預約（已排課程保留），教練須修改重送。'
              : ''}
          </p>
        </ReasonModal>
      )}
    </Card>
  );
}
