import { Link, useSearchParams } from 'react-router-dom';
import LandingLayout from '../../components/layout/LandingLayout';
import { Alert, Card } from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';

/**
 * 對齊後端 FRONTEND_PAY_RETURN_PATH（預設 /pay/return）
 * PayUNi 瀏覽器 POST → 後端 302 → 此頁。入帳以 Webhook 為準。
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
            {pay === 'done'
              ? '瀏覽器已從金流返回。錢包入帳由後端 Webhook 處理，若餘額尚未更新請稍候再重整。'
              : '未偵測到完成標記，請至會員專區確認訂單狀態。'}
          </p>
          {pay === 'done' && (
            <Alert tone="success">pay=done（入帳非同步）</Alert>
          )}
          <p className="text-center mt-md">
            {isAuthenticated ? (
              <Link to="/member">回會員專區查看錢包</Link>
            ) : (
              <Link to="/">登入後查看錢包</Link>
            )}
          </p>
        </Card>
      </div>
    </LandingLayout>
  );
}
