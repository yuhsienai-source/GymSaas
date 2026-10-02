import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import MemberLayout from '../../components/layout/MemberLayout';
import MemberGroupClassPanel from '../../components/member/MemberGroupClassPanel';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton,
} from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  bookMemberClass,
  cancelMemberReservation,
  fetchMemberClasses,
  fetchMemberProfile,
  fetchMemberReservations,
  getErrorMessage,
} from '../../lib/api';
import type {
  MemberBookableClass,
  MemberProfile,
  MemberReservation,
} from '../../types/api';

function typeLabel(type?: string) {
  switch (type) {
    case 'GROUP':
      return '團課';
    case 'PRIVATE':
      return '私教';
    case 'CONSULT':
      return '諮詢';
    default:
      return type || '課程';
  }
}

function formatWhen(iso?: string) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW', {
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return String(iso);
  }
}

export default function MemberBookingPage() {
  const { logout } = useMemberAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'group' ? 'group' : 'pt';
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [classes, setClasses] = useState<MemberBookableClass[]>([]);
  const [reservations, setReservations] = useState<MemberReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [profileRes, classRes, resRes] = await Promise.all([
          fetchMemberProfile(),
          fetchMemberClasses(21),
          fetchMemberReservations(),
        ]);
        if (cancelled) return;
        setProfile((profileRes.data as MemberProfile) || null);
        setClasses((classRes.data as MemberBookableClass[]) || []);
        setReservations((resRes.data as MemberReservation[]) || []);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入約課資料失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, reloadKey]);

  async function handleBook(c: MemberBookableClass) {
    if (!c.canBook) return;
    setBusyId(c.id);
    try {
      const result = await bookMemberClass(c.id);
      toast(result.message || '預約成功', 'success');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '預約失敗'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(r: MemberReservation) {
    if (!r.canCancel) return;
    setBusyId(r.id);
    try {
      const result = await cancelMemberReservation(r.id);
      toast(result.message || '已取消', 'info');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '取消失敗'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  const plan = profile?.plan || '';
  const headerPlan = [profile?.branchLabel, plan, profile?.memberNo]
    .filter(Boolean)
    .join(' · ');

  return (
    <MemberLayout
      name={profile?.name || (loading ? '載入中…' : '會員')}
      plan={headerPlan || plan || undefined}
      onRefresh={() => {
        setLoading(true);
        setReloadKey((k) => k + 1);
        toast('已重新整理', 'info');
      }}
      onLogout={logout}
      activeTab="book"
    >
      <div className="pay-method-grid" role="tablist" aria-label="課程類型">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pt'}
          className={`pay-method-chip${tab === 'pt' ? ' is-active' : ''}`}
          onClick={() => setSearchParams({}, { replace: true })}
        >
          私教／諮詢
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'group'}
          className={`pay-method-chip${tab === 'group' ? ' is-active' : ''}`}
          onClick={() => setSearchParams({ tab: 'group' }, { replace: true })}
        >
          團課期班
        </button>
      </div>

      {tab === 'group' ? (
        <MemberGroupClassPanel key={reloadKey} />
      ) : (
      <>
      {!profile?.hasLineBound ? (
        <Alert tone="info">
          建議綁定 LINE 以便收到約課推播。您目前仍可在此頁預約課程。
        </Alert>
      ) : null}

      <Card title="我的預約" subtitle="即將到來 · 私教／諮詢可取消未開始的課程；團課請至「團課期班」請假">
        {loading ? (
          <Skeleton style={{ height: 80 }} />
        ) : reservations.length === 0 ? (
          <EmptyState icon="📅" title="尚無預約" desc="從下方課程列表預約即可" />
        ) : (
          <ul className="form-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {reservations.map((r) => (
              <li
                key={r.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  alignItems: 'flex-start',
                  padding: '0.75rem 0',
                  borderBottom: '1px solid var(--border, #e5e5e5)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{r.class?.title || '課程'}</strong>
                    <Badge tone="neutral">{typeLabel(r.class?.type)}</Badge>
                  </div>
                  <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
                    {formatWhen(r.class?.startAt)}
                    {r.class?.trainerName ? ` · ${r.class.trainerName}` : ''}
                    {r.class?.branchName ? ` · ${r.class.branchName}` : ''}
                  </p>
                </div>
                {r.canCancel ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busyId === r.id}
                    onClick={() => void handleCancel(r)}
                  >
                    取消
                  </Button>
                ) : (
                  <Badge tone="neutral">{r.status}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="可預約課程" subtitle="私教／諮詢需為該教練合約學員">
        {loading ? (
          <Skeleton style={{ height: 120 }} />
        ) : classes.length === 0 ? (
          <EmptyState icon="🏋️" title="近期無可預約課程" desc="請稍後再查看或洽教練代約" />
        ) : (
          <ul className="form-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {classes.map((c) => {
              const mine = Boolean(c.myReservationId);
              const full = c.remaining <= 0;
              return (
                <li
                  key={c.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    alignItems: 'flex-start',
                    padding: '0.85rem 0',
                    borderBottom: '1px solid var(--border, #e5e5e5)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong>{c.title}</strong>
                      <Badge tone={c.type === 'GROUP' ? 'success' : 'neutral'}>
                        {typeLabel(c.type)}
                      </Badge>
                      {mine ? <Badge tone="success">已預約</Badge> : null}
                      {full && !mine ? <Badge tone="warning">已滿</Badge> : null}
                    </div>
                    <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
                      {formatWhen(c.startAt)}
                      {c.trainerName ? ` · ${c.trainerName}` : ''}
                    </p>
                    <p className="text-sm text-muted" style={{ margin: '2px 0 0' }}>
                      {[c.branchName, c.venueName].filter(Boolean).join(' · ') || '—'}
                      {c.stationName ? `／${c.stationName}` : ''} · 剩 {c.remaining}/{c.capacity}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={!c.canBook || busyId === c.id}
                    loading={busyId === c.id}
                    onClick={() => void handleBook(c)}
                  >
                    {mine ? '已約' : full ? '已滿' : '預約'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      </>
      )}
    </MemberLayout>
  );
}
