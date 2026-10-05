import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import MemberLayout from '../../components/layout/MemberLayout';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Skeleton,
} from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { useToast } from '../../contexts/ToastContext';
import axios from 'axios';
import {
  fetchMemberGiftCards,
  fetchMemberPointsLedger,
  fetchMemberProfile,
  fetchMemberPromotions,
  fetchMemberSubscriptions,
  createMemberOrder,
  getErrorMessage,
  openPayuniCheckoutInNewTab,
  redeemMemberGiftCard,
  redirectToCheckOut,
  requestMemberCardBinding,
  fetchMemberCardBindingStatus,
  submitMemberSubscriptionCancel,
  submitMemberLeaveApplication,
  fetchMemberLeaveApplications,
  uploadMemberLeaveProof,
} from '../../lib/api';
import type {
  MemberGiftCards,
  MemberLeave,
  MemberLeaveCategory,
  MemberPointsLedgerEntry,
  MemberProfile,
  MemberSubscription,
  Promotion,
} from '../../types/api';
import { formatPromotionOptionLabel } from '../../lib/promotionLabels';
import { LEAVE_CATEGORY_OPTIONS, isDeferrableLeaveCategory, leaveStatusLabel } from '../../lib/memberLeave';

type Tab = 'shop' | 'leave' | 'subscription' | 'points' | 'gift';

const TABS: { key: Tab; label: string }[] = [
  { key: 'shop', label: '線上購案' },
  { key: 'leave', label: '暫停' },
  { key: 'subscription', label: '訂閱' },
  { key: 'points', label: '點數' },
  { key: 'gift', label: '禮物卡' },
];

const SCHEDULE_CONFLICT_MSG =
  '目前金流定期排程生效中，請洽櫃檯或客服協助處理';

function fmt(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW');
  } catch {
    return String(iso);
  }
}

function todayIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysIso(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
}

/** endAt 為迄日次日 00:00（不含） */
function leaveLastDay(endAt: string) {
  return fmtDate(new Date(new Date(endAt).getTime() - 1).toISOString());
}

function leaveStatusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'PENDING') return 'warning';
  if (status === 'APPROVED' || status === 'ACTIVE') return 'success';
  if (status === 'REJECTED') return 'danger';
  return 'neutral';
}

function inclusiveDays(start: string, end: string): number | null {
  if (!start || !end) return null;
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return null;
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

export default function MemberMembershipPage() {
  const { logout } = useMemberAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('shop');
  const [tabLoading, setTabLoading] = useState(false);
  /** 各分頁已對應的 reloadKey；不同則需重載 */
  const [tabLoadedAt, setTabLoadedAt] = useState<Partial<Record<Tab, number>>>({});
  const [subscriptions, setSubscriptions] = useState<MemberSubscription[]>([]);
  const [points, setPoints] = useState<MemberPointsLedgerEntry[]>([]);
  const [giftCards, setGiftCards] = useState<MemberGiftCards | null>(null);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [shopPayMethod, setShopPayMethod] = useState<'CARD' | 'LINEPAY'>('LINEPAY');
  const [shopBusyId, setShopBusyId] = useState<number | null>(null);
  const checkoutInFlightRef = useRef(false);
  const [pendingBuy, setPendingBuy] = useState<Promotion | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [leaveCategory, setLeaveCategory] = useState<MemberLeaveCategory | ''>('');
  const [leaveApps, setLeaveApps] = useState<MemberLeave[]>([]);
  const leaveInFlightRef = useRef(false);
  const [proofUploadingId, setProofUploadingId] = useState<number | null>(null);
  const [leaveStart, setLeaveStart] = useState(todayIsoDate);
  const [leaveEnd, setLeaveEnd] = useState(() => addDaysIso(todayIsoDate(), 6));
  const [leaveReason, setLeaveReason] = useState('');
  const [leaveProof, setLeaveProof] = useState<File | null>(null);
  const leaveProofRef = useRef<HTMLInputElement | null>(null);
  const [leaveSubId, setLeaveSubId] = useState('');
  const [cancelSubId, setCancelSubId] = useState('');
  const [cancelMode, setCancelMode] = useState<'KEEP' | 'CUT'>('KEEP');
  const [giftCode, setGiftCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [scheduleConflictOpen, setScheduleConflictOpen] = useState(false);
  const [pendingRebindId, setPendingRebindId] = useState<string | null>(null);
  const [rebindBusy, setRebindBusy] = useState(false);
  const leaveDaysPreview = inclusiveDays(leaveStart, leaveEnd);
  const leaveDeferrable = isDeferrableLeaveCategory(leaveCategory);
  const leaveCategoryHint = LEAVE_CATEGORY_OPTIONS.find((o) => o.value === leaveCategory)?.hint;
  const hasOpenLeave = leaveApps.some((l) => ['PENDING', 'APPROVED', 'ACTIVE'].includes(l.status));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setProfileLoading(true);
      try {
        const profileRes = await fetchMemberProfile();
        if (cancelled) return;
        setProfile((profileRes.data as MemberProfile) || null);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入會員資料失敗'), 'error');
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  useEffect(() => {
    if (tabLoadedAt[tab] === reloadKey) return;
    let cancelled = false;
    void (async () => {
      setTabLoading(true);
      try {
        if (tab === 'shop') {
          const promoRes = await fetchMemberPromotions();
          if (cancelled) return;
          if (promoRes.status === 'success' && promoRes.data) setPromotions(promoRes.data);
        } else if (tab === 'leave') {
          const [subRes, appsRes] = await Promise.all([fetchMemberSubscriptions(), fetchMemberLeaveApplications()]);
          if (cancelled) return;
          if (appsRes.status === 'success' && appsRes.data) setLeaveApps(appsRes.data);
          if (subRes.status === 'success' && subRes.data) {
            setSubscriptions(subRes.data);
            if (subRes.data[0]) {
              setLeaveSubId((prev) => prev || subRes.data![0].id);
              setCancelSubId((prev) => prev || subRes.data![0].id);
            }
          }
        } else if (tab === 'subscription') {
          const subRes = await fetchMemberSubscriptions();
          if (cancelled) return;
          if (subRes.status === 'success' && subRes.data) {
            setSubscriptions(subRes.data);
            if (subRes.data[0]) {
              setCancelSubId((prev) => prev || subRes.data![0].id);
            }
          }
        } else if (tab === 'points') {
          const ptsRes = await fetchMemberPointsLedger();
          if (cancelled) return;
          if (ptsRes.status === 'success' && ptsRes.data) setPoints(ptsRes.data);
        } else if (tab === 'gift') {
          const giftRes = await fetchMemberGiftCards();
          if (cancelled) return;
          if (giftRes.status === 'success' && giftRes.data) setGiftCards(giftRes.data);
        }
        if (!cancelled) {
          setTabLoadedAt((prev) => ({ ...prev, [tab]: reloadKey }));
        }
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入資料失敗'), 'error');
      } finally {
        if (!cancelled) setTabLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, reloadKey, tabLoadedAt, toast]);

  function openBuyConfirm(promo: Promotion) {
    if (shopBusyId != null || checkoutInFlightRef.current) return;
    setPendingBuy(promo);
  }

  async function confirmShopBuy() {
    if (!pendingBuy || shopBusyId != null || checkoutInFlightRef.current) return;
    const promo = pendingBuy;
    checkoutInFlightRef.current = true;
    setShopBusyId(promo.id);
    try {
      const res = await createMemberOrder({
        promotionId: promo.id,
        payMethod: shopPayMethod,
        ...(shopPayMethod === 'CARD' ? { cardMode: 'LUMP' as const } : {}),
      });
      if (res.status !== 'success') {
        toast(res.message || '建立訂單失敗', 'error');
        return;
      }
      setPendingBuy(null);
      if (shopPayMethod === 'LINEPAY' && res.data?.paymentUrl) {
        toast('導向 LinePay 線上付款…', 'info');
        window.location.assign(res.data.paymentUrl);
        return;
      }
      if (res.data?.actionUrl && res.data?.payload) {
        toast('導向刷卡頁…', 'info');
        redirectToCheckOut(res.data.actionUrl, res.data.payload);
        return;
      }
      toast(res.message || '訂單已建立', 'success');
    } catch (err) {
      toast(getErrorMessage(err, '購買失敗'), 'error');
    } finally {
      setShopBusyId(null);
      checkoutInFlightRef.current = false;
    }
  }

  async function onSubscriptionLeave(e: FormEvent) {
    e.preventDefault();
    if (leaveInFlightRef.current) return;
    if (!leaveCategory) {
      toast('請選擇暫停事由', 'error');
      return;
    }
    if (!leaveStart || !leaveEnd || leaveDaysPreview == null) {
      toast('暫停起迄日無效（結束日不可早於起始日）', 'error');
      return;
    }
    if (!leaveProof && !isDeferrableLeaveCategory(leaveCategory)) {
      toast('請上傳事由證明文件', 'error');
      return;
    }
    leaveInFlightRef.current = true;
    setBusy(true);
    try {
      const res = await submitMemberLeaveApplication({
        category: leaveCategory,
        startDate: leaveStart,
        endDate: leaveEnd,
        proofFile: leaveProof,
        reason: leaveReason.trim() || undefined,
        subscriptionId: leaveSubId || undefined,
      });
      toast(
        res.message || (res.status === 'success' ? '已送出暫停申請' : '失敗'),
        res.status === 'success' ? 'success' : 'error',
      );
      if (res.status === 'success') {
        setLeaveProof(null);
        setLeaveReason('');
        if (leaveProofRef.current) leaveProofRef.current.value = '';
        setReloadKey((k) => k + 1);
      }
    } catch (err) {
      toast(getErrorMessage(err, '送出暫停申請失敗'), 'error');
    } finally {
      leaveInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function onUploadLeaveProof(leaveId: number, file: File | undefined) {
    if (!file || proofUploadingId != null) return;
    setProofUploadingId(leaveId);
    try {
      const res = await uploadMemberLeaveProof(leaveId, file);
      toast(res.message || '已補附證明', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '補附證明失敗'), 'error');
    } finally {
      setProofUploadingId(null);
    }
  }

  async function onSubscriptionCancel() {
    if (!cancelSubId) {
      toast('請選擇訂閱', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await submitMemberSubscriptionCancel({
        subscriptionId: cancelSubId,
        mode: cancelMode,
        reason: '會員自助取消',
      });
      toast(
        res.message || (res.status === 'success' ? '已取消' : '失敗'),
        res.status === 'success' ? 'success' : 'error',
      );
      if (res.status === 'success') {
        setConfirmCancel(false);
        setReloadKey((k) => k + 1);
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        setConfirmCancel(false);
        setScheduleConflictOpen(true);
        return;
      }
      toast(getErrorMessage(err, '取消訂閱失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onRebindCard(subscriptionId: string) {
    setRebindBusy(true);
    try {
      const res = await requestMemberCardBinding(subscriptionId);
      if (res.status !== 'success' || !res.data?.actionUrl || !res.data?.payload) {
        toast(res.message || '無法開啟換卡頁', 'error');
        return;
      }
      openPayuniCheckoutInNewTab(res.data.actionUrl, res.data.payload);
      setPendingRebindId(subscriptionId);
      toast(res.message || '已開啟 PayUNi 約定扣款頁', 'success');
    } catch (err) {
      toast(getErrorMessage(err, '換卡失敗'), 'error');
    } finally {
      setRebindBusy(false);
    }
  }

  useEffect(() => {
    if (!pendingRebindId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetchMemberCardBindingStatus(pendingRebindId);
        if (cancelled) return;
        if (res.status === 'success' && res.data && !res.data.rebindPending && res.data.creditUpdated) {
          toast('換卡約定完成', 'success');
          setPendingRebindId(null);
          setReloadKey((k) => k + 1);
        }
      } catch {
        /* ignore poll errors */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [pendingRebindId, toast]);

  async function onRedeemGift(e: FormEvent) {
    e.preventDefault();
    if (!giftCode.trim()) return;
    setBusy(true);
    try {
      const res = await redeemMemberGiftCard(giftCode.trim());
      toast(res.message || '兌換完成', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') {
        setGiftCode('');
        setReloadKey((k) => k + 1);
      }
    } catch (err) {
      toast(getErrorMessage(err, '兌換失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const payLabel = shopPayMethod === 'LINEPAY' ? 'LinePay 線上付款' : '刷卡（PayUNi）';
  const panelLoading = profileLoading || tabLoading;

  return (
    <MemberLayout
      name={profile?.name}
      plan={profile?.plan}
      onRefresh={() => setReloadKey((k) => k + 1)}
      onLogout={logout}
      activeTab="membership"
    >
      {profile?.expireDate ? (
        <Alert tone="info">效期至 {fmt(profile.expireDate)}</Alert>
      ) : null}

      <nav className="hq-tabs" role="tablist" aria-label="會籍">
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
        {panelLoading ? (
          <Skeleton style={{ height: 120 }} />
        ) : tab === 'shop' ? (
          <>
            <Card
              title="線上購案"
              subtitle="金額由方案表定；LinePay 為線上付款，刷卡走 PayUNi"
            >
              <Field label="付款方式">
                <div className="pay-method-grid" role="group" aria-label="付款方式">
                  <button
                    type="button"
                    className={`pay-method-chip${shopPayMethod === 'LINEPAY' ? ' is-active' : ''}`}
                    aria-pressed={shopPayMethod === 'LINEPAY'}
                    onClick={() => setShopPayMethod('LINEPAY')}
                  >
                    <span className="pay-method-chip__label">LinePay</span>
                    <span className="pay-method-chip__hint">線上付款</span>
                  </button>
                  <button
                    type="button"
                    className={`pay-method-chip${shopPayMethod === 'CARD' ? ' is-active' : ''}`}
                    aria-pressed={shopPayMethod === 'CARD'}
                    onClick={() => setShopPayMethod('CARD')}
                  >
                    <span className="pay-method-chip__label">刷卡</span>
                    <span className="pay-method-chip__hint">PayUNi</span>
                  </button>
                </div>
              </Field>
            </Card>
            {promotions.length === 0 ? (
              <EmptyState icon="🛒" title="目前無可購買方案" />
            ) : (
              promotions.map((p) => (
                <Card
                  key={p.id}
                  title={p.name}
                  subtitle={
                    p.branch?.name ? `${p.branch.name} · $${p.price}` : `$${p.price}`
                  }
                >
                  <p className="text-muted text-sm">{formatPromotionOptionLabel(p)}</p>
                  <Button
                    type="button"
                    loading={shopBusyId === p.id}
                    disabled={shopBusyId != null}
                    onClick={() => openBuyConfirm(p)}
                  >
                    {shopPayMethod === 'LINEPAY' ? 'LinePay 購買' : '刷卡購買'}
                  </Button>
                </Card>
              ))
            )}
          </>
        ) : tab === 'leave' ? (
          <>
            <Card
              title="會員權暫停申請"
              subtitle="依契約第十二條：送出後由門市於七個工作日內審核，核准後效期順延、進場暫停，定期定額同步暫停"
            >
              <form onSubmit={onSubscriptionLeave} className="form-stack">
                {profile?.leaveUntil && new Date(profile.leaveUntil) > new Date() && (
                  <Alert tone="info">
                    暫停中至 {fmt(profile.leaveUntil)}，期滿後自動恢復訂閱扣款
                  </Alert>
                )}
                {hasOpenLeave && (
                  <Alert tone="warning">您已有待審、已核准或進行中的暫停申請，需結案後才能再申請</Alert>
                )}
                <Field label="暫停事由" hint={leaveCategoryHint}>
                  <select
                    className="input"
                    value={leaveCategory}
                    onChange={(e) => setLeaveCategory(e.target.value as MemberLeaveCategory | '')}
                    required
                  >
                    <option value="">請選擇</option>
                    {LEAVE_CATEGORY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {subscriptions.length > 0 && (
                  <Field label="訂閱">
                    <select
                      className="input"
                      value={leaveSubId}
                      onChange={(e) => setLeaveSubId(e.target.value)}
                    >
                      {subscriptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.promotion?.name || s.id} ({s.status})
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field
                  label="暫停起始日"
                  hint={leaveDeferrable ? '傷病／疫情可於事由發生後 30 日內補辦' : '須事先申請，起始日不可早於今日'}
                >
                  <Input
                    type="date"
                    value={leaveStart}
                    min={leaveDeferrable ? addDaysIso(todayIsoDate(), -30) : todayIsoDate()}
                    onChange={(e) => {
                      const v = e.target.value;
                      setLeaveStart(v);
                      if (leaveEnd && v && leaveEnd < v) setLeaveEnd(v);
                    }}
                    required
                  />
                </Field>
                <Field label="暫停結束日">
                  <Input
                    type="date"
                    value={leaveEnd}
                    min={leaveStart || undefined}
                    onChange={(e) => setLeaveEnd(e.target.value)}
                    required
                  />
                </Field>
                {leaveDaysPreview != null && (
                  <p className="text-sm text-muted">
                    暫停天數（含起迄日）：{leaveDaysPreview} 天
                    {leaveCategory === 'OVERSEAS' && leaveDaysPreview < 31 ? '（出國事由須至少 31 日）' : ''}
                  </p>
                )}
                <Field
                  label="事由證明"
                  hint={
                    leaveDeferrable
                      ? '可先送件，30 日內於下方申請紀錄補附（JPG／PNG／WebP）；逾期未補自動退回'
                      : '必附（JPG／PNG／WebP）'
                  }
                >
                  <input
                    ref={leaveProofRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="input"
                    onChange={(e) => setLeaveProof(e.target.files?.[0] || null)}
                  />
                  {leaveProof && (
                    <p className="text-sm text-muted" style={{ marginTop: '0.35rem' }}>
                      已選：{leaveProof.name}
                    </p>
                  )}
                </Field>
                <Field label="原因（選填）">
                  <Input value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} />
                </Field>
                <Button type="submit" className="id-photo-touch-btn" loading={busy} disabled={hasOpenLeave}>
                  送出暫停申請
                </Button>
              </form>
            </Card>
            <Card title="我的暫停申請" className="mt-md">
              {leaveApps.length === 0 ? (
                <p className="text-sm text-muted" style={{ margin: 0 }}>尚無申請紀錄</p>
              ) : (
                <ul className="member-list">
                  {leaveApps.map((lv) => (
                    <li key={lv.id} className="form-stack" style={{ gap: '0.35rem' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <Badge tone={leaveStatusTone(lv.status)}>{leaveStatusLabel(lv.status)}</Badge>
                        <strong>{lv.categoryLabel || '會籍暫停'}</strong>
                      </div>
                      <span className="text-sm">
                        {fmtDate(lv.startAt)} ～ {leaveLastDay(lv.endAt)}（{lv.days} 天
                        {lv.status === 'ENDED' && lv.frozenDays != null && lv.frozenDays !== lv.days
                          ? `，實際 ${lv.frozenDays} 天`
                          : ''}
                        ）
                      </span>
                      {lv.status === 'REJECTED' && lv.reviewNote && (
                        <span className="text-sm" style={{ color: 'var(--danger)' }}>退回原因：{lv.reviewNote}</span>
                      )}
                      {lv.status === 'PENDING' && !lv.hasProof && (
                        <Field label="補附證明" hint={`請於 ${fmtDate(lv.proofDueAt)} 前上傳，逾期自動退回`}>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            className="input"
                            disabled={proofUploadingId != null}
                            onChange={(e) => {
                              void onUploadLeaveProof(lv.id, e.target.files?.[0]);
                              e.target.value = '';
                            }}
                          />
                        </Field>
                      )}
                      {lv.status === 'PENDING' && lv.hasProof && (
                        <span className="text-sm text-muted">
                          審核期限 {fmtDate(lv.reviewDueAt)}；如有疑問請洽門市
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="團課請假／補課" className="mt-md">
              <p className="text-sm text-muted" style={{ marginTop: 0 }}>
                團課為付費期班，開課前 24 小時請假可取得補課權，請至約課頁的「團課期班」操作。
              </p>
              <Link to="/member/book?tab=group" className="btn btn--secondary btn--sm">
                前往團課期班
              </Link>
            </Card>
          </>
        ) : tab === 'subscription' ? (
          subscriptions.length === 0 ? (
            <EmptyState icon="💳" title="尚無訂閱" />
          ) : (
            <>
              <ul className="member-list">
                {subscriptions.map((s) => (
                  <li key={s.id}>
                    <Card title={s.promotion?.name || s.id} subtitle={`狀態 ${s.status}`}>
                      <p className="text-sm text-muted">下次扣款 {fmt(s.nextChargeAt)}</p>
                      {['ACTIVE', 'PAUSED', 'FAILED'].includes(String(s.status)) && (
                        <div style={{ marginTop: '0.5rem' }}>
                          <Button
                            variant="secondary"
                            className="id-photo-touch-btn"
                            loading={rebindBusy && pendingRebindId === s.id}
                            disabled={rebindBusy}
                            onClick={() => void onRebindCard(s.id)}
                          >
                            更換信用卡
                          </Button>
                        </div>
                      )}
                    </Card>
                  </li>
                ))}
              </ul>
              <Card title="取消訂閱" className="mt-md">
                <Field label="訂閱">
                  <select
                    className="input"
                    value={cancelSubId}
                    onChange={(e) => setCancelSubId(e.target.value)}
                  >
                    {subscriptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.promotion?.name || s.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="模式" hint="KEEP 保留效期；CUT 截斷並結算">
                  <select
                    className="input"
                    value={cancelMode}
                    onChange={(e) => setCancelMode(e.target.value as 'KEEP' | 'CUT')}
                  >
                    <option value="KEEP">保留效期至到期</option>
                    <option value="CUT">立即截斷效期</option>
                  </select>
                </Field>
                <Button
                  variant="danger"
                  className="id-photo-touch-btn"
                  onClick={() => setConfirmCancel(true)}
                >
                  取消訂閱
                </Button>
              </Card>
            </>
          )
        ) : tab === 'points' ? (
          points.length === 0 ? (
            <EmptyState icon="⭐" title="尚無點數異動" />
          ) : (
            <ul className="member-list">
              {points.map((p) => (
                <li key={p.id}>
                  <Card title={`${p.delta >= 0 ? '+' : ''}${p.delta} 點`} subtitle={fmt(p.createdAt)}>
                    <p>
                      餘額 {p.balance} · {p.reason || '—'}
                    </p>
                  </Card>
                </li>
              ))}
            </ul>
          )
        ) : (
          <>
            <Card title="兌換禮物卡">
              <form onSubmit={onRedeemGift}>
                <Field label="兌換碼">
                  <Input
                    value={giftCode}
                    onChange={(e) => setGiftCode(e.target.value.toUpperCase())}
                  />
                </Field>
                <Button type="submit" loading={busy}>
                  兌換
                </Button>
              </form>
            </Card>
            {!giftCards?.purchased?.length && !giftCards?.redeemed?.length ? (
              <EmptyState icon="🎁" title="尚無禮物卡紀錄" />
            ) : (
              <>
                {(giftCards?.purchased || []).length > 0 && (
                  <Card title="我購買的" className="mt-md">
                    <ul className="member-list">
                      {giftCards!.purchased.map((g) => (
                        <li key={g.id}>
                          ${g.amount} · {g.code} · <Badge>{g.status}</Badge>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                {(giftCards?.redeemed || []).length > 0 && (
                  <Card title="我兌換的" className="mt-md">
                    <ul className="member-list">
                      {giftCards!.redeemed.map((g) => (
                        <li key={g.id}>
                          ${g.amount} · {fmt(g.redeemedAt)}
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </div>

      <Modal
        open={pendingBuy !== null}
        onClose={() => {
          if (shopBusyId != null) return;
          setPendingBuy(null);
        }}
        title="確認購買"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={shopBusyId != null}
              onClick={() => setPendingBuy(null)}
            >
              取消
            </Button>
            <Button
              loading={shopBusyId != null}
              onClick={() => void confirmShopBuy()}
            >
              確認並付款
            </Button>
          </>
        }
      >
        {pendingBuy ? (
          <div className="form-stack">
            <p>
              方案：<strong>{pendingBuy.name}</strong>
            </p>
            <p>
              金額：<strong>${pendingBuy.price}</strong>
            </p>
            <p>
              付款方式：<strong>{payLabel}</strong>
            </p>
            <p className="text-muted text-sm">確認後將導向金流頁完成付款；金額由方案表定，無法於前端修改。</p>
          </div>
        ) : null}
      </Modal>

      <Modal open={confirmCancel} onClose={() => setConfirmCancel(false)} title="確認取消訂閱">
        <p>確定要取消所選訂閱？此操作可能無法復原。</p>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <Button
            variant="ghost"
            className="id-photo-touch-btn"
            onClick={() => setConfirmCancel(false)}
          >
            返回
          </Button>
          <Button
            variant="danger"
            className="id-photo-touch-btn"
            loading={busy}
            onClick={() => void onSubscriptionCancel()}
          >
            確認取消
          </Button>
        </div>
      </Modal>

      <Modal
        open={scheduleConflictOpen}
        onClose={() => setScheduleConflictOpen(false)}
        title="無法線上取消"
        footer={
          <Button className="id-photo-touch-btn" onClick={() => setScheduleConflictOpen(false)}>
            我知道了
          </Button>
        }
      >
        <Alert tone="warning">{SCHEDULE_CONFLICT_MSG}</Alert>
        <p className="text-sm text-muted" style={{ marginTop: '0.75rem' }}>
          金流端定期排程仍生效時，系統無法直接終止訂閱；請由櫃檯或客服於統一金流後台協助處理後再取消。
        </p>
      </Modal>

      <Modal
        open={pendingRebindId !== null}
        onClose={() => setPendingRebindId(null)}
        title="等待換卡約定"
      >
        <p className="text-sm">
          已另開 PayUNi 約定扣款頁；請輸入新卡完成綁定（本次不收款）。完成後系統會自動輪詢更新狀態。
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <Button
            variant="ghost"
            className="id-photo-touch-btn"
            onClick={() => setPendingRebindId(null)}
          >
            稍後再查
          </Button>
          <Button
            className="id-photo-touch-btn"
            onClick={() =>
              void (async () => {
                if (!pendingRebindId) return;
                try {
                  const res = await fetchMemberCardBindingStatus(pendingRebindId);
                  if (
                    res.status === 'success' &&
                    res.data &&
                    !res.data.rebindPending &&
                    res.data.creditUpdated
                  ) {
                    toast('換卡約定完成', 'success');
                    setPendingRebindId(null);
                    setReloadKey((k) => k + 1);
                  } else {
                    toast('尚未收到約定回報，請稍候再試', 'info');
                  }
                } catch (err) {
                  toast(getErrorMessage(err, '查詢失敗'), 'error');
                }
              })()
            }
          >
            我已完成換卡
          </Button>
        </div>
      </Modal>
    </MemberLayout>
  );
}
