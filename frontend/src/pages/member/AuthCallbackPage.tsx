import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import LandingLayout from '../../components/layout/LandingLayout';
import { Alert, Card } from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  bindMemberDevice,
  exchangeAuthCallbackCode,
  exchangeLineCode,
  getErrorMessage,
} from '../../lib/api';
import { clearOnboardingToken, getOrCreateDeviceId } from '../../lib/storage';

/**
 * 對齊後端 FRONTEND_AUTH_CALLBACK_PATH（預設 /auth/callback）
 * 承接 LINE / JWT 瀏覽器回流，本頁不託管在後端。
 * 登入後須先完成／確認本機裝置綁定，再進 /member（避免 fire-and-forget 賽跑踢自己）。
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

  const error = exchangeError || urlError;
  const busy =
    !error &&
    (Boolean(token) || Boolean(authCode) || (Boolean(code) && !exchangeFailed));

  useEffect(() => {
    if (loginError || (!token && !authCode && !code)) return;

    let alive = true;

    /** 確認／補綁本機；同機不 bump dav，並以回傳 token 更新 context */
    async function ensureDeviceBound(memberToken: string): Promise<boolean> {
      login(memberToken);
      try {
        const res = await bindMemberDevice(getOrCreateDeviceId());
        if (res.status === 'success') {
          if (res.data?.token) login(res.data.token);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }

    async function finishLogin(memberToken: string, opts: { message?: string }) {
      // Strict Mode 雙次 effect：只完成一次導向
      if (finishingRef.current) return;
      finishingRef.current = true;

      const ok = await ensureDeviceBound(memberToken);
      if (!alive) return;

      clearOnboardingToken();

      if (!ok) {
        toast(opts.message || 'LINE 登入成功，請完成本機裝置綁定', 'success');
        navigate('/?needDevice=1', { replace: true });
        return;
      }

      toast(opts.message || 'LINE 登入成功', 'success');
      navigate('/member', { replace: true });
    }

    if (token) {
      void finishLogin(token, { message: '登入成功' });
      return;
    }

    if (authCode) {
      void (async () => {
        try {
          const result = await exchangeAuthCallbackCode(authCode);
          if (result.status === 'success' && result.data?.token) {
            await finishLogin(result.data.token, {
              message: result.message || 'LINE 登入成功',
            });
            return;
          }
          if (alive) {
            setExchangeError(result.message || 'LINE 登入失敗');
            setExchangeFailed(true);
            finishingRef.current = false;
          }
        } catch (err) {
          if (alive) {
            setExchangeError(getErrorMessage(err, 'LINE 登入連線失敗'));
            setExchangeFailed(true);
            finishingRef.current = false;
          }
        }
      })();
      return () => {
        alive = false;
      };
    }

    void (async () => {
      try {
        const result = await exchangeLineCode(code!, oauthState);
        if (result.status === 'success' && result.data?.token) {
          await finishLogin(result.data.token, {
            message: result.message || 'LINE 登入成功',
          });
          return;
        }
        if (alive) {
          setExchangeError(result.message || 'LINE 登入失敗');
          setExchangeFailed(true);
          finishingRef.current = false;
        }
      } catch (err) {
        if (alive) {
          setExchangeError(getErrorMessage(err, 'LINE 登入連線失敗'));
          setExchangeFailed(true);
          finishingRef.current = false;
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [token, authCode, code, oauthState, loginError, login, navigate, toast]);

  return (
    <LandingLayout>
      <div className="auth-page">
        <Card className="auth-card" variant="elevated" padding="lg">
          <h2>驗證中</h2>
          <p className="text-muted">{busy ? '正在完成登入…' : '無法完成登入'}</p>
          {error && <Alert tone="error">{error}</Alert>}
          {!busy && (
            <p className="text-center mt-md">
              <Link to="/">回會員登入</Link>
            </p>
          )}
        </Card>
      </div>
    </LandingLayout>
  );
}
