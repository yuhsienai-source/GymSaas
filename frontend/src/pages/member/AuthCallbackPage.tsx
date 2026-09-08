import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import LandingLayout from '../../components/layout/LandingLayout';
import { Alert, Button, Card } from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  bindMemberDevice,
  exchangeAuthCallbackCode,
  exchangeLineCode,
  getDeviceResetRequiredPayload,
  getErrorMessage,
} from '../../lib/api';
import { clearOnboardingToken, getOrCreateDeviceId } from '../../lib/storage';
import { stashDeviceResetSession } from '../../lib/deviceResetSession';

/**
 * 對齊後端 FRONTEND_AUTH_CALLBACK_PATH（預設 /auth/callback）
 * 承接 LINE / JWT 瀏覽器回流，本頁不託管在後端。
 * 登入後須先完成／確認本機裝置綁定，再進 /member。
 *
 * 注意：React Strict Mode 會雙次掛載 effect；換票以 onceLineExchange 去重，
 * 導向必須只做一次且不可因第一次 cleanup 的 cancelled 旗標放棄導向。
 */
export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { login } = useMemberAuth();
  const { toast } = useToast();
  const finishingRef = useRef(false);

  const token = params.get('token');
  const authCode = params.get('auth_code');
  const code = params.get('code');
  const oauthState = params.get('state');
  const loginError = params.get('login_error');

  const urlError = loginError
    ? decodeURIComponent(loginError)
    : !token && !authCode && !code
      ? '缺少授權參數，請重新登入'
      : '';

  const [exchangeError, setExchangeError] = useState('');
  const [exchangeFailed, setExchangeFailed] = useState(false);
  const [statusText, setStatusText] = useState('正在完成登入…');

  const error = exchangeError || urlError;
  const busy =
    !error &&
    (Boolean(token) || Boolean(authCode) || (Boolean(code) && !exchangeFailed));

  useEffect(() => {
    if (loginError || (!token && !authCode && !code)) return;

    let cancelled = false;

    async function ensureDeviceBound(memberToken: string): Promise<boolean> {
      login(memberToken);
      try {
        const res = await bindMemberDevice(getOrCreateDeviceId());
        if (res.status === 'success') {
          if (res.data?.token) login(res.data.token);
          return true;
        }
        return false;
      } catch (err) {
        const reset = getDeviceResetRequiredPayload(err);
        if (reset) throw err;
        return false;
      }
    }

    async function finishLogin(memberToken: string, opts: { message?: string }) {
      // Strict Mode 雙 effect：只完成一次導向（不可因 cancelled 半途放棄）
      if (finishingRef.current) return;
      finishingRef.current = true;

      try {
        setStatusText('正在綁定本機裝置…');
        const ok = await ensureDeviceBound(memberToken);
        clearOnboardingToken();

        if (!ok) {
          toast(opts.message || 'LINE 登入成功，請完成本機裝置綁定', 'success');
          navigate('/?needDevice=1', { replace: true });
          return;
        }

        setStatusText('登入成功，即將進入會員中心…');
        toast(opts.message || 'LINE 登入成功', 'success');
        navigate('/member', { replace: true });
      } catch (err) {
        finishingRef.current = false;
        if (!cancelled) {
          const reset = getDeviceResetRequiredPayload(err);
          if (reset) {
            stashDeviceResetSession({
              resetTicket: reset.resetTicket,
              maskedEmail: reset.maskedEmail,
            });
            toast(reset.message, 'info');
            navigate('/?deviceReset=1', { replace: true });
            return;
          }
          setExchangeError(getErrorMessage(err, '完成登入失敗'));
          setExchangeFailed(true);
        }
      }
    }

    void (async () => {
      try {
        if (token) {
          await finishLogin(token, { message: '登入成功' });
          return;
        }

        if (authCode) {
          setStatusText('正在驗證授權…');
          const result = await exchangeAuthCallbackCode(authCode);
          if (result.status === 'success' && result.data?.token) {
            await finishLogin(result.data.token, {
              message: result.message || 'LINE 登入成功',
            });
            return;
          }
          if (!cancelled) {
            setExchangeError(result.message || 'LINE 登入失敗');
            setExchangeFailed(true);
          }
          return;
        }

        setStatusText('正在驗證 LINE…');
        const result = await exchangeLineCode(code!, oauthState);
        if (result.status === 'success' && result.data?.token) {
          await finishLogin(result.data.token, {
            message: result.message || 'LINE 登入成功',
          });
          return;
        }
        if (!cancelled) {
          setExchangeError(result.message || 'LINE 登入失敗');
          setExchangeFailed(true);
        }
      } catch (err) {
        if (!cancelled) {
          const reset = getDeviceResetRequiredPayload(err);
          if (reset) {
            stashDeviceResetSession({
              resetTicket: reset.resetTicket,
              maskedEmail: reset.maskedEmail,
            });
            toast(reset.message, 'info');
            navigate('/?deviceReset=1', { replace: true });
            return;
          }
          setExchangeError(getErrorMessage(err, 'LINE 登入連線失敗'));
          setExchangeFailed(true);
          finishingRef.current = false;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, authCode, code, oauthState, loginError, login, navigate, toast]);

  return (
    <LandingLayout>
      <div className="auth-page">
        <Card className="auth-card" variant="elevated" padding="lg">
          <h2>{busy ? '驗證中' : '無法完成登入'}</h2>
          <p className="text-muted">{busy ? statusText : '請返回登入頁再試一次'}</p>
          {error && <Alert tone="error">{error}</Alert>}
          {!busy && (
            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={() => navigate('/', { replace: true })}
              >
                回會員登入
              </Button>
              <p className="text-center">
                <Link to="/">或點此返回首頁</Link>
              </p>
            </div>
          )}
        </Card>
      </div>
    </LandingLayout>
  );
}
