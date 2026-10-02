import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Select } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  createRosterPeriod,
  fetchRoster,
  fetchRosterConfigs,
  generateRosterPeriod,
  getErrorMessage,
  publishRosterPeriod,
  setRosterCell,
  unpublishRosterPeriod,
  updateRosterConfig,
} from '../../lib/api';
import { taipeiToday } from '../../lib/laborLaw';
import type { RosterBranchConfig, RosterCellCode, RosterIssue, RosterView } from '../../types/api';

const CELL_OPTIONS: { value: RosterCellCode; short: string; label: string }[] = [
  { value: 'MORNING', short: '早', label: '早班 07:00–15:30' },
  { value: 'EVENING', short: '晚', label: '晚班 15:30–24:00' },
  { value: 'REGULAR_OFF', short: '例', label: '例假' },
  { value: 'REST_DAY', short: '休', label: '休息日' },
  { value: 'OFF', short: '排', label: '排休' },
];
const CELL_SHORT = Object.fromEntries(CELL_OPTIONS.map((o) => [o.value, o.short])) as Record<RosterCellCode, string>;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const LEVEL_TONE = { ERROR: 'danger', WARNING: 'warning', INFO: 'info' } as const;

/** 場務四週（28 日）變形工時排班；合規與人力檢查全由後端計算 */
export default function ShiftRosterPanel() {
  const { toast } = useToast();
  const lockRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [configs, setConfigs] = useState<RosterBranchConfig[]>([]);
  const [branchId, setBranchId] = useState<number | ''>('');
  const [anchorDate, setAnchorDate] = useState(taipeiToday());
  const [view, setView] = useState<RosterView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [cfgDraft, setCfgDraft] = useState<
    Partial<{ cycleAnchorDate: string; morningHeadcount: number; eveningHeadcount: number }>
  >({});

  useEffect(() => {
    let alive = true;
    fetchRosterConfigs()
      .then((res) => {
        if (!alive) return;
        const list = res.data ?? [];
        setConfigs(list);
        const first = list.find((c) => c.config) ?? list[0];
        if (first) setBranchId(first.branchId);
      })
      .catch((err) => alive && setLoadError(getErrorMessage(err, '讀取排班設定失敗')));
    return () => {
      alive = false;
    };
  }, []);

  const current = configs.find((c) => c.branchId === branchId);
  const cfgForm = {
    cycleAnchorDate: cfgDraft.cycleAnchorDate ?? current?.config?.cycleAnchorDate ?? '',
    morningHeadcount: cfgDraft.morningHeadcount ?? current?.config?.requirement.MORNING ?? 2,
    eveningHeadcount: cfgDraft.eveningHeadcount ?? current?.config?.requirement.EVENING ?? 2,
  };

  useEffect(() => {
    if (!branchId || !current?.config) return;
    let alive = true;
    fetchRoster(branchId, anchorDate)
      .then((res) => {
        if (!alive) return;
        setView(res.data ?? null);
        setLoadError('');
      })
      .catch((err) => alive && setLoadError(getErrorMessage(err, '讀取排班失敗')));
    return () => {
      alive = false;
    };
  }, [branchId, anchorDate, current?.config]);

  async function run(task: () => Promise<{ message?: string; data?: RosterView }>, fallback: string) {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    try {
      const res = await task();
      if (res.data) setView(res.data);
      if (res.message) toast(res.message, res.data?.summary.errors ? 'info' : 'success');
    } catch (err) {
      toast(getErrorMessage(err, fallback), 'error');
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }

  async function saveConfig() {
    if (!branchId || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    try {
      const res = await updateRosterConfig(branchId, cfgForm);
      toast(res.message || '已更新', 'success');
      const list = await fetchRosterConfigs();
      setConfigs(list.data ?? []);
      setCfgDraft({});
    } catch (err) {
      toast(getErrorMessage(err, '更新排班設定失敗'), 'error');
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }

  const editable = view?.period?.status === 'DRAFT';
  const staffName = useMemo(() => new Map((view?.staff ?? []).map((s) => [s.id, s.name])), [view]);
  const allIssues = useMemo((): (RosterIssue & { who?: string })[] => {
    if (!view) return [];
    return [
      ...view.issues.map((i) => ({ ...i, who: undefined })),
      ...view.staff.flatMap((s) => s.issues.map((i) => ({ ...i, who: staffName.get(s.id) }))),
    ].sort((a, b) => ['ERROR', 'WARNING', 'INFO'].indexOf(a.level) - ['ERROR', 'WARNING', 'INFO'].indexOf(b.level));
  }, [view, staffName]);

  return (
    <div className="roster">
      <Card title="四週變形工時排班">
        <p className="text-muted text-sm">
          勞基法 §30-1：每日正常工時 ≤10 小時、四週 ≤160 小時；§36：每二週至少 2 日例假、四週休息日至少 4 日（合計 ≥8 日）；
          §34：輪班間隔 ≥11 小時（晚班不得接次日早班）。場務與實習教練列入編制；轉正教練不列入，改由本人提報週班表（「週班表審核」核准）。
        </p>
        {loadError && <Alert tone="error">{loadError}</Alert>}
        <div className="roster__toolbar">
          <Field label="分店">
            <Select
              value={branchId === '' ? '' : String(branchId)}
              onChange={(e) => {
                setBranchId(Number(e.target.value) || '');
                setView(null);
                setCfgDraft({});
              }}
            >
              {configs.map((c) => (
                <option key={c.branchId} value={c.branchId}>
                  {c.name}
                  {c.config ? '' : '（未設定）'}
                </option>
              ))}
            </Select>
          </Field>
          {view && (
            <div className="roster__cycle">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAnchorDate(view.cycle.prevStartDate)}>
                ◀ 上期
              </Button>
              <strong className="mono">
                {view.cycle.startDate} ～ {view.cycle.endDate}
              </strong>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAnchorDate(view.cycle.nextStartDate)}>
                下期 ▶
              </Button>
              {!view.period ? (
                <Badge tone="neutral">未建立</Badge>
              ) : view.period.status === 'PUBLISHED' ? (
                <Badge tone="success">已發布</Badge>
              ) : (
                <Badge tone="warning">草稿</Badge>
              )}
              {view.period && (
                <>
                  <Badge tone={view.summary.errors ? 'danger' : 'success'}>違規／缺額 {view.summary.errors}</Badge>
                  <Badge tone={view.summary.warnings ? 'warning' : 'neutral'}>提醒 {view.summary.warnings}</Badge>
                </>
              )}
            </div>
          )}
        </div>

        {view && (
          <div className="staff-photo-panel__actions">
            {!view.period && (
              <Button
                loading={busy}
                onClick={() => void run(() => createRosterPeriod(view.branch.id, view.cycle.startDate), '建立排班期失敗')}
              >
                建立本期排班
              </Button>
            )}
            {editable && view.period && (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm('自動排班會覆蓋本期草稿，確定？')) return;
                    void run(() => generateRosterPeriod(view.period!.id), '自動排班失敗');
                  }}
                >
                  自動排班
                </Button>
                <Button
                  disabled={busy || view.summary.errors > 0}
                  onClick={() => void run(() => publishRosterPeriod(view.period!.id), '發布排班失敗')}
                >
                  發布
                </Button>
              </>
            )}
            {view.period?.status === 'PUBLISHED' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt('撤回發布原因（必填）');
                  if (!reason?.trim()) return;
                  void run(() => unpublishRosterPeriod(view.period!.id, reason.trim()), '撤回發布失敗');
                }}
              >
                撤回發布
              </Button>
            )}
          </div>
        )}
        {view?.period?.note && <p className="text-muted text-sm">{view.period.note}</p>}
      </Card>

      {current && (
        <details className="roster__config">
          <summary>排班設定：{current.name}</summary>
          <div className="hr-holiday-form">
            <Field label="週期起算日" hint="四週週期固定；已有排班期後不可更改">
              <Input
                type="date"
                value={cfgForm.cycleAnchorDate}
                onChange={(e) => setCfgDraft((p) => ({ ...p, cycleAnchorDate: e.target.value }))}
              />
            </Field>
            <Field label="早班場務人力（≥2）">
              <Input
                type="number"
                min={2}
                max={10}
                value={cfgForm.morningHeadcount}
                onChange={(e) => setCfgDraft((p) => ({ ...p, morningHeadcount: Number(e.target.value) }))}
              />
            </Field>
            <Field label="晚班場務人力（≥2）">
              <Input
                type="number"
                min={2}
                max={10}
                value={cfgForm.eveningHeadcount}
                onChange={(e) => setCfgDraft((p) => ({ ...p, eveningHeadcount: Number(e.target.value) }))}
              />
            </Field>
            <Button disabled={busy || !cfgForm.cycleAnchorDate} onClick={() => void saveConfig()}>
              儲存設定
            </Button>
          </div>
        </details>
      )}

      {view?.summary.acks && <AckTracker view={view} />}

      {view && <OffRequestInbox view={view} />}

      {view && (
        <div className="table-wrap roster__grid-wrap">
          <table className="data-table roster__grid">
            <thead>
              <tr>
                <th className="roster__sticky">人員</th>
                {view.cycle.days.map((d, i) => (
                  <th
                    key={d.date}
                    className={`roster__day${d.holiday ? ' is-holiday' : ''}${i % 7 === 0 ? ' is-week-start' : ''}${i === 14 ? ' is-block-start' : ''}`}
                    title={d.holiday ?? undefined}
                  >
                    {d.date.slice(5).replace('-', '/')}
                    <br />
                    <span className="text-sm">{WEEKDAYS[d.weekday]}</span>
                  </th>
                ))}
                <th>班數</th>
                <th>工時</th>
                <th>例假</th>
                <th>休息日</th>
              </tr>
            </thead>
            <tbody>
              {view.staff.map((s) => {
                const errs = s.issues.filter((i) => i.level === 'ERROR').length;
                return (
                  <tr key={s.id}>
                    <td className="roster__sticky">
                      <strong>{s.name}</strong>
                      <div className="text-muted text-sm">
                        {s.rosterRoleLabel}
                        {s.weeklyHours ? `・週 ${s.weeklyHours} 時` : ''}
                      </div>
                      {errs > 0 && <Badge tone="danger">違規 {errs}</Badge>}
                      {s.stats.requestedOffUnmet > 0 && <Badge tone="warning">排假未滿足 {s.stats.requestedOffUnmet}</Badge>}
                      {view.summary.acks && Object.keys(s.cells).length > 0 && (
                        <Badge tone={s.ack?.status === 'CONFIRMED' ? 'success' : s.ack ? 'warning' : 'neutral'}>
                          {s.ack?.status === 'CONFIRMED' ? (s.ack.autoConfirmed ? '自動同意' : '已確認') : s.ack ? '異議' : '未確認'}
                        </Badge>
                      )}
                    </td>
                    {view.cycle.days.map((d, i) => {
                      const cell = s.cells[d.date];
                      const onLeave = s.leaveDays.includes(d.date);
                      const requested = s.offRequest?.dates.includes(d.date) ?? false;
                      const cls = `roster__cell roster__cell--${cell ?? 'EMPTY'}${onLeave ? ' is-leave' : ''}${requested ? ' is-requested' : ''}${i % 7 === 0 ? ' is-week-start' : ''}${i === 14 ? ' is-block-start' : ''}`;
                      if (!editable) {
                        return (
                          <td key={d.date} className={cls} title={onLeave ? '已核准請假' : requested ? '員工申請排休' : undefined}>
                            {cell ? CELL_SHORT[cell] : onLeave ? '假' : '—'}
                          </td>
                        );
                      }
                      return (
                        <td key={d.date} className={cls} title={requested ? '員工申請排休' : undefined}>
                          <select
                            aria-label={`${s.name} ${d.date}`}
                            value={cell ?? ''}
                            disabled={busy}
                            onChange={(e) =>
                              void run(
                                () =>
                                  setRosterCell(view.period!.id, {
                                    staffId: s.id,
                                    date: d.date,
                                    value: (e.target.value || null) as RosterCellCode | null,
                                  }),
                                '更新排班失敗',
                              )
                            }
                          >
                            <option value="">{onLeave ? '假' : '—'}</option>
                            {CELL_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value} title={o.label}>
                                {o.short}
                              </option>
                            ))}
                          </select>
                        </td>
                      );
                    })}
                    <td className="mono">
                      {s.stats.workDays}/{s.capacity}
                    </td>
                    <td className={`mono${s.stats.workHours > 160 ? ' roster__bad' : ''}`}>{s.stats.workHours}/160</td>
                    <td className={`mono${s.stats.regularOff.some((n) => n < 2) ? ' roster__bad' : ''}`}>
                      {s.stats.regularOff.join('+')}
                    </td>
                    <td className="mono">{s.stats.restDays}</td>
                  </tr>
                );
              })}
              {(['MORNING', 'EVENING'] as const).map((code) => (
                <tr key={code} className="roster__coverage">
                  <td className="roster__sticky">
                    <strong>{code === 'MORNING' ? '早班人力' : '晚班人力'}</strong>
                    <div className="text-muted text-sm">需 {view.requirement[code]} 人</div>
                  </td>
                  {view.coverage.map((c, i) => (
                    <td
                      key={c.date}
                      className={`mono${c[code] < view.requirement[code] ? ' roster__short' : ''}${i % 7 === 0 ? ' is-week-start' : ''}${i === 14 ? ' is-block-start' : ''}`}
                    >
                      {c[code]}
                    </td>
                  ))}
                  <td colSpan={4} />
                </tr>
              ))}
              {view.staff.length === 0 && (
                <tr>
                  <td colSpan={33} className="text-muted text-center">
                    本店尚無場務或實習教練可排班
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view?.period && allIssues.length > 0 && (
        <Card title="合規與人力檢查" className="mt-md">
          <ul className="roster__issues">
            {allIssues.slice(0, 80).map((i, idx) => (
              <li key={`${i.code}-${i.who ?? ''}-${i.date ?? ''}-${idx}`}>
                <Badge tone={LEVEL_TONE[i.level]}>{i.level === 'ERROR' ? '違規' : i.level === 'WARNING' ? '提醒' : '資訊'}</Badge>{' '}
                {i.who ? <strong>{i.who}：</strong> : null}
                {i.message}
              </li>
            ))}
          </ul>
          {allIssues.length > 80 && <p className="text-muted text-sm">另有 {allIssues.length - 80} 項未列出</p>}
        </Card>
      )}
    </div>
  );
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 發布後員工確認回覆追蹤（72 小時內）；有異議時店長可撤回調整後重發，重發須重新確認 */
function AckTracker({ view }: { view: RosterView }) {
  const acks = view.summary.acks!;
  const assigned = view.staff.filter((s) => Object.keys(s.cells).length > 0 && s.rosterRole !== 'FREE_TRAINER');
  const disputed = assigned.filter((s) => s.ack?.status === 'DISPUTED');
  const pending = assigned.filter((s) => !s.ack);
  const late = assigned.filter((s) => s.ack?.late);
  return (
    <Card title={`員工班表確認（已確認 ${acks.confirmed}／${acks.total} 人）`}>
      <p className="text-sm">
        確認期限 {formatTime(acks.deadline)}（發布後 {acks.hours / 24} 日，逾期未回覆自動視為同意）{' '}
        {acks.overdue ? (
          <Badge tone="warning">逾期待自動同意 {acks.pending} 人</Badge>
        ) : acks.pending > 0 ? (
          <Badge tone="warning">待回覆 {acks.pending} 人</Badge>
        ) : (
          <Badge tone="success">全員已回覆</Badge>
        )}
        {acks.autoConfirmed > 0 && <Badge tone="neutral">自動同意 {acks.autoConfirmed} 人</Badge>}
        {acks.disputed > 0 && <Badge tone="warning">異議 {acks.disputed} 人</Badge>}
      </p>
      {disputed.length > 0 && (
        <ul className="roster__requests">
          {disputed.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong>
              <span>「{s.ack!.message}」</span>
              <span className="text-muted text-sm">{formatTime(s.ack!.respondedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {pending.length > 0 && (
        <p className="text-muted text-sm">尚未回覆：{pending.map((s) => s.name).join('、')}</p>
      )}
      {late.length > 0 && <p className="text-muted text-sm">逾期回覆：{late.map((s) => s.name).join('、')}</p>}
      {disputed.length > 0 && (
        <p className="text-muted text-sm">處理異議：撤回發布（填原因）→ 調整班表 → 重新發布，員工須重新確認。</p>
      )}
    </Card>
  );
}

/** 店長收件匣：本期員工排假申請（後端依申請避開排班並優先標為例假／休息日） */
function OffRequestInbox({ view }: { view: RosterView }) {
  const { submitted, total } = view.summary.offRequests;
  const requested = view.staff.filter((s) => s.offRequest);
  const pending = view.staff.filter((s) => !s.offRequest && s.rosterRole !== 'FREE_TRAINER');
  const deadline = view.cycle.offRequestDeadline;
  const closed = view.period?.status === 'PUBLISHED' || taipeiToday() > deadline;
  return (
    <Card title={`員工排假申請（已遞交 ${submitted}／${total} 人）`}>
      <p className="text-sm">
        <Badge tone={closed ? 'neutral' : 'info'}>{closed ? '已截止' : '收件中'}</Badge> 排假截止 {deadline}
        （每期開始前 14 日）{closed ? '，可依申請開始排班。' : '，截止後再排班可避免員工修改。'}
      </p>
      {requested.length === 0 ? (
        <p className="text-muted text-sm">本期尚無員工遞交排假申請。</p>
      ) : (
        <ul className="roster__requests">
          {requested.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong>
              <span className="mono">{s.offRequest!.dates.map((d) => d.slice(5).replace('-', '/')).join('、')}</span>
              {s.stats.requestedOffUnmet > 0 && <Badge tone="warning">未滿足 {s.stats.requestedOffUnmet} 日</Badge>}
              {s.offRequest!.note && <span className="text-muted">「{s.offRequest!.note}」</span>}
              <span className="text-muted text-sm">更新於 {formatTime(s.offRequest!.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {pending.length > 0 && (
        <p className="text-muted text-sm">尚未遞交：{pending.map((s) => s.name).join('、')}</p>
      )}
      <p className="text-muted text-sm">
        自動排班會避開申請日並優先標為例假／休息日；人力不足時才排入並列為提醒。申請日在班表以黃色虛框標示。
      </p>
    </Card>
  );
}
