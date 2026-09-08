import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import MemberLayout from '../../components/layout/MemberLayout';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ProgressRing,
  Skeleton,
  StatCard,
} from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  fetchBoardOccupancy,
  fetchBoardOccupancySettings,
  fetchMemberProfile,
  fetchMemberQrCode,
  fetchMemberWallet,
  fetchPtContracts,
  getApiErrorDetails,
  getErrorMessage,
} from '../../lib/api';
import { getOrCreateDeviceId } from '../../lib/storage';
import type { MemberProfile, MemberWallet, PtContract } from '../../types/api';

const MEMBER_ID_QR_PREFIX = 'GYMSAAS:MEMBER:';

type QrPanel = null | 'gate' | 'identity';

function buildMemberIdentityQrValue(memberNo?: string | null) {
  const no = String(memberNo || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(no)) return '';
  return `${MEMBER_ID_QR_PREFIX}${no}`;
}

export default function MemberDashboardPage() {
  const { logout } = useMemberAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [wallet, setWallet] = useState<MemberWallet | null>(null);
  const [contracts, setContracts] = useState<PtContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [qrPanel, setQrPanel] = useState<QrPanel>(null);
  const [qrToken, setQrToken] = useState('');
  const [ttl, setTtl] = useState(30);
  const [timeLeft, setTimeLeft] = useState(30);
  const [qrError, setQrError] = useState('');
  const [contractLocked, setContractLocked] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [occupancyVisible, setOccupancyVisible] = useState(false);
  const [occupancyCount, setOccupancyCount] = useState<number | null>(null);
  const [occupancyUpdatedAt, setOccupancyUpdatedAt] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const isAlert = Boolean(profile?.isAlert);
  const gateOpen = qrPanel === 'gate';
  const identityOpen = qrPanel === 'identity';

  const refreshQr = useCallback(async () => {
    if (isAlert) return;
    try {
      const result = await fetchMemberQrCode();
      if (result.status === 'success' && result.qrToken) {
        const seconds = result.ttlSeconds || 30;
        setQrToken(result.qrToken);
        setTtl(seconds);
        setTimeLeft(seconds);
        setQrError('');
        setContractLocked(false);
      } else {
        setQrError(result.message || '無法產生門禁碼');
        setQrToken('');
      }
    } catch (err) {
      const details = getApiErrorDetails(err);
      const locked =
        details.code === 'CONTRACT_REQUIRED' || details.code === 'CONTRACT_UNSIGNED';
      setContractLocked(locked);
      setQrError(
        locked
          ? details.message || '請先完成入會契約簽署，始可產生門禁碼'
          : getErrorMessage(err, '條碼產生失敗'),
      );
      setQrToken('');
    }
  }, [isAlert]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [profileRes, walletRes, contractsRes] = await Promise.all([
          fetchMemberProfile(),
          fetchMemberWallet(),
          fetchPtContracts(),
        ]);
        if (cancelled) return;
        if (profileRes.status === 'success' && profileRes.data) setProfile(profileRes.data);
        if (walletRes.status === 'success' && walletRes.data) setWallet(walletRes.data);
        if (contractsRes.status === 'success' && contractsRes.data) {
          setContracts(contractsRes.data);
        }
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入會員資料失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [toast, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const branchId = profile?.branches?.[0]?.branchId;
        const settings = await fetchBoardOccupancySettings(
          branchId != null ? { branchId } : undefined,
        );
        const show = settings.status === 'success' && settings.data?.isDisplay === true;
        if (cancelled) return;
        if (!show) {
          setOccupancyVisible(false);
          setOccupancyCount(null);
          setOccupancyUpdatedAt(null);
          return;
        }
        setOccupancyVisible(true);
        const occ = await fetchBoardOccupancy();
        if (cancelled) return;
        if (occ.status === 'success' && occ.data) {
          setOccupancyCount(occ.data.presentCount);
          setOccupancyUpdatedAt(occ.data.updatedAt || null);
        } else {
          setOccupancyVisible(false);
          setOccupancyCount(null);
        }
      } catch {
        if (!cancelled) {
          setOccupancyVisible(false);
          setOccupancyCount(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, profile?.branches]);

  // 僅在展開「門禁」時才取／刷新動態門禁碼
  useEffect(() => {
    if (!gateOpen || !profile || profile.isAlert) return;
    let cancelled = false;

    async function loadQr() {
      try {
        const result = await fetchMemberQrCode();
        if (cancelled) return;
        if (result.status === 'success' && result.qrToken) {
          const seconds = result.ttlSeconds || 30;
          setQrToken(result.qrToken);
          setTtl(seconds);
          setTimeLeft(seconds);
          setQrError('');
          setContractLocked(false);
        } else {
          setQrError(result.message || '無法產生門禁碼');
          setQrToken('');
        }
      } catch (err) {
        if (cancelled) return;
        const details = getApiErrorDetails(err);
        const locked =
          details.code === 'CONTRACT_REQUIRED' || details.code === 'CONTRACT_UNSIGNED';
        setContractLocked(locked);
        setQrError(
          locked
            ? details.message || '請先完成入會契約簽署，始可產生門禁碼'
            : getErrorMessage(err, '條碼產生失敗'),
        );
        setQrToken('');
      }
    }

    void loadQr();
    return () => {
      cancelled = true;
    };
  }, [gateOpen, profile, reloadKey]);

  useEffect(() => {
    if (!gateOpen || isAlert || contractLocked) return;

    timerRef.current = window.setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          void refreshQr();
          return ttl;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [gateOpen, refreshQr, ttl, isAlert, contractLocked]);

  function togglePanel(panel: Exclude<QrPanel, null>) {
    setQrPanel((cur) => (cur === panel ? null : panel));
  }

  const deviceShort = getOrCreateDeviceId().split('-')[0];
  const plan = wallet?.plan || profile?.plan || '計時會員';
  const cash = wallet?.cashWallet ?? profile?.cashWallet ?? 0;
  const bonus = wallet?.bonusWallet ?? profile?.bonusWallet ?? 0;
  const identityQr = buildMemberIdentityQrValue(profile?.memberNo);
  const headerPlan = [profile?.branchLabel, plan, profile?.memberNo]
    .filter(Boolean)
    .join(' · ');

  return (
    <MemberLayout
      name={profile?.name || (loading ? '載入中…' : '會員')}
      plan={headerPlan || plan}
      onRefresh={() => {
        setLoading(true);
        setQrPanel(null);
        setReloadKey((k) => k + 1);
        toast('已重新整理', 'info');
      }}
      onLogout={logout}
      activeTab="home"
    >
      {profile?.isAlert && (
        <Alert tone="warning">
          🚨 警示帳號：動態門禁 QR 已停用。請洽櫃檯或使用人臉辨識進出場。
        </Alert>
      )}
      {contractLocked && (
        <Alert tone="error">
          ⚖️ 入會契約未簽署：門禁碼已鎖定。請至個人資料／櫃檯完成定型化契約簽署後再試。
        </Alert>
      )}

      <Card padding="md" className="member-qr-actions">
        <div className="member-qr-actions__row">
          <Button
            type="button"
            size="lg"
            variant={gateOpen ? 'primary' : 'secondary'}
            style={{ width: '100%' }}
            onClick={() => togglePanel('gate')}
            disabled={loading}
          >
            {gateOpen ? '收起進出場碼' : '進出場'}
          </Button>
          <Button
            type="button"
            size="lg"
            variant={identityOpen ? 'primary' : 'secondary'}
            style={{ width: '100%' }}
            onClick={() => togglePanel('identity')}
            disabled={loading}
          >
            {identityOpen ? '收起身分辨識' : '身分辨識'}
          </Button>
        </div>
        {!qrPanel && (
          <p className="text-sm text-muted text-center" style={{ marginTop: '0.75rem' }}>
            「進出場」同一組動態碼，進場／出場閘機皆可掃；「身分辨識」僅供櫃檯查詢
          </p>
        )}
      </Card>

      {gateOpen && (
        <Card variant="elevated" padding="lg" className="qr-hero">
          <div className="card__header" style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
            <h2 className="card__title">進出場門禁碼</h2>
            <p className="card__subtitle">
              進場與出場掃同一組碼 · 30 秒自動更新 · 請對準閘機鏡頭
            </p>
          </div>

          {profile?.isAlert ? (
            <EmptyState icon="🚫" title="門禁 QR 已停用" desc="此帳號需人工查驗或使用人臉" />
          ) : contractLocked ? (
            <EmptyState icon="📝" title="契約未簽署" desc={qrError || '請先完成入會契約'} />
          ) : qrToken ? (
            <div className="qr-hero__ring-wrap">
              <ProgressRing value={timeLeft} max={ttl} />
              <div className="qr-hero__frame">
                <QRCodeSVG value={qrToken} size={220} level="H" className="qr-hero__svg" />
              </div>
            </div>
          ) : (
            <EmptyState icon="⏳" title={qrError || '產生中…'} />
          )}

          {!profile?.isAlert && qrToken && (
            <p className="qr-hero__countdown">
              <strong>{timeLeft}</strong> 秒後自動換新 · 裝置 {deviceShort}…
            </p>
          )}
        </Card>
      )}

      {identityOpen && (
        <Card padding="lg" className="qr-hero">
          <div className="card__header" style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
            <h2 className="card__title">身分辨識碼</h2>
            <p className="card__subtitle">固定不變 · 供櫃檯／私教掃碼查會員（不可當門禁）</p>
          </div>
          {identityQr ? (
            <>
              <div className="qr-hero__frame" style={{ margin: '0 auto' }}>
                <QRCodeSVG value={identityQr} size={200} level="M" className="qr-hero__svg" />
              </div>
              <p className="qr-hero__countdown" style={{ marginTop: '0.75rem' }}>
                會員編號 <strong className="mono">{profile?.memberNo}</strong>
              </p>
            </>
          ) : (
            <EmptyState icon="⏳" title="會員編號產生中" desc="請稍候重新整理" />
          )}
        </Card>
      )}

      <div className="wallet-row bento-grid--compact">
        {loading ? (
          <>
            <Skeleton className="skeleton--stat" />
            <Skeleton className="skeleton--stat" />
          </>
        ) : (
          <>
            <StatCard label="零錢包（本金）" value={`$${cash}`} tone="cash" />
            <StatCard label="運動金" value={`$${bonus}`} tone="bonus" />
          </>
        )}
      </div>

      {occupancyVisible && occupancyCount != null && (
        <Card
          title="場館即時人數"
          subtitle={
            occupancyUpdatedAt
              ? `更新於 ${new Date(occupancyUpdatedAt).toLocaleTimeString('zh-TW')}`
              : '依看板即時資料'
          }
          padding="md"
        >
          <div className="member-occupancy">
            <strong className="member-occupancy__count">{occupancyCount}</strong>
            <span className="member-occupancy__unit">人在館</span>
          </div>
        </Card>
      )}

      <Card padding="md">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <Badge tone="info" dot>
            {plan}
          </Badge>
          {profile?.expireDate && (
            <span className="text-sm text-muted">
              效期 {new Date(profile.expireDate).toLocaleDateString('zh-TW')}
            </span>
          )}
          {profile?.hasFaceBound && <Badge tone="success">人臉已綁定</Badge>}
        </div>
        <p className="text-sm text-muted mt-sm">計時 1.3 元/分 · 優先扣運動金</p>
      </Card>

      <Card title="私教合約" subtitle="購課或總部補償贈送後依堂數扣減，不扣零錢包">
        {loading ? (
          <Skeleton style={{ height: 60 }} />
        ) : contracts.length === 0 ? (
          <EmptyState icon="💪" title="尚無私教合約" desc="至櫃檯購買合約後即可預約" />
        ) : (
          contracts.map((c) => {
            const pct = (c.remainingSessions / c.totalSessions) * 100;
            return (
              <div key={c.id} className="contract-card">
                <div className="contract-card__head">
                  <strong>{c.trainer.name}</strong>
                  <div className="btn-row" style={{ gap: 6 }}>
                    {c.source === 'COMPENSATION' ? (
                      <Badge tone="info">補償贈送</Badge>
                    ) : (
                      <Badge tone="neutral">付費</Badge>
                    )}
                    <Badge tone={c.isActive ? 'success' : 'neutral'}>
                      {c.isActive ? '有效' : '失效'}
                    </Badge>
                  </div>
                </div>
                <p className="text-sm text-muted" style={{ marginBottom: '0.5rem' }}>
                  {c.coursePlanName ? `${c.coursePlanName} · ` : ''}
                  剩餘 {c.remainingSessions} / {c.totalSessions} 堂
                </p>
                <div className="contract-card__bar">
                  <div className="contract-card__bar-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })
        )}
      </Card>
    </MemberLayout>
  );
}
