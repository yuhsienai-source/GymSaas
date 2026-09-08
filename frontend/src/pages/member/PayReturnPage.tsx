import { Link, useSearchParams } from 'react-router-dom';
import LandingLayout from '../../components/layout/LandingLayout';
import { Alert, Card } from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';

/**
 * 對齊後端 FRONTEND_PAY_RETURN_PATH（預設 /pay/return）
 * PayUNi／LinePay 線上付款瀏覽器回流 → 後端 302 → 此頁。
 * PayUNi 入帳以 Webhook 為準；LinePay Online 於 ConfirmURL 已 confirm＋入帳。
 */
export default function PayReturnPage() {
  const [params] = useSearchParams();
  const { isAuthenticated } = useMemberAuth();
  const pay = params.get('pay');

  return (
    <LandingLayout>
      <div className="auth-page">
        <Card className="auth-card" variant="elevated" padding="lg">
          <h2>付款流程結束</h2>
          <p className="text-muted">
            {pay === 'cancelled'
              ? '您已取消付款。若需重新購買，請回會員專區再試一次。'
              : pay === 'done'
                ? '瀏覽器已從金流返回。若為刷卡，錢包入帳可能稍後才由 Webhook 完成；LinePay 線上付款通常已即時確認。'
                : '未偵測到完成標記，請至會員專區確認訂單狀態。'}
          </p>
          {pay === 'done' && (
            <Alert tone="success">pay=done</Alert>
          )}
          {pay === 'cancelled' && (
            <Alert tone="warning">pay=cancelled</Alert>
          )}
          <p className="text-center mt-md">
            {isAuthenticated ? (
              <Link to="/member/membership">回會籍／購案</Link>
            ) : (
              <Link to="/">登入後查看錢包</Link>
            )}
          </p>
        </Card>
      </div>
    </LandingLayout>
  );
}
