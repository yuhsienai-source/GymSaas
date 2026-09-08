import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import LandingLayout from '../../components/layout/LandingLayout';
import { Alert, Button, Card, Field, Input, PasswordInput } from '../../components/ui';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { useToast } from '../../contexts/ToastContext';
import { getErrorMessage, pingApiHealth, staffLogin } from '../../lib/api';
import { getDefaultStaffPath } from '../../lib/staffPermissions';

export default function StaffLoginPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAuthenticated, staff, login } = useStaffAuth();
  const { toast } = useToast();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(() => {
    const raw = searchParams.get('login_error');
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  });
  const [apiOk, setApiOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!searchParams.get('login_error')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('login_error');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!isAuthenticated || !staff) return;
    const next = getDefaultStaffPath(staff);
    // 無可用模組時 getDefaultStaffPath 會是 /staff/login，避免自我導頁迴圈
    if (next !== '/staff/login') navigate(next, { replace: true });
  }, [isAuthenticated, navigate, staff]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await pingApiHealth();
        if (!cancelled) setApiOk(true);
      } catch {
        if (!cancelled) setApiOk(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await staffLogin(account, password);
      if (result.status === 'success' && result.data) {
        login(result.data.token, result.data.staff);
        const next = getDefaultStaffPath(result.data.staff);
        if (next === '/staff/login') {
          setError('此帳號尚未分配可用模組權限，請洽總部');
          return;
        }
        toast(`歡迎，${result.data.staff.name}`, 'success');
        navigate(next, { replace: true });
      } else {
        setError(result.message || '登入失敗');
      }
    } catch (err) {
      setApiOk(false);
      setError(getErrorMessage(err, '無法連接登入服務'));
    } finally {
      setLoading(false);
    }
  }

  async function recheckApi() {
    setApiOk(null);
    try {
      await pingApiHealth();
      setApiOk(true);
      toast('API 連線正常', 'success');
    } catch (err) {
      setApiOk(false);
      setError(getErrorMessage(err, '無法連接登入服務'));
    }
  }

  return (
    <LandingLayout>
      <div className="auth-page">
        <Card className="auth-card" variant="elevated" padding="md">
          <div className="auth-card__hero">
            <h2>員工登入</h2>
            <p>STAFF / DUTY / MANAGER / ADMIN · 交易異動限 DUTY 以上</p>
          </div>

          {apiOk === false ? (
            <Alert tone="error">
              <strong>無法連到後端 API</strong>
              <div className="text-sm" style={{ marginTop: 6 }}>
                請確認電腦已執行 <code className="mono">npm run dev:api</code> 與{' '}
                <code className="mono">npm run dev:web</code>。手機請用區網 IP 開啟（例如{' '}
                <code className="mono">https://192.168.x.x:5173</code>
                ），不要用 localhost；先在瀏覽器開啟{' '}
                <a href="/api/health">/api/health</a> 並信任憑證後再登入。
              </div>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <Button size="sm" variant="secondary" type="button" onClick={() => void recheckApi()}>
                  重新檢測
                </Button>
              </div>
            </Alert>
          ) : null}

          {apiOk === true ? (
            <p className="text-sm text-muted text-center" style={{ marginTop: 0 }}>
              API 連線正常
            </p>
          ) : null}

          <form onSubmit={handleSubmit} className="form-stack">
            <Field label="帳號">
              <Input
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                required
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
              />
            </Field>
            <Field label="密碼">
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </Field>
            <Button type="submit" size="lg" loading={loading} className="w-full">
              登入後台
            </Button>
          </form>

          {error && (
            <Alert tone="error" onDismiss={() => setError('')}>
              {error}
            </Alert>
          )}

          <p className="text-center mt-md">
            <Link to="/portal">← 返回系統入口</Link>
          </p>
        </Card>
      </div>
    </LandingLayout>
  );
}
