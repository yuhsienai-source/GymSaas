import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import LandingLayout from '../../components/layout/LandingLayout';
import { Alert, Button, Card } from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { fetchMemberWallet, getErrorMessage } from '../../lib/api';
import type { MemberWallet } from '../../types/api';

/**
 * 對齊後端 FRONTEND_PAY_RETURN_PATH（預設 /pay/return）
 * PayUNi／LinePay 線上付款瀏覽器回流 → 後端 302 → 此頁。
 * 入帳以金流回呼為準；本頁只做人話狀態與錢包確認，不顯示技術參數。
 */
export default function PayReturnPage() {
  const [params] = useSearchParams();
  const { isAuthenticated } = useMemberAuth();
  const pay = params.get('pay');
  /** 團課報名（GRP）：不入帳錢包，改導回團課頁查看報名狀態 */
  const isGroup = params.get('kind') === 'group';
  const [wallet, setWallet] = useState<MemberWallet | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const cancelled = pay === 'cancelled';
  const done = pay === 'done';
  const unknown = !cancelled && !done;

  useEffect(() => {
    if (!done || !isAuthenticated || isGroup) return;
    let alive = true;
    let attempt = 0;
    const maxAttempts = 6;
    let timer: number | undefined;

    const poll = async () => {
      if (!alive) return;
      setChecking(true);
      setCheckError('');
      try {
        const res = await fetchMemberWallet();
        if (!alive) return;
        if (res.status === 'success' && res.data) {
          setWallet(res.data);
        }
      } catch (err) {
        if (alive) {
          setCheckError(getErrorMessage(err, '暫時無法確認錢包，請稍後至會籍頁查看'));
        }
      }
      if (!alive) return;
      setChecking(false);
      attempt += 1;
      if (attempt < maxAttempts) {
        timer = window.setTimeout(() => void poll(), 2000);
      }
    };

    void poll();
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [done, isAuthenticated, isGroup, refreshKey]);

  const title = cancelled ? '已取消付款' : done ? '付款處理中' : '請確認訂單狀態';
  const lead = cancelled
    ? isGroup
      ? '您已取消這次付款，保留的團課名額已釋出。若仍要報名，請回團課期班再試一次。'
      : '您已取消這次付款。若仍要購買，請回會籍／購案再試一次。'
    : done && isGroup
      ? '已從付款頁面返回。系統確認付款後報名即生效，通常幾秒到一兩分鐘內完成，請勿重複付款。'
      : done
      ? '已從付款頁面返回。系統正在確認入帳，通常幾秒到一兩分鐘內完成。請勿重複付款。'
      : '未偵測到完整付款標記。請到會籍頁查看錢包與訂單，或洽櫃檯協助。';

  return (
    <LandingLayout>
      <div className="auth-page">
        <Card className="auth-card" variant="elevated" padding="lg">
          <h2>{title}</h2>
          <p className="text-muted">{lead}</p>

          {cancelled && (
            <Alert tone="warning">
              這次沒有扣款完成。若銀行簡訊有授權通知，可能稍後自動取消，請以錢包餘額為準。
            </Alert>
          )}

          {done && isGroup && (
            <Alert tone="info">團課款項不會存入錢包；報名狀態請至「約課 → 團課期班」查看。</Alert>
          )}

          {done && !isGroup && (
            <Alert tone={wallet ? 'success' : 'info'}>
              {wallet
                ? `目前錢包：現金 $${Math.round(wallet.cashWallet).toLocaleString('zh-TW')} · 運動金 $${Math.round(wallet.bonusWallet).toLocaleString('zh-TW')}`
                : checking
                  ? '正在向系統確認入帳狀態…'
                  : '若餘額尚未更新，請稍候再重整，或至會籍頁查看。'}
            </Alert>
          )}

          {checkError && <Alert tone="warning">{checkError}</Alert>}
          {unknown && <Alert tone="info">建議先登入會員專區確認，不要在付款頁重複送出。</Alert>}

          <div className="form-stack" style={{ marginTop: '1.25rem' }}>
            {isAuthenticated && isGroup ? (
              <>
                <Link to="/member/book?tab=group" className="btn btn--primary btn--md" style={{ textAlign: 'center' }}>
                  查看我的團課
                </Link>
                <Link to="/member" className="btn btn--secondary btn--md" style={{ textAlign: 'center' }}>
                  回會員首頁
                </Link>
              </>
            ) : isAuthenticated ? (
              <>
                <Link to="/member/membership" className="btn btn--primary btn--md" style={{ textAlign: 'center' }}>
                  查看會籍／錢包
                </Link>
                <Link to="/member" className="btn btn--secondary btn--md" style={{ textAlign: 'center' }}>
                  回會員首頁
                </Link>
              </>
            ) : (
              <Link to="/" className="btn btn--primary btn--md" style={{ textAlign: 'center' }}>
                登入後查看錢包
              </Link>
            )}
            {done && isAuthenticated && !isGroup && (
              <Button type="button" variant="ghost" loading={checking} onClick={() => setRefreshKey((k) => k + 1)}>
                重新整理錢包
              </Button>
            )}
          </div>
        </Card>
      </div>
    </LandingLayout>
  );
}
