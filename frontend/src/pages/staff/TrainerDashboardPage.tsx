import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, EmptyState, Field, PageSection, Select } from '../../components/ui';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { useToast } from '../../contexts/ToastContext';
import { staffBranchLabel } from '../../lib/branchLabel';
import { fetchTrainerDashboard, getErrorMessage } from '../../lib/api';
import type {
  TrainerDashboardClass,
  TrainerDashboardData,
  TrainerInboxItem,
} from '../../types/api';
import TrainerBookPanel from '../../components/staff/trainer/TrainerBookPanel';
import TrainerCheckInPanel from '../../components/staff/trainer/TrainerCheckInPanel';
import TrainerHistoryPanel from '../../components/staff/trainer/TrainerHistoryPanel';
import TrainerInboxList from '../../components/staff/trainer/TrainerInboxList';
import TrainerScheduleList from '../../components/staff/trainer/TrainerScheduleList';
import TrainerStudentsPanel from '../../components/staff/trainer/TrainerStudentsPanel';
import TrainerTimeOffPanel from '../../components/staff/trainer/TrainerTimeOffPanel';
import TrainerWeekCalendar from '../../components/staff/trainer/TrainerWeekCalendar';
import { isTodayClass } from '../../components/staff/trainer/trainerFormat';

type TabKey = 'home' | 'schedule' | 'book' | 'students' | 'history' | 'inbox' | 'timeoff';

const TABS: {
  key: TabKey;
  label: string;
  short: string;
  icon: string;
  badgeKey?: 'inbox' | 'unpaid' | 'today' | 'timeoff';
}[] = [
  { key: 'home', label: '工作台', short: '首頁', icon: '🏠' },
  { key: 'schedule', label: '課表', short: '課表', icon: '📅', badgeKey: 'today' },
  { key: 'book', label: '代約', short: '代約', icon: '✍️' },
  { key: 'students', label: '學員', short: '學員', icon: '👥' },
  { key: 'timeoff', label: '排休', short: '排休', icon: '🌴', badgeKey: 'timeoff' },
  { key: 'history', label: '課程紀錄', short: '紀錄', icon: '📋' },
  { key: 'inbox', label: '訊息', short: '訊息', icon: '🔔', badgeKey: 'inbox' },
];

function buildBranchOptions(data: TrainerDashboardData) {
  const map = new Map<number, string>();
  for (const link of data.profile?.branches || []) {
    map.set(link.branch.id, staffBranchLabel(link.branch));
  }
  for (const v of data.venues || []) {
    if (v.branchId && v.branch) map.set(v.branchId, staffBranchLabel(v.branch));
  }
  for (const c of data.upcomingClasses || []) {
    if (c.branchId && c.branchName) map.set(c.branchId, c.branchName);
  }
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
}

export default function TrainerDashboardPage() {
  const { toast } = useToast();
  const { staff, isAdmin } = useStaffAuth();

  const [data, setData] = useState<TrainerDashboardData | null>(null);
  const [viewAsDraft, setViewAsDraft] = useState<number | ''>('');
  const viewAsTrainerId =
    !isAdmin && staff?.trainerId ? staff.trainerId : viewAsDraft;
  const setViewAsTrainerId = setViewAsDraft;
  const [branchId, setBranchId] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>('home');
  const [selectedClass, setSelectedClass] = useState<TrainerDashboardClass | null>(null);
  const [focusMemberId, setFocusMemberId] = useState<number | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchTrainerDashboard(
        viewAsTrainerId === '' ? undefined : Number(viewAsTrainerId),
      );
      if (res.status === 'success' && res.data) {
        setData(res.data);
        const branchOptions = buildBranchOptions(res.data);
        setBranchId((prev) => {
          if (prev !== '' && branchOptions.some((b) => b.id === prev)) return prev;
          const staffBranch = staff?.branchId;
          if (staffBranch && branchOptions.some((b) => b.id === staffBranch)) {
            return staffBranch;
          }
          return branchOptions[0]?.id ?? '';
        });
      }
    } catch (err) {
      toast(getErrorMessage(err, '載入教練工作區失敗'), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast, viewAsTrainerId, staff?.branchId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchTrainerDashboard(
          viewAsTrainerId === '' ? undefined : Number(viewAsTrainerId),
        );
        if (cancelled) return;
        if (res.status === 'success' && res.data) {
          setData(res.data);
          const branchOptions = buildBranchOptions(res.data);
          setBranchId((prev) => {
            if (prev !== '' && branchOptions.some((b) => b.id === prev)) return prev;
            const staffBranch = staff?.branchId;
            if (staffBranch && branchOptions.some((b) => b.id === staffBranch)) {
              return staffBranch;
            }
            return branchOptions[0]?.id ?? '';
          });
        }
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入教練工作區失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, viewAsTrainerId, staff?.branchId]);

  const switchTab = useCallback((next: TabKey) => {
    setTab(next);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  const branchOptions = useMemo(() => (data ? buildBranchOptions(data) : []), [data]);
  const profile = data?.profile;
  const upcoming = useMemo(() => {
    const upcomingAll = data?.upcomingClasses || [];
    return branchId === ''
      ? upcomingAll
      : upcomingAll.filter((c) => c.branchId === branchId);
  }, [data?.upcomingClasses, branchId]);
  const todayClasses = useMemo(() => upcoming.filter((c) => isTodayClass(c)), [upcoming]);
  const recentClasses = data?.recentClasses || [];
  const ptContracts = data?.ptContracts || [];
  const inbox: TrainerInboxItem[] = useMemo(() => data?.inbox || [], [data?.inbox]);
  const timeOffs = data?.timeOffs || [];
  const timeOffReasons = data?.timeOffReasons || ['休假', '外出', '私人', '其他'];

  const stats = useMemo(
    () => ({
      todayClasses: todayClasses.length,
      upcomingClasses: upcoming.length,
      openSeats: upcoming.reduce((sum, c) => sum + c.remaining, 0),
      activePtContracts: data?.stats?.activePtContracts ?? ptContracts.length,
      remainingPtSessions: data?.stats?.remainingPtSessions ?? 0,
      inboxCount: data?.stats?.inboxCount ?? inbox.length,
      unpaidCount: data?.stats?.unpaidCount ?? inbox.filter((i) => i.type === 'UNPAID').length,
      upcomingTimeOffs: data?.stats?.upcomingTimeOffs ?? timeOffs.length,
    }),
    [todayClasses, upcoming, data?.stats, ptContracts.length, inbox, timeOffs.length],
  );

  const branchLabel =
    branchId === ''
      ? '全部分店'
      : branchOptions.find((b) => b.id === branchId)?.name || '分店';

  const openBookForMember = (memberId: number) => {
    setFocusMemberId(memberId);
    switchTab('book');
  };

  const openStudent = (memberId: number) => {
    setFocusMemberId(memberId);
    switchTab('students');
  };

  const renderTabButton = (t: (typeof TABS)[number], mode: 'desktop' | 'dock') => {
    let badge: number | null = null;
    if (t.badgeKey === 'inbox') badge = stats.inboxCount || null;
    if (t.badgeKey === 'today') badge = stats.todayClasses || null;
    if (t.badgeKey === 'timeoff') badge = stats.upcomingTimeOffs || null;
    const active = tab === t.key;
    if (mode === 'dock') {
      return (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active}
          className={`coach-dock__btn ${active ? 'is-active' : ''}`}
          onClick={() => switchTab(t.key)}
        >
          <span className="coach-dock__icon" aria-hidden>
            {t.icon}
          </span>
          <span className="coach-dock__label">{t.short}</span>
          {badge ? <span className="coach-dock__badge">{badge > 9 ? '9+' : badge}</span> : null}
        </button>
      );
    }
    return (
      <button
        key={t.key}
        type="button"
        role="tab"
        aria-selected={active}
        className={`hq-tabs__btn ${active ? 'is-active' : ''}`}
        onClick={() => switchTab(t.key)}
      >
        {t.label}
        {badge ? <span className="coach-tab-badge">{badge}</span> : null}
      </button>
    );
  };

  if (loading && !data) {
    return (
      <PageSection title="教練服務台" desc="載入中…">
        <EmptyState icon="⏳" title="正在載入個人工作區" />
      </PageSection>
    );
  }

  if (data && !data.isAdmin && !data.profile) {
    return (
      <PageSection title="教練服務台" desc="個人專屬 · 資料不與其他教練共享">
        <Alert tone="warning">
          此帳號尚未綁定教練檔案。請總部於「員工管理 → 編輯教練」連結員工帳號後重新登入。
        </Alert>
      </PageSection>
    );
  }

  return (
    <div className="coach-desk coach-desk--phone">
      <header className="coach-desk__hero">
        <div className="coach-desk__identity">
          <div className="coach-desk__avatar">
            {(profile?.name || staff?.name || '?').charAt(0)}
          </div>
          <div className="coach-desk__identity-text">
            <p className="coach-desk__eyebrow">
              {data?.isAdmin ? '總部代管' : '教練服務台'}
            </p>
            <h2 className="coach-desk__name">
              {profile ? profile.displayName || profile.name : '請選擇教練'}
            </h2>
            <p className="coach-desk__meta coach-desk__meta--desktop">
              {profile
                ? `${profile.role === 'MANAGER' ? '主管教練' : '一般教練'}${
                    profile.branches?.length
                      ? ` · ${(profile.branches || []).map((b) => staffBranchLabel(b.branch)).join('、')}`
                      : ''
                  }`
                : '總部可檢視教練課表並代約'}
            </p>
            <p className="coach-desk__meta coach-desk__meta--mobile">
              {branchLabel}
              {stats.unpaidCount ? ` · 未付 ${stats.unpaidCount}` : ''}
            </p>
          </div>
        </div>

        <div className="coach-desk__hero-actions">
          <Button
            variant="secondary"
            size="sm"
            className="coach-desk__filter-toggle"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            {filtersOpen ? '收起篩選' : '分店／篩選'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setLoading(true);
              void load();
            }}
            disabled={loading}
          >
            重新整理
          </Button>
        </div>

        <div className={`coach-desk__filters ${filtersOpen ? 'is-open' : ''}`}>
          <Field label="分店" hint="篩選課表">
            <Select
              value={branchId === '' ? '' : String(branchId)}
              onChange={(e) => {
                setBranchId(e.target.value ? Number(e.target.value) : '');
                setSelectedClass(null);
              }}
              disabled={branchOptions.length === 0}
            >
              {branchOptions.length === 0 ? (
                <option value="">尚無可選分店</option>
              ) : (
                branchOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))
              )}
            </Select>
          </Field>
          {data?.canSwitch ? (
            <Field label="檢視教練" hint="僅總部可切換">
              <Select
                value={viewAsTrainerId === '' ? '' : String(viewAsTrainerId)}
                onChange={(e) =>
                  setViewAsTrainerId(e.target.value ? Number(e.target.value) : '')
                }
              >
                <option value="">— 選擇教練 —</option>
                {(data.trainers || []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.staffId ? '' : '（未綁帳號）'}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      </header>

      {data?.needsTrainerPick ? (
        <Alert tone="info">請先於上方選擇教練，即可檢視其服務台。</Alert>
      ) : (
        <>
          <div className="coach-desk__stats">
            <button type="button" className="coach-stat" onClick={() => switchTab('schedule')}>
              <span>今日</span>
              <strong>{stats.todayClasses}</strong>
            </button>
            <button type="button" className="coach-stat" onClick={() => switchTab('schedule')}>
              <span>14 天</span>
              <strong>{stats.upcomingClasses}</strong>
            </button>
            <button type="button" className="coach-stat" onClick={() => switchTab('students')}>
              <span>剩餘堂</span>
              <strong>
                {stats.remainingPtSessions}
                <small>／{stats.activePtContracts}人</small>
              </strong>
            </button>
            <button
              type="button"
              className={`coach-stat ${stats.unpaidCount || stats.inboxCount ? 'is-alert' : ''}`}
              onClick={() => switchTab('inbox')}
            >
              <span>訊息</span>
              <strong>
                {stats.inboxCount}
                {stats.unpaidCount ? <small> 未付{stats.unpaidCount}</small> : null}
              </strong>
            </button>
          </div>

          <div className="hq-tabs coach-desk__tabs coach-desk__tabs--desktop" role="tablist">
            {TABS.map((t) => renderTabButton(t, 'desktop'))}
          </div>

          <div className="hq-tab-panel coach-desk__panel">
            {tab === 'home' && (
              <div className="coach-desk__grid">
                <PageSection
                  title="今日行程"
                  desc={
                    branchId
                      ? `${branchLabel} · 全部課型 · 點私教／諮詢可代約`
                      : '全部課型 · 點私教／諮詢可代約'
                  }
                >
                  <TrainerScheduleList
                    classes={todayClasses}
                    selectedId={selectedClass?.id}
                    onSelect={(c) => {
                      setSelectedClass(c);
                      if (c.type === 'PRIVATE' || c.type === 'CONSULT') {
                        switchTab('book');
                      }
                    }}
                    emptyTitle="今天沒有課程"
                    emptyDesc="可到「課表」查看未來 14 天全部課程"
                  />
                  <div className="coach-desk__cta-row">
                    <Button variant="secondary" onClick={() => switchTab('schedule')}>
                      完整課表
                    </Button>
                    <Button onClick={() => switchTab('book')}>立即代約</Button>
                  </div>
                </PageSection>

                <PageSection title="需關注" desc="未付款／堂數／到期 · 收款請導引櫃檯">
                  <TrainerInboxList
                    items={inbox}
                    limit={4}
                    onOpenStudent={openStudent}
                    onViewAll={() => switchTab('inbox')}
                  />
                </PageSection>
              </div>
            )}

            {tab === 'schedule' && (
              <PageSection
                title="我的課表"
                desc="週曆拖拉改時（私教／諮詢）· 衝突格變紅 · 下方為未來 14 天列表"
              >
                <TrainerWeekCalendar
                  classes={upcoming}
                  viewAsTrainerId={
                    viewAsTrainerId === '' ? undefined : Number(viewAsTrainerId)
                  }
                  onChanged={load}
                  onSelect={(c) => {
                    setSelectedClass(c);
                    if (c.type === 'PRIVATE' || c.type === 'CONSULT') {
                      switchTab('book');
                    }
                  }}
                />
                <div className="mt-lg">
                  <TrainerScheduleList
                    classes={upcoming}
                    selectedId={selectedClass?.id}
                    onSelect={(c) => {
                      setSelectedClass(c);
                      if (c.type === 'PRIVATE' || c.type === 'CONSULT') {
                        switchTab('book');
                      }
                    }}
                    emptyTitle="近期沒有課程"
                    emptyDesc="尚無未來排程（含團課、私教、諮詢）。團課請至「總部 HQ／團課管理」排程。"
                  />
                </div>
                <div className="mt-lg">
                  <TrainerCheckInPanel
                    classItem={selectedClass}
                    viewAsTrainerId={
                      viewAsTrainerId === '' ? undefined : Number(viewAsTrainerId)
                    }
                  />
                </div>
              </PageSection>
            )}

            {tab === 'book' && (
              <PageSection
                title="代約服務"
                desc="私教：自動帶入購買合約並自選日期／時間 · 諮詢：姓名＋電話即可 · LINE 通知"
              >
                <TrainerBookPanel
                  venues={data?.venues || []}
                  ptContracts={ptContracts}
                  selectedClass={
                    selectedClass &&
                    (selectedClass.type === 'PRIVATE' || selectedClass.type === 'CONSULT')
                      ? selectedClass
                      : null
                  }
                  onSelectClass={setSelectedClass}
                  onBooked={load}
                  initialMemberId={focusMemberId}
                  viewAsTrainerId={
                    viewAsTrainerId === '' ? undefined : Number(viewAsTrainerId)
                  }
                />
              </PageSection>
            )}

            {tab === 'students' && (
              <PageSection title="我的學員" desc="購課／收款走櫃檯">
                <TrainerStudentsPanel
                  contracts={ptContracts}
                  focusMemberId={focusMemberId}
                  onBookForMember={openBookForMember}
                />
              </PageSection>
            )}

            {tab === 'timeoff' && (
              <PageSection title="排休" desc="登錄後排課會封鎖；會員可查詢避開">
                <TrainerTimeOffPanel
                  items={timeOffs}
                  reasons={timeOffReasons}
                  viewAsTrainerId={viewAsTrainerId}
                  onChanged={load}
                />
              </PageSection>
            )}

            {tab === 'history' && (
              <PageSection title="課程紀錄" desc="已結束課程與學員名單">
                <TrainerHistoryPanel classes={recentClasses} />
              </PageSection>
            )}

            {tab === 'inbox' && (
              <PageSection title="服務訊息" desc="未付款、堂數、到期、警示、未綁 LINE">
                <TrainerInboxList items={inbox} onOpenStudent={openStudent} />
              </PageSection>
            )}
          </div>

          <nav className="coach-dock" role="tablist" aria-label="教練服務台手機選單">
            {TABS.map((t) => renderTabButton(t, 'dock'))}
          </nav>
        </>
      )}
    </div>
  );
}
