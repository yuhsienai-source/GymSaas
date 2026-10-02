import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, PageSection } from '../../components/ui';
import { bindMyLine, getErrorMessage } from '../../lib/api';

type Result = { tone: 'success' | 'error'; message: string } | null;

/** LINE Login 回流（員工推播綁定）：code／state 以員工 JWT 送後端驗證，完成後清除網址參數 */
export default function StaffLineCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [callback] = useState(() => ({
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
  }));
  const valid = !callback.error && !!callback.code && !!callback.state;
  const [result, setResult] = useState<Result>(() =>
    valid
      ? null
      : { tone: 'error', message: callback.error === 'access_denied' ? '已取消 LINE 授權' : 'LINE 授權失敗，請重新綁定' },
  );
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    navigate('/staff/line/callback', { replace: true });
    if (!callback.code || !callback.state || callback.error) return;
    bindMyLine({ code: callback.code, state: callback.state })
      .then((res) => setResult({ tone: 'success', message: res.message || '已綁定 LINE 推播' }))
      .catch((err) => setResult({ tone: 'error', message: getErrorMessage(err, 'LINE 綁定失敗') }));
  }, [callback, navigate]);

  return (
    <PageSection title="LINE 推播綁定">
      <Card>
        {result ? <Alert tone={result.tone}>{result.message}</Alert> : <p className="text-muted">綁定中…</p>}
        <Button onClick={() => navigate('/staff/my-attendance', { replace: true })} disabled={!result}>
          回到我的出勤
        </Button>
      </Card>
    </PageSection>
  );
}
