import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import LandingLayout from '../../components/layout/LandingLayout';
import SignaturePad from '../../components/staff/SignaturePad';
import { Alert, Button, Card, Field, Input, Modal } from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  bindMemberDevice,
  exchangeLineCode,
  getErrorMessage,
  getLineLoginUrl,
  onboardingBindDevice,
  onboardingLineLoginUrl,
  onboardingLookup,
  onboardingOpenContract,
  onboardingRegister,
  onboardingBranches,
  onboardingSendOtp,
  onboardingSetFacePreference,
  onboardingSignContract,
  onboardingStatus,
  onboardingVerifyOtp,
  type OnboardingStatus,
} from '../../lib/api';
import {
  clearOnboardingToken,
  getMemberToken,
  getOrCreateDeviceId,
  setOnboardingToken,
} from '../../lib/storage';
import type { MemberContractSignature } from '../../types/api';

type Step =
  | 'phone'
  | 'otp'
  | 'register'
  | 'face-choice'
  | 'contracts'
  | 'bind-line'
  | 'bind-device'
  | 'done';

function readLoginErrorFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('login_error');
  return raw ? decodeURIComponent(raw) : '';
}

function applyStatus(status: OnboardingStatus): Step {
  switch (status.nextStep) {
    case 'REGISTER_PROFILE':
      return 'register';
    case 'CHOOSE_FACE':
      return 'face-choice';
    case 'SIGN_CONTRACTS':
      return 'contracts';
    case 'BIND_LINE':
      return 'bind-line';
    case 'BIND_DEVICE':
      return 'bind-device';
    case 'DONE':
      return 'done';
    default:
      return 'phone';
  }
}

export default function MemberLoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { isAuthenticated, login } = useMemberAuth();
  const { toast } = useToast();

  const token = params.get('token');
  const code = params.get('code');
  const oauthState = params.get('state');
  const needDevice = params.get('needDevice') === '1';
  const hasLoginErrorParam = Boolean(params.get('login_error'));

  const [error, setError] = useState(readLoginErrorFromUrl);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>(() =>
    new URLSearchParams(window.location.search).get('needDevice') === '1'
      ? 'bind-device'
      : 'phone',
  );
  const [phone, setPhone] = useState('');
  const [lookupHint, setLookupHint] = useState<{
    exists: boolean;
    maskedName: string | null;
  } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [devCode, setDevCode] = useState('');
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  const [regName, setRegName] = useState('');
  const [regEmergency, setRegEmergency] = useState('');
  const [regEmergencyPhone, setRegEmergencyPhone] = useState('');
  /** null = 尚未選擇；true/false = 是否使用生物辨識 */
  const [regFaceEnabled, setRegFaceEnabled] = useState<boolean | null>(null);
  const [regBranchId, setRegBranchId] = useState<number | null>(null);
  const [registerBranches, setRegisterBranches] = useState<{ id: number; name: string }[]>([]);
  const [loginFaceEnabled, setLoginFaceEnabled] = useState<boolean | null>(null);

  const [signTarget, setSignTarget] = useState<MemberContractSignature | null>(null);
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const [signBusy, setSignBusy] = useState(false);

  useEffect(() => {
    if (isAuthenticated && !needDevice) navigate('/member', { replace: true });
  }, [isAuthenticated, navigate, needDevice]);

  useEffect(() => {
    if (step !== 'register') return;
    let alive = true;
    void (async () => {
      try {
        const res = await onboardingBranches();
        if (!alive) return;
        if (res.status === 'success' && res.data?.branches) {
          setRegisterBranches(res.data.branches);
        } else {
          setError(res.message || '無法載入可選分店');
        }
      } catch (err) {
        if (alive) setError(getErrorMessage(err, '無法載入可選分店'));
      }
    })();
    return () => {
      alive = false;
    };
  }, [step]);

  useEffect(() => {
    if (hasLoginErrorParam) {
      navigate('/', { replace: true });
      return;
    }

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

    async function finishLineLogin(memberToken: string, opts: { message?: string }) {
      const ok = await ensureDeviceBound(memberToken);
      clearOnboardingToken();
      if (!ok) {
        toast(opts.message || '登入成功，請完成本機裝置綁定', 'success');
        navigate('/?needDevice=1', { replace: true });
        return;
      }
      toast(opts.message || 'LINE 登入成功', 'success');
      navigate('/member', { replace: true });
    }

    if (token) {
      void finishLineLogin(token, { message: '登入成功' });
      return;
    }

    if (!code) return;

    let alive = true;
    void (async () => {
      setBusy(true);
      try {
        const result = await exchangeLineCode(code, oauthState);
        if (result.status === 'success' && result.data?.token) {
          await finishLineLogin(result.data.token, {
            message: result.message || 'LINE 登入成功',
          });
          return;
        }
        if (alive) setError(result.message || 'LINE 登入失敗');
      } catch (err) {
        if (alive) setError(getErrorMessage(err, 'LINE 登入連線失敗'));
      } finally {
        if (alive) setBusy(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [token, code, oauthState, hasLoginErrorParam, login, navigate, toast]);

  function finishWithMemberToken(memberToken: string, message?: string) {
    login(memberToken);
    clearOnboardingToken();
    toast(message || '登入成功', 'success');
    navigate('/member', { replace: true });
  }

  function ingestStatus(data: OnboardingStatus, message?: string) {
    if (data.onboardingToken) setOnboardingToken(data.onboardingToken);
    setStatus(data);
    if (data.token) {
      finishWithMemberToken(data.token, message);
      return;
    }
    setStep(applyStatus(data));
    if (message) toast(message, 'success');
  }

  async function handleLookup(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await onboardingLookup(phone.trim());
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '查詢失敗');
        return;
      }
      setLookupHint({
        exists: res.data.exists,
        maskedName: res.data.maskedName,
      });
      const send = await onboardingSendOtp(phone.trim());
      if (send.status !== 'success') {
        setError(send.message || '無法發送驗證碼');
        return;
      }
      setDevCode(send.data?.devCode || '');
      setOtpCode(send.data?.devCode || '');
      setStep('otp');
      toast(send.message || '驗證碼已發送', 'info');
    } catch (err) {
      setError(getErrorMessage(err, '查詢或發送驗證碼失敗'));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyOtp(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await onboardingVerifyOtp(phone.trim(), otpCode.trim());
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '驗證失敗');
        return;
      }
      ingestStatus(res.data, res.message);
    } catch (err) {
      setError(getErrorMessage(err, '驗證失敗'));
    } finally {
      setBusy(false);
    }
  }

  async function handleResendOtp() {
    setBusy(true);
    setError('');
    try {
      const send = await onboardingSendOtp(phone.trim());
      setDevCode(send.data?.devCode || '');
      toast(send.message || '已重新發送', 'info');
    } catch (err) {
      setError(getErrorMessage(err, '重新發送失敗'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (regFaceEnabled === null) {
      setError('請選擇是否使用生物辨識功能');
      return;
    }
    if (regBranchId == null) {
      setError('請選擇綁定分店');
      return;
    }
    setBusy(true);
    try {
      const res = await onboardingRegister({
        name: regName.trim(),
        emergencyContact: regEmergency.trim(),
        emergencyContactPhone: regEmergencyPhone.trim(),
        faceEnabled: regFaceEnabled,
        branchId: regBranchId,
      });
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '註冊失敗');
        return;
      }
      ingestStatus(res.data, res.message);
    } catch (err) {
      setError(getErrorMessage(err, '註冊失敗'));
    } finally {
      setBusy(false);
    }
  }

  async function handleFacePreference(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (loginFaceEnabled === null) {
      setError('請選擇是否使用生物辨識功能');
      return;
    }
    setBusy(true);
    try {
      const res = await onboardingSetFacePreference(loginFaceEnabled);
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '儲存失敗');
        return;
      }
      ingestStatus(res.data, res.message);
    } catch (err) {
      setError(getErrorMessage(err, '儲存人臉偏好失敗'));
    } finally {
      setBusy(false);
    }
  }

  async function openContract(contractId: number) {
    setSignBusy(true);
    setError('');
    try {
      const res = await onboardingOpenContract(contractId);
      if (res.status === 'success' && res.data?.signature) {
        setSignTarget(res.data.signature);
        setSignatureData(null);
      } else {
        setError(res.message || '無法開啟合約');
      }
    } catch (err) {
      setError(getErrorMessage(err, '開啟合約失敗'));
    } finally {
      setSignBusy(false);
    }
  }

  async function handleSign() {
    if (!signTarget || !signatureData) {
      toast('請先完成簽名', 'error');
      return;
    }
    setSignBusy(true);
    try {
      const res = await onboardingSignContract(signTarget.id, signatureData);
      if (res.status !== 'success' || !res.data) {
        toast(res.message || '簽署失敗', 'error');
        return;
      }
      setSignTarget(null);
      setSignatureData(null);
      ingestStatus(res.data, res.message);
    } catch (err) {
      toast(getErrorMessage(err, '簽署失敗'), 'error');
    } finally {
      setSignBusy(false);
    }
  }

  async function handleBindLine() {
    setBusy(true);
    setError('');
    try {
      const res = await onboardingLineLoginUrl();
      if (res.status === 'success' && res.data?.url) {
        window.location.href = res.data.url;
        return;
      }
      setError(res.message || '無法開啟 LINE 授權');
      setBusy(false);
    } catch (err) {
      setError(getErrorMessage(err, '無法連接 LINE'));
      setBusy(false);
    }
  }

  /** 已綁定 LINE 的會員：一鍵登入（不帶 bind state） */
  async function handleLineLogin() {
    setBusy(true);
    setError('');
    try {
      const res = await getLineLoginUrl();
      if (res.status === 'success' && res.data?.url) {
        window.location.href = res.data.url;
        return;
      }
      setError(res.message || '無法開啟 LINE 登入');
      setBusy(false);
    } catch (err) {
      setError(getErrorMessage(err, '無法連接 LINE'));
      setBusy(false);
    }
  }

  async function handleBindDevice() {
    setBusy(true);
    setError('');
    try {
      const deviceId = getOrCreateDeviceId();
      if (getMemberToken()) {
        const res = await bindMemberDevice(deviceId);
        if (res.status !== 'success') {
          setError(res.message || '綁定裝置失敗');
          return;
        }
        if (res.data?.token) login(res.data.token);
        toast(res.message || '裝置已綁定', 'success');
        navigate('/member', { replace: true });
        return;
      }

      const res = await onboardingBindDevice(deviceId);
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '綁定裝置失敗');
        return;
      }
      ingestStatus(res.data, res.message);
    } catch (err) {
      setError(getErrorMessage(err, '綁定裝置失敗'));
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus() {
    try {
      const res = await onboardingStatus();
      if (res.status === 'success' && res.data) ingestStatus(res.data);
    } catch {
      /* ignore */
    }
  }

  const effectiveStep: Step =
    needDevice && isAuthenticated ? 'bind-device' : step;

  const titleByStep: Record<Step, string> = {
    phone: '會員登入／註冊',
    otp: '手機驗證',
    register: '新會員資料',
    'face-choice': '是否啟用人臉辨識',
    contracts: status?.faceEnabled ? '簽署入會契約與生物辨識同意書' : '簽署會員契約',
    'bind-line': '綁定 LINE（含本機裝置）',
    'bind-device': '完成本機裝置綁定',
    done: '完成',
  };

  const viewStep = effectiveStep;

  return (
    <LandingLayout>
      <div className="auth-page">
        <Card className="auth-card" variant="elevated" padding="md">
          <div className="auth-card__hero">
            <h2>{titleByStep[viewStep]}</h2>
            <p>
              {viewStep === 'phone' && '輸入手機號碼，系統將辨識新舊會員'}
              {viewStep === 'otp' &&
                (lookupHint?.exists
                  ? `歡迎回來，${lookupHint.maskedName || '會員'}，請輸入簡訊驗證碼`
                  : '新會員請輸入簡訊驗證碼以繼續註冊')}
              {viewStep === 'register' && '請填寫資料、選擇綁定分店，並選擇是否使用生物辨識'}
              {viewStep === 'face-choice' &&
                '請選擇是否使用人臉進出場；完成後將簽署必簽會員契約（啟用則另簽生物辨識同意書）'}
              {viewStep === 'contracts' &&
                (status?.faceEnabled
                  ? '請閱讀並電子簽署入會契約與生物辨識同意書'
                  : '請閱讀並電子簽署會員契約書')}
              {viewStep === 'bind-line' &&
                '契約完成後綁定 LINE；授權成功時會一併綁定本機裝置（門禁 QR）'}
              {viewStep === 'bind-device' &&
                'LINE 已綁定，請確認本機裝置以啟用動態門禁 QR（一機一帳）'}
              {viewStep === 'done' && '已完成所有步驟'}
            </p>
          </div>

          {error && (
            <Alert tone="error" onDismiss={() => setError('')}>
              {error}
            </Alert>
          )}

          {viewStep === 'phone' && (
            <form className="form-stack" onSubmit={handleLookup}>
              <Field label="手機號碼" hint="台灣門號 09 開頭 10 碼">
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  inputMode="tel"
                  placeholder="0912345678"
                  required
                  autoComplete="tel"
                />
              </Field>
              <Button type="submit" size="lg" loading={busy} className="w-full">
                下一步
              </Button>
              <div className="auth-divider" role="separator">
                <span>或</span>
              </div>
              <Button
                type="button"
                variant="line"
                size="lg"
                loading={busy}
                className="w-full"
                onClick={() => void handleLineLogin()}
              >
                使用 LINE 登入
              </Button>
              <p className="text-muted text-sm text-center">
                僅限已綁定 LINE 的會員；新客請先以手機註冊
              </p>
            </form>
          )}

          {viewStep === 'otp' && (
            <form className="form-stack" onSubmit={handleVerifyOtp}>
              <Field label="驗證碼" hint={devCode ? `開發模式碼：${devCode}` : '請輸入 6 碼'}>
                <Input
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123456"
                  required
                />
              </Field>
              <Button type="submit" size="lg" loading={busy} className="w-full">
                驗證並繼續
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void handleResendOtp()}
              >
                重新發送驗證碼
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setStep('phone');
                  setOtpCode('');
                  setDevCode('');
                }}
              >
                更改手機號碼
              </Button>
            </form>
          )}

          {viewStep === 'face-choice' && (
            <form className="form-stack" onSubmit={handleFacePreference}>
              <Alert tone="info">
                舊會員需先完成必簽會員契約，並確認是否啟用人臉，才能繼續綁定 LINE／裝置。
              </Alert>
              <fieldset className="form-stack" style={{ border: 'none', margin: 0, padding: 0 }}>
                <legend className="field__label" style={{ marginBottom: '0.35rem' }}>
                  是否使用生物辨識功能（人臉進出場）
                </legend>
                <label
                  className="field"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}
                >
                  <input
                    type="radio"
                    name="loginFaceEnabled"
                    checked={loginFaceEnabled === true}
                    onChange={() => setLoginFaceEnabled(true)}
                  />
                  <span>是，我要使用人臉辨識（須加簽生物辨識同意書）</span>
                </label>
                <label
                  className="field"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}
                >
                  <input
                    type="radio"
                    name="loginFaceEnabled"
                    checked={loginFaceEnabled === false}
                    onChange={() => setLoginFaceEnabled(false)}
                  />
                  <span>否，暫不使用（之後可於櫃檯啟用）</span>
                </label>
              </fieldset>
              <Button type="submit" size="lg" loading={busy} className="w-full">
                確認並繼續簽署契約
              </Button>
            </form>
          )}

          {viewStep === 'register' && (
            <form className="form-stack" onSubmit={handleRegister}>
              <Field label="姓名">
                <Input value={regName} onChange={(e) => setRegName(e.target.value)} required />
              </Field>
              <Field label="手機（已驗證）">
                <Input value={phone} readOnly disabled />
              </Field>
              <Field label="緊急聯絡人">
                <Input
                  value={regEmergency}
                  onChange={(e) => setRegEmergency(e.target.value)}
                  required
                />
              </Field>
              <Field label="緊急聯絡人電話">
                <Input
                  value={regEmergencyPhone}
                  onChange={(e) => setRegEmergencyPhone(e.target.value)}
                  inputMode="tel"
                  placeholder="0912345678"
                  required
                />
              </Field>
              <fieldset className="form-stack" style={{ border: 'none', margin: 0, padding: 0 }}>
                <legend className="field__label" style={{ marginBottom: '0.35rem' }}>
                  綁定分店（必選）
                </legend>
                {registerBranches.length === 0 ? (
                  <Alert tone="warning">尚無可選分店，請稍後再試或洽櫃檯</Alert>
                ) : (
                  registerBranches.map((b) => (
                    <label
                      key={b.id}
                      className="field"
                      style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}
                    >
                      <input
                        type="radio"
                        name="regBranchId"
                        checked={regBranchId === b.id}
                        onChange={() => setRegBranchId(b.id)}
                      />
                      <span>{b.name}</span>
                    </label>
                  ))
                )}
              </fieldset>
              <fieldset className="form-stack" style={{ border: 'none', margin: 0, padding: 0 }}>
                <legend className="field__label" style={{ marginBottom: '0.35rem' }}>
                  是否使用生物辨識功能（人臉進出場）
                </legend>
                <label
                  className="field"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}
                >
                  <input
                    type="radio"
                    name="faceEnabled"
                    checked={regFaceEnabled === true}
                    onChange={() => setRegFaceEnabled(true)}
                  />
                  <span>是，我要使用人臉辨識（須加簽生物辨識同意書）</span>
                </label>
                <label
                  className="field"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}
                >
                  <input
                    type="radio"
                    name="faceEnabled"
                    checked={regFaceEnabled === false}
                    onChange={() => setRegFaceEnabled(false)}
                  />
                  <span>否，暫不使用（之後可於櫃檯啟用）</span>
                </label>
              </fieldset>
              <Button type="submit" size="lg" loading={busy} className="w-full">
                儲存並簽署契約
              </Button>
            </form>
          )}

          {viewStep === 'contracts' && (
            <div className="form-stack">
              {status?.faceEnabled && (
                <Alert tone="info">
                  您已選擇使用生物辨識，請一併完成「生物辨識同意書」簽署後，才能於櫃檯綁定人臉。
                </Alert>
              )}
              {(status?.contracts || []).length === 0 ? (
                <Alert tone="warning">
                  {status?.missingNewMemberContract !== false
                    ? '尚未設定「新會員」入會契約，請洽總部於「合約」建立用途為「新會員入會」的契約後再繼續。完成簽署後才能綁定 LINE。'
                    : '尚無待簽契約，請重新整理狀態。'}
                  <Button className="mt-md" variant="secondary" onClick={() => void refreshStatus()}>
                    重新整理狀態
                  </Button>
                </Alert>
              ) : (
                (status?.contracts || []).map((c) => (
                  <div
                    key={c.contractId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '0.75rem',
                      alignItems: 'center',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.75rem',
                    }}
                  >
                    <div>
                      <strong>{c.title || c.displayName}</strong>
                      <div className="text-muted text-sm">
                        {c.isBiometrics ? '生物辨識 · ' : ''}
                        {c.versionLabel || ''} · {c.signed ? '已簽署' : '待簽署'}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={c.signed ? 'ghost' : 'primary'}
                      disabled={c.signed || signBusy}
                      onClick={() => void openContract(c.contractId)}
                    >
                      {c.signed ? '已完成' : '簽署'}
                    </Button>
                  </div>
                ))
              )}
              <Button type="button" variant="ghost" onClick={() => void refreshStatus()}>
                重新整理狀態
              </Button>
            </div>
          )}

          {viewStep === 'bind-line' && (
            <div className="form-stack">
              <Alert tone="info">
                綁定 LINE 即完成會員身分與本機裝置綁定（門禁 QR 一機一帳）。完成後可用「使用
                LINE 登入」快速進入。
              </Alert>
              <Button
                variant="line"
                size="lg"
                loading={busy}
                className="w-full"
                onClick={() => void handleBindLine()}
              >
                綁定 LINE（含本機裝置）
              </Button>
            </div>
          )}

          {viewStep === 'bind-device' && (
            <div className="form-stack">
              <Alert tone="info">
                裝置碼將寫入本機，用於產生動態門禁 QR。須先完成 LINE
                綁定；若尚未綁定請改走「綁定 LINE」。
              </Alert>
              <Button
                size="lg"
                loading={busy}
                className="w-full"
                onClick={() => void handleBindDevice()}
              >
                綁定此裝置並進入會員中心
              </Button>
              {!getMemberToken() && (
                <Button
                  type="button"
                  variant="line"
                  disabled={busy}
                  onClick={() => setStep('bind-line')}
                >
                  改為綁定 LINE
                </Button>
              )}
            </div>
          )}

        </Card>
      </div>

      <Modal
        open={signTarget !== null}
        title={
          signTarget
            ? `簽署 · ${signTarget.contractTitle || signTarget.contractDisplayName || ''}`
            : '簽署'
        }
        onClose={() => {
          setSignTarget(null);
          setSignatureData(null);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setSignTarget(null);
                setSignatureData(null);
              }}
              disabled={signBusy}
            >
              取消
            </Button>
            <Button onClick={() => void handleSign()} loading={signBusy}>
              完成簽署
            </Button>
          </>
        }
      >
        {signTarget && (
          <div className="form-stack">
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                margin: 0,
                fontFamily: 'inherit',
                fontSize: '0.85rem',
                maxHeight: 240,
                overflow: 'auto',
                background: 'var(--surface-2, #f8fafc)',
                padding: '0.75rem',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {signTarget.body || '（無內容）'}
            </pre>
            <div className="field">
              <span className="field__label">電子簽名</span>
              <SignaturePad key={signTarget.id} onChange={setSignatureData} />
            </div>
          </div>
        )}
      </Modal>
    </LandingLayout>
  );
}
