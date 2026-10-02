import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Modal, Skeleton } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  bookMemberGroupMakeup,
  cancelMemberGroupWaitlist,
  enrollMemberGroup,
  fetchMemberGroupOverview,
  fetchMemberGroupSeries,
  fetchMemberGroupSeriesDetail,
  fetchMemberMakeupOptions,
  getErrorMessage,
  joinMemberGroupWaitlist,
  redirectToCheckOut,
  requestMemberGroupLeave,
} from '../../lib/api';
import { formatMoney } from '../../lib/hrFormat';
import {
  classWhen,
  dateKey,
  ENROLL_KIND_LABEL,
  ENROLL_STATUS_META,
  RESERVATION_STATUS_LABEL,
  seriesScheduleLabel,
  WAITLIST_STATUS_META,
} from '../../lib/groupClass';
import type {
  GroupEnrollKind,
  GroupMakeupCredit,
  GroupMakeupOption,
  GroupMemberOverview,
  GroupSellableSeries,
  GroupSeriesDetail,
} from '../../types/api';

type EnrollTarget = {
  series: GroupSellableSeries | GroupSeriesDetail;
  kind: GroupEnrollKind;
  classId?: number;
  classStartAt?: string;
  /** 後端報價（僅顯示） */
  price: number | null;
  sessions: number;
  prorated: boolean;
};

const rowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  alignItems: 'flex-start',
  padding: '0.75rem 0',
  borderBottom: '1px solid var(--border, #e5e5e5)',
} as const;

const listStyle = { listStyle: 'none', padding: 0, margin: 0 } as const;

/** 會員團課：付費期班報名（整期／插班按比例／單堂）、候補、請假補課 */
export default function MemberGroupClassPanel() {
  const { toast } = useToast();
  const [series, setSeries] = useState<GroupSellableSeries[]>([]);
  const [overview, setOverview] = useState<GroupMemberOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [detail, setDetail] = useState<GroupSeriesDetail | null>(null);
  const [enrollTarget, setEnrollTarget] = useState<EnrollTarget | null>(null);
  const [payMethod, setPayMethod] = useState<'LINEPAY' | 'CARD'>('LINEPAY');
  const enrollInFlightRef = useRef(false);
  const [enrolling, setEnrolling] = useState(false);

  const [makeupCredit, setMakeupCredit] = useState<GroupMakeupCredit | null>(null);
  const [makeupOptions, setMakeupOptions] = useState<GroupMakeupOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [sRes, oRes] = await Promise.all([fetchMemberGroupSeries(), fetchMemberGroupOverview()]);
        if (cancelled) return;
        setSeries(sRes.data || []);
        setOverview(oRes.data || null);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入團課失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  async function run(key: string, fn: () => Promise<{ message?: string }>, fallback: string) {
    if (busyKey) return;
    setBusyKey(key);
    try {
      const res = await fn();
      toast(res.message || '完成', 'success');
      reload();
    } catch (err) {
      toast(getErrorMessage(err, fallback), 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function openDetail(seriesId: number) {
    setBusyKey(`detail-${seriesId}`);
    try {
      const res = await fetchMemberGroupSeriesDetail(seriesId);
      setDetail(res.data || null);
    } catch (err) {
      toast(getErrorMessage(err, '讀取期班失敗'), 'error');
    } finally {
      setBusyKey(null);
    }
  }

  function openTermEnroll(s: GroupSellableSeries) {
    setEnrollTarget({
      series: s,
      kind: 'TERM',
      price: s.termQuote?.price ?? null,
      sessions: s.termQuote?.sessions ?? s.remainingSessions,
      prorated: Boolean(s.termQuote?.prorated),
    });
  }

  function openDropInEnroll(d: GroupSeriesDetail, classId: number, startAt: string) {
    setEnrollTarget({
      series: d,
      kind: 'DROP_IN',
      classId,
      classStartAt: startAt,
      price: d.dropInPrice,
      sessions: 1,
      prorated: false,
    });
  }

  async function confirmEnroll() {
    if (!enrollTarget || enrollInFlightRef.current) return;
    enrollInFlightRef.current = true;
    setEnrolling(true);
    try {
      const res = await enrollMemberGroup({
        seriesId: enrollTarget.series.id,
        kind: enrollTarget.kind,
        ...(enrollTarget.classId ? { classId: enrollTarget.classId } : {}),
        payMethod,
      });
      const data = res.data;
      if (data?.paymentUrl) {
        toast('已保留名額，導向 LINE Pay 付款…', 'info');
        window.location.assign(data.paymentUrl);
        return;
      }
      if (data?.actionUrl && data.payload) {
        toast('已保留名額，導向刷卡頁…', 'info');
        redirectToCheckOut(data.actionUrl, data.payload);
        return;
      }
      toast(res.message || '報名已建立', 'info');
      setEnrollTarget(null);
      reload();
    } catch (err) {
      toast(getErrorMessage(err, '報名失敗'), 'error');
      reload();
    } finally {
      setEnrolling(false);
      enrollInFlightRef.current = false;
    }
  }

  async function openMakeup(credit: GroupMakeupCredit) {
    setMakeupCredit(credit);
    setMakeupOptions(null);
    try {
      const res = await fetchMemberMakeupOptions(credit.id);
      setMakeupOptions(res.data?.options || []);
    } catch (err) {
      toast(getErrorMessage(err, '讀取補課堂次失敗'), 'error');
      setMakeupCredit(null);
    }
  }

  async function bookMakeup(opt: GroupMakeupOption) {
    if (!makeupCredit) return;
    const creditId = makeupCredit.id;
    await run(
      `makeup-${opt.classId}`,
      () => bookMemberGroupMakeup({ creditId, classId: opt.classId }),
      '補課預約失敗',
    );
    setMakeupCredit(null);
  }

  const enrollments = overview?.enrollments || [];
  const waitlist = overview?.waitlist || [];
  const credits = (overview?.makeupCredits || []).filter(
    (c) => c.status === 'AVAILABLE' || c.usedReservation?.status === 'CONFIRMED',
  );

  return (
    <>
      <Alert tone="info">
        團課為付費期班：可報名整期（開課後插班依剩餘堂數計價），或購買單堂。開課前 24 小時請假可取得 1
        次補課權，於同課程其他期班補課。
      </Alert>

      {loading ? (
        <Skeleton style={{ height: 120 }} />
      ) : (
        <>
          {waitlist.length > 0 && (
            <Card title="我的候補">
              <ul style={listStyle}>
                {waitlist.map((w) => {
                  const meta = WAITLIST_STATUS_META[w.status] || { label: w.status, tone: 'neutral' as const };
                  const offered = w.status === 'OFFERED';
                  const s = series.find((x) => x.id === w.seriesId);
                  return (
                    <li key={w.id} style={rowStyle}>
                      <div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <strong>{w.seriesTitle}</strong>
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                        </div>
                        <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
                          {offered
                            ? `請於 ${classWhen(w.offerExpiresAt)} 前完成報名付款，逾時由下一位遞補`
                            : `第 ${w.position ?? '—'} 順位 · 有名額時會通知您`}
                        </p>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {offered && s ? (
                          <Button size="sm" onClick={() => openTermEnroll(s)}>
                            立即報名
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyKey === `wl-${w.id}`}
                          onClick={() =>
                            void run(`wl-${w.id}`, () => cancelMemberGroupWaitlist(w.id), '取消候補失敗')
                          }
                        >
                          取消候補
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {credits.length > 0 && (
            <Card title="補課權" subtitle="限同課程其他期班、有空位之堂次">
              <ul style={listStyle}>
                {credits.map((c) => (
                  <li key={c.id} style={rowStyle}>
                    <div>
                      <strong>{c.sourceSeriesTitle || '團課'}</strong>
                      <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
                        {c.usedReservation
                          ? `已預約補課：${c.usedReservation.title} · ${classWhen(c.usedReservation.startAt)}`
                          : `有效至 ${dateKey(c.expiresAt)}`}
                      </p>
                    </div>
                    {c.usedReservation ? (
                      c.usedReservation.canLeave ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyKey === `leave-${c.usedReservation.id}`}
                          onClick={() =>
                            void run(
                              `leave-${c.usedReservation!.id}`,
                              () => requestMemberGroupLeave(c.usedReservation!.id),
                              '取消補課失敗',
                            )
                          }
                        >
                          取消補課
                        </Button>
                      ) : (
                        <Badge tone="success">已預約</Badge>
                      )
                    ) : (
                      <Button size="sm" onClick={() => void openMakeup(c)}>
                        選擇補課
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="我的團課報名">
            {enrollments.length === 0 ? (
              <EmptyState icon="🧘" title="尚未報名團課" desc="從下方期班列表報名" />
            ) : (
              <ul style={listStyle}>
                {enrollments.map((e) => {
                  const meta = ENROLL_STATUS_META[e.status] || { label: e.status, tone: 'neutral' as const };
                  const upcoming = e.reservations.filter((r) => new Date(r.startAt) > new Date());
                  return (
                    <li key={e.id} style={{ ...rowStyle, flexDirection: 'column' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <strong>{e.series.title}</strong>
                        <Badge tone="neutral">{ENROLL_KIND_LABEL[e.kind] || e.kind}</Badge>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </div>
                      <p className="text-sm text-muted" style={{ margin: 0 }}>
                        {e.series.branchName || ''} · {e.series.trainerName || ''} · {e.sessionsTotal} 堂 ·{' '}
                        {formatMoney(e.price)}
                        {e.status === 'PENDING' && e.holdExpiresAt
                          ? ` · 名額保留至 ${classWhen(e.holdExpiresAt)}，逾時自動釋出`
                          : ''}
                        {e.status === 'REFUNDED' ? ` · 已退 ${formatMoney(e.refundAmount)}` : ''}
                      </p>
                      {e.status === 'ACTIVE' && upcoming.length > 0 && (
                        <ul style={{ ...listStyle, width: '100%' }}>
                          {upcoming.map((r) => (
                            <li
                              key={r.id}
                              style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0' }}
                            >
                              <span className="text-sm">
                                {classWhen(r.startAt)} · {RESERVATION_STATUS_LABEL[r.status] || r.status}
                              </span>
                              {r.canLeave ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  loading={busyKey === `leave-${r.id}`}
                                  onClick={() =>
                                    void run(`leave-${r.id}`, () => requestMemberGroupLeave(r.id), '請假失敗')
                                  }
                                >
                                  請假
                                </Button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="開放報名期班">
            {series.length === 0 ? (
              <EmptyState icon="📋" title="目前沒有開放報名的期班" />
            ) : (
              <ul style={listStyle}>
                {series.map((s) => {
                  const enrolled = Boolean(s.myEnrollment);
                  const offered = s.myWaitlist?.status === 'OFFERED';
                  const waiting = s.myWaitlist?.status === 'WAITING';
                  const canTerm = !enrolled && s.sellable && s.termQuote && (s.seatsLeft > 0 || offered);
                  const canWait = !enrolled && s.sellable && s.seatsLeft <= 0 && !s.myWaitlist;
                  return (
                    <li key={s.id} style={{ ...rowStyle, flexDirection: 'column' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <strong>{s.title}</strong>
                        {enrolled ? <Badge tone="success">已報名</Badge> : null}
                        {waiting ? <Badge tone="info">候補中</Badge> : null}
                        {offered ? <Badge tone="warning">已遞補</Badge> : null}
                        {s.seatsLeft <= 0 && !enrolled ? <Badge tone="warning">額滿</Badge> : null}
                        {!s.sellable ? <Badge tone="neutral">已截止</Badge> : null}
                      </div>
                      <p className="text-sm text-muted" style={{ margin: 0 }}>
                        {seriesScheduleLabel(s)}
                      </p>
                      <p className="text-sm text-muted" style={{ margin: 0 }}>
                        {[s.branchName, s.venueName, s.trainerName].filter(Boolean).join(' · ')} · 剩{' '}
                        {s.seatsLeft}/{s.capacity} 位
                        {s.waitingCount > 0 ? ` · 候補 ${s.waitingCount} 人` : ''}
                        {s.enrollDeadline ? ` · 報名截止 ${dateKey(s.enrollDeadline)}` : ''}
                      </p>
                      <p className="text-sm" style={{ margin: 0 }}>
                        {s.termQuote ? (
                          <>
                            整期 {formatMoney(s.termQuote.price)}（{s.termQuote.sessions} 堂
                            {s.termQuote.prorated ? `，插班按剩餘 ${s.remainingSessions}/${s.sessionCount} 堂計` : ''}
                            ）
                          </>
                        ) : null}
                        {s.dropInPrice ? ` · 單堂 ${formatMoney(s.dropInPrice)}` : ''}
                      </p>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {canTerm ? (
                          <Button size="sm" onClick={() => openTermEnroll(s)}>
                            {s.termQuote?.prorated ? '插班報名' : '報名整期'}
                          </Button>
                        ) : null}
                        {canWait ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busyKey === `join-${s.id}`}
                            onClick={() =>
                              void run(`join-${s.id}`, () => joinMemberGroupWaitlist(s.id), '登記候補失敗')
                            }
                          >
                            登記候補
                          </Button>
                        ) : null}
                        {s.dropInPrice && s.sellable ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busyKey === `detail-${s.id}`}
                            onClick={() => void openDetail(s.id)}
                          >
                            單堂／堂次
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}

      <Modal open={Boolean(detail)} title={detail?.title || '期班堂次'} onClose={() => setDetail(null)}>
        {detail ? (
          <>
            <p className="text-sm text-muted">
              {seriesScheduleLabel(detail)} · 單堂 {formatMoney(detail.dropInPrice)}（開課 24 小時前可全額退費）
            </p>
            <ul style={listStyle}>
              {detail.classes
                .filter((c) => c.upcoming)
                .map((c) => (
                  <li key={c.id} style={rowStyle}>
                    <span className="text-sm">
                      {classWhen(c.startAt)} · 單堂空位 {c.dropInSeats}
                    </span>
                    {c.mine ? (
                      <Badge tone="success">已預約</Badge>
                    ) : (
                      <Button
                        size="sm"
                        disabled={c.dropInSeats < 1}
                        onClick={() => {
                          openDropInEnroll(detail, c.id, c.startAt);
                          setDetail(null);
                        }}
                      >
                        {c.dropInSeats < 1 ? '已滿' : '購買單堂'}
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          </>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(enrollTarget)}
        title={enrollTarget?.kind === 'DROP_IN' ? '購買單堂' : '報名期班'}
        onClose={() => {
          if (!enrolling) setEnrollTarget(null);
        }}
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" disabled={enrolling} onClick={() => setEnrollTarget(null)}>
              取消
            </Button>
            <Button loading={enrolling} onClick={() => void confirmEnroll()}>
              {payMethod === 'LINEPAY' ? 'LINE Pay 付款' : '刷卡付款'}
            </Button>
          </>
        }
      >
        {enrollTarget ? (
          <div className="form-stack">
            <p style={{ margin: 0 }}>
              <strong>{enrollTarget.series.title}</strong>
            </p>
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              {enrollTarget.kind === 'DROP_IN'
                ? `單堂：${classWhen(enrollTarget.classStartAt)}`
                : `${enrollTarget.sessions} 堂${enrollTarget.prorated ? '（插班，依剩餘堂數計價）' : ''}`}
            </p>
            <p style={{ margin: 0, fontSize: '1.25rem' }}>
              應付 <strong>{formatMoney(enrollTarget.price)}</strong>
            </p>
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              實際金額以付款頁為準。送出後保留名額 30 分鐘，逾時未付款自動釋出。
            </p>
            <div className="pay-method-grid" role="group" aria-label="付款方式">
              <button
                type="button"
                className={`pay-method-chip${payMethod === 'LINEPAY' ? ' is-active' : ''}`}
                aria-pressed={payMethod === 'LINEPAY'}
                onClick={() => setPayMethod('LINEPAY')}
              >
                LINE Pay
              </button>
              <button
                type="button"
                className={`pay-method-chip${payMethod === 'CARD' ? ' is-active' : ''}`}
                aria-pressed={payMethod === 'CARD'}
                onClick={() => setPayMethod('CARD')}
              >
                信用卡
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={Boolean(makeupCredit)} title="選擇補課堂次" onClose={() => setMakeupCredit(null)}>
        {makeupOptions === null ? (
          <Skeleton style={{ height: 80 }} />
        ) : makeupOptions.length === 0 ? (
          <EmptyState icon="🗓️" title="目前沒有可補課的堂次" desc="同課程其他期班有空位時再來看看" />
        ) : (
          <ul style={listStyle}>
            {makeupOptions.map((o) => (
              <li key={o.classId} style={rowStyle}>
                <div>
                  <strong>{o.seriesTitle}</strong>
                  <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
                    {classWhen(o.startAt)} · {[o.branchName, o.trainerName].filter(Boolean).join(' · ')} · 空位{' '}
                    {o.seats}
                  </p>
                </div>
                <Button
                  size="sm"
                  loading={busyKey === `makeup-${o.classId}`}
                  onClick={() => void bookMakeup(o)}
                >
                  預約補課
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
