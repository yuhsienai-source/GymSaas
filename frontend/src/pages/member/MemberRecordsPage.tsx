import { useEffect, useMemo, useState } from 'react';
import MemberLayout from '../../components/layout/MemberLayout';
import { Badge, Card, EmptyState, Skeleton } from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  fetchMemberClassRecords,
  fetchMemberOrdersHistory,
  fetchMemberProfile,
  fetchMemberSelfTrainingPlans,
  fetchMemberTrainingRecords,
  getErrorMessage,
} from '../../lib/api';
import type { MemberOrderHistoryItem, MemberProfile } from '../../types/api';

type Tab = 'orders' | 'classes' | 'gate' | 'training';

const TABS: { key: Tab; label: string }[] = [
  { key: 'orders', label: '消費' },
  { key: 'classes', label: '銷課' },
  { key: 'gate', label: '進出場' },
  { key: 'training', label: '訓練' },
];

function fmt(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW');
  } catch {
    return String(iso);
  }
}

export default function MemberRecordsPage() {
  const { logout } = useMemberAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [tab, setTab] = useState<Tab>('orders');
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<MemberOrderHistoryItem[]>([]);
  const [classRecords, setClassRecords] = useState<Awaited<
    ReturnType<typeof fetchMemberClassRecords>
  >['data']>(undefined);
  const [selfPlans, setSelfPlans] = useState<
    { id: number; title: string; trainer?: { name: string } }[]
  >([]);
  const [trainingRecords, setTrainingRecords] = useState<
    { id: number; title: string; sharedAt?: string; trainer?: { name: string } }[]
  >([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [profileRes, histRes, classRes, plansRes, trainRes] = await Promise.all([
          fetchMemberProfile(),
          fetchMemberOrdersHistory(80),
          fetchMemberClassRecords(),
          fetchMemberSelfTrainingPlans(),
          fetchMemberTrainingRecords(),
        ]);
        if (cancelled) return;
        setProfile((profileRes.data as MemberProfile) || null);
        if (histRes.status === 'success' && histRes.data) setHistory(histRes.data);
        if (classRes.status === 'success') setClassRecords(classRes.data);
        if (plansRes.status === 'success' && plansRes.data) setSelfPlans(plansRes.data);
        if (trainRes.status === 'success' && trainRes.data) setTrainingRecords(trainRes.data);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入紀錄失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  const orders = useMemo(() => history.filter((h) => h.kind === 'ORDER'), [history]);
  const checkins = useMemo(() => history.filter((h) => h.kind === 'CHECKIN'), [history]);

  return (
    <MemberLayout
      name={profile?.name}
      plan={profile?.plan}
      onRefresh={() => setReloadKey((k) => k + 1)}
      onLogout={logout}
      activeTab="records"
    >
      <nav className="hq-tabs" role="tablist" aria-label="紀錄">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`hq-tabs__btn ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="hq-tab-panel" style={{ marginTop: '0.75rem' }}>
        {loading ? (
          <Skeleton style={{ height: 120 }} />
        ) : tab === 'orders' ? (
          orders.length === 0 ? (
            <EmptyState icon="🧾" title="尚無消費紀錄" />
          ) : (
            <ul className="member-list">
              {orders.map((o) => (
                <li key={`o-${o.id}`}>
                  <Card
                    title={o.itemDesc || '消費'}
                    subtitle={fmt(o.at)}
                  >
                    <p>
                      ${o.amount ?? 0} · {o.payMethod || o.status || '—'}
                    </p>
                  </Card>
                </li>
              ))}
            </ul>
          )
        ) : tab === 'gate' ? (
          checkins.length === 0 ? (
            <EmptyState icon="🚪" title="尚無進出場紀錄" />
          ) : (
            <ul className="member-list">
              {checkins.map((c) => (
                <li key={`c-${c.id}`}>
                  <Card title="進場" subtitle={fmt(c.checkInAt || c.at)}>
                    <p>
                      {c.checkOutAt ? `出場 ${fmt(c.checkOutAt)}` : '尚未出場'}
                      {c.fee != null ? ` · 扣款 $${c.fee}` : ''}
                    </p>
                  </Card>
                </li>
              ))}
            </ul>
          )
        ) : tab === 'classes' ? (
          !classRecords?.reservations?.length && !classRecords?.attendances?.length ? (
            <EmptyState icon="📋" title="尚無課程紀錄" />
          ) : (
            <>
              {(classRecords?.attendances || []).length > 0 && (
                <Card title="已簽到" subtitle="銷課紀錄">
                  <ul className="member-list">
                    {(classRecords?.attendances || []).map((a) => (
                      <li key={a.id}>
                        <strong>{a.class?.title || '課程'}</strong>
                        <span className="text-muted text-sm" style={{ display: 'block' }}>
                          {fmt(a.checkedInAt)} · {a.class?.type || '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {(classRecords?.reservations || []).length > 0 && (
                <Card title="預約" subtitle="含請假狀態" className="mt-md">
                  <ul className="member-list">
                    {(classRecords?.reservations || []).map((r) => (
                      <li key={r.id}>
                        <strong>{r.class?.title || '課程'}</strong>
                        <Badge tone={r.status === 'CANCELLED' ? 'neutral' : 'info'}>
                          {r.status || '—'}
                        </Badge>
                        <span className="text-muted text-sm" style={{ display: 'block' }}>
                          {fmt(r.class?.startAt)} · {r.class?.trainerName || '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          )
        ) : selfPlans.length === 0 && trainingRecords.length === 0 ? (
          <EmptyState icon="🏋️" title="尚無訓練紀錄" desc="教練分享或自主課表會顯示於此" />
        ) : (
          <>
            {selfPlans.length > 0 && (
              <Card title="自主訓練課表">
                <ul className="member-list">
                  {selfPlans.map((p) => (
                    <li key={p.id}>
                      <strong>{p.title}</strong>
                      {p.trainer?.name ? (
                        <span className="text-muted text-sm"> · {p.trainer.name}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {trainingRecords.length > 0 && (
              <Card title="教練分享紀錄" className="mt-md">
                <ul className="member-list">
                  {trainingRecords.map((r) => (
                    <li key={r.id}>
                      <strong>{r.title}</strong>
                      <span className="text-muted text-sm" style={{ display: 'block' }}>
                        {fmt(r.sharedAt)} · {r.trainer?.name || '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
    </MemberLayout>
  );
}
