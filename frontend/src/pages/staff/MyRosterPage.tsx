import { useEffect, useRef, useState } from 'react';
import CoachWeekPlanPanel from '../../components/staff/CoachWeekPlanPanel';
import { Alert, Badge, Button, Card, EmptyState, Field, Input } from '../../components/ui';
import { useToast } from '../../contexts/ToastContext';
import { fetchMyRosterOverview, getErrorMessage, respondRosterAck, submitMyOffRequest } from '../../lib/api';
import { taipeiToday } from '../../lib/laborLaw';
import type { MyRosterCycle, MyRosterOverview, RosterAckStatus, RosterCellCode } from '../../types/api';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const CELL_LABEL: Record<RosterCellCode, string> = {
  MORNING: '早班',
  EVENING: '晚班',
  REGULAR_OFF: '例假',
  REST_DAY: '休息日',
  OFF: '排休',
};
const isShift = (c?: RosterCellCode) => c === 'MORNING' || c === 'EVENING';
const CYCLE_LABELS = ['本期', '下一期', '下下期'];
const shortDate = (key: string) => key.slice(5).replace('-', '/');
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

type Draft = { dates: string[]; note: string };

/** 員工本人：遞交本期／下一期排假申請，查看已發布班表（草稿不顯示） */
export default function MyRosterPage() {
  const { toast } = useToast();
  const lockRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<MyRosterOverview | null>(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  useEffect(() => {
    let alive = true;
    fetchMyRosterOverview()
      .then((res) => alive && setData(res.data ?? null))
      .catch((err) => alive && setError(getErrorMessage(err, '讀取排班資料失敗')));
    return () => {
      alive = false;
    };
  }, []);

  const draftOf = (c: MyRosterCycle): Draft =>
    drafts[c.startDate] ?? { dates: c.request?.dates ?? [], note: c.request?.note ?? '' };

  function patchDraft(c: MyRosterCycle, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [c.startDate]: { ...draftOf(c), ...patch } }));
  }

  function toggleDate(c: MyRosterCycle, date: string) {
    if (c.locked || !data) return;
    const { dates } = draftOf(c);
    if (dates.includes(date)) {
      patchDraft(c, { dates: dates.filter((d) => d !== date) });
    } else if (dates.length >= data.maxOffDays) {
      toast(`本期最多申請 ${data.maxOffDays} 日排休`, 'info');
    } else {
      patchDraft(c, { dates: [...dates, date].sort() });
    }
  }

  async function withLock(task: () => Promise<{ message?: string; data?: MyRosterOverview }>, fallback: string) {
    if (lockRef.current) return false;
    lockRef.current = true;
    setBusy(true);
    try {
      const res = await task();
      if (res.data) setData(res.data);
      toast(res.message || '已送出', 'success');
      return true;
    } catch (err) {
      toast(getErrorMessage(err, fallback), 'error');
      return false;
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }

  async function submit(c: MyRosterCycle, withdraw = false) {
    const d = draftOf(c);
    const ok = await withLock(
      () =>
        submitMyOffRequest({
          cycleStartDate: c.startDate,
          dates: withdraw ? [] : d.dates,
          note: withdraw ? undefined : d.note.trim() || undefined,
        }),
      '遞交排假申請失敗',
    );
    if (ok) {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[c.startDate];
        return next;
      });
    }
  }

  async function respond(c: MyRosterCycle, status: RosterAckStatus, message?: string) {
    await withLock(() => respondRosterAck({ cycleStartDate: c.startDate, status, message }), '班表確認回覆失敗');
  }

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <p className="text-muted">載入中…</p>;
  if (data.weekPlanRole) return <CoachWeekPlanPanel />;
  if (!data.eligible) {
    return <EmptyState icon="📅" title="不需遞交排假" desc="排假申請僅適用分店排班編制（場務、實習教練）；轉正教練與店長／GM／FM 改提報週班表。" />;
  }
  if (!data.configured) {
    return <EmptyState icon="📅" title="分店尚未開放排班" desc="所屬分店尚未設定四週排班週期，請洽店長。" />;
  }

  return (
    <div className="hq-dashboard my-roster">
      <p className="text-muted text-sm">
        {data.branch?.name}・{data.rosterRoleLabel}。點選希望休假的日期後遞交，店長排班時會優先安排為例假／休息日；
        每期最多 {data.maxOffDays} 日，<strong>每期開始前 {data.offRequestDeadlineDays} 日截止</strong>。班表發布後須於{' '}
        {data.ackHours / 24} 日內確認回覆；人力不足時仍可能排班，請以發布之班表為準。
      </p>
      {data.cycles.map((c, idx) => {
        const draft = draftOf(c);
        const saved = c.request?.dates ?? [];
        const dirty =
          draft.dates.join() !== saved.join() || draft.note.trim() !== (c.request?.note ?? '');
        const published = c.period?.status === 'PUBLISHED';
        const unmet = published ? saved.filter((d) => isShift(c.cells[d])).length : 0;
        const daysLeft = daysBetween(taipeiToday(), c.offRequestDeadline);
        return (
          <Card key={c.startDate} title={`${CYCLE_LABELS[idx] ?? '後續'}：${c.startDate} ～ ${c.endDate}`}>
            <div className="my-roster__status">
              {published ? (
                <Badge tone="success">班表已發布</Badge>
              ) : !c.locked ? (
                <Badge tone={daysLeft <= 3 ? 'warning' : 'neutral'}>
                  開放排假・{shortDate(c.offRequestDeadline)} 截止（剩 {daysLeft + 1} 天）
                </Badge>
              ) : (
                <Badge tone="warning">排假已截止・{c.period ? '店長排班中' : '待店長排班'}</Badge>
              )}
              {c.request ? (
                <Badge tone="info">已遞交 {saved.length} 日</Badge>
              ) : (
                <Badge tone="neutral">尚未遞交</Badge>
              )}
              {published && c.request && (
                <Badge tone={unmet ? 'warning' : 'success'}>
                  {unmet ? `${unmet} 日因人力不足仍排班` : '排假皆已安排'}
                </Badge>
              )}
            </div>

            {c.ack && (
              <RosterAckSection
                ack={c.ack}
                busy={busy}
                onRespond={(status, message) => void respond(c, status, message)}
              />
            )}

            <div className="my-roster__grid" role="grid" aria-label={`${c.startDate} 週期`}>
              {c.days.slice(0, 7).map((d) => (
                <div key={`h-${d.date}`} className="my-roster__weekday">
                  {WEEKDAYS[d.weekday]}
                </div>
              ))}
              {c.days.map((d) => {
                const cell = c.cells[d.date];
                const onLeave = c.leaveDays.includes(d.date);
                const selected = draft.dates.includes(d.date);
                return (
                  <button
                    key={d.date}
                    type="button"
                    className={`my-roster__day${selected ? ' is-selected' : ''}${cell ? ` my-roster__day--${cell}` : ''}${d.holiday ? ' is-holiday' : ''}`}
                    disabled={c.locked || busy}
                    aria-pressed={selected}
                    onClick={() => toggleDate(c, d.date)}
                    title={d.holiday ?? undefined}
                  >
                    <span className="mono">{d.date.slice(5).replace('-', '/')}</span>
                    <small>
                      {cell ? CELL_LABEL[cell] : onLeave ? '請假' : selected ? '申請休' : d.holiday ?? ' '}
                    </small>
                  </button>
                );
              })}
            </div>

            {!c.locked && (
              <div className="my-roster__form">
                <Field label={`備註（選填）・已選 ${draft.dates.length}／${data.maxOffDays} 日`}>
                  <Input
                    value={draft.note}
                    maxLength={200}
                    placeholder="例：家庭聚會、考試"
                    onChange={(e) => patchDraft(c, { note: e.target.value })}
                  />
                </Field>
                <div className="staff-photo-panel__actions">
                  <Button disabled={busy || !dirty || draft.dates.length === 0} onClick={() => void submit(c)}>
                    {c.request ? '更新排假申請' : '遞交排假申請'}
                  </Button>
                  {c.request && (
                    <Button variant="ghost" disabled={busy} onClick={() => void submit(c, true)}>
                      撤回申請
                    </Button>
                  )}
                </div>
                {c.request && (
                  <p className="text-muted text-sm">
                    最後遞交：{formatDateTime(c.request.updatedAt)}
                  </p>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/** 班表確認回覆：發布後限期內確認或提出異議（異議須附說明，店長可撤回調整後重發） */
function RosterAckSection({
  ack,
  busy,
  onRespond,
}: {
  ack: NonNullable<MyRosterCycle['ack']>;
  busy: boolean;
  onRespond: (status: RosterAckStatus, message?: string) => void;
}) {
  const [disputing, setDisputing] = useState(false);
  const [text, setText] = useState('');

  const tone = ack.status === 'CONFIRMED' ? 'success' : ack.status === 'DISPUTED' ? 'info' : 'warning';
  return (
    <Alert tone={tone}>
      {ack.status === 'PENDING' ? (
        <p>
          {ack.overdue
            ? '已逾確認期限，系統即將自動視為同意。'
            : `請於 ${formatDateTime(ack.deadline)} 前確認班表，逾期未回覆將自動視為同意。`}
        </p>
      ) : ack.autoConfirmed ? (
        <p>逾期未回覆，系統已於 {formatDateTime(ack.deadline)} 自動視為同意班表。如有問題仍可提出異議，請同時告知店長。</p>
      ) : (
        <p>
          {ack.status === 'CONFIRMED' ? '已確認班表' : `已提出異議：「${ack.message ?? ''}」`}
          {ack.respondedAt ? `（${formatDateTime(ack.respondedAt)}${ack.late ? '，逾期回覆' : ''}）` : ''}
        </p>
      )}
      {disputing ? (
        <div className="my-roster__form">
          <Field label="異議說明（必填）">
            <Input value={text} maxLength={300} placeholder="例：11/20 需回診，請改休" onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="staff-photo-panel__actions">
            <Button
              disabled={busy || !text.trim()}
              onClick={() => {
                onRespond('DISPUTED', text.trim());
                setDisputing(false);
              }}
            >
              送出異議
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDisputing(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="staff-photo-panel__actions">
          {ack.status !== 'CONFIRMED' && (
            <Button disabled={busy} onClick={() => onRespond('CONFIRMED')}>
              確認班表
            </Button>
          )}
          {ack.status !== 'DISPUTED' && (
            <Button variant="secondary" disabled={busy} onClick={() => setDisputing(true)}>
              提出異議
            </Button>
          )}
        </div>
      )}
    </Alert>
  );
}
