import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import BrandMark from '../../components/BrandMark';
import LandingLayout from '../../components/layout/LandingLayout';
import MemberIdPhotoCamera from '../../components/member/MemberIdPhotoCamera';
import SignaturePad from '../../components/staff/SignaturePad';
import { Alert, Button, Card, Field, Input, Modal } from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  bindMemberDevice,
  exchangeLineCode,
  getDeviceResetRequiredPayload,
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
  onboardingEmailEnrollRequest,
  onboardingEmailEnrollVerify,
  onboardingUploadIdPhoto,
  requestDeviceResetEmail,
  verifyDeviceResetEmail,
  type OnboardingStatus,
} from '../../lib/api';
import {
  clearOnboardingToken,
  getMemberToken,
  getOrCreateDeviceId,
  setOnboardingToken,
} from '../../lib/storage';
import {
  clearDeviceResetSession,
  readDeviceResetSession,
  stashDeviceResetSession,
} from '../../lib/deviceResetSession';
import type { MemberContractSignature } from '../../types/api';

type Step =
  | 'email'
  | 'otp'
  | 'email-enroll'
  | 'register'
  | 'face-choice'
  | 'contracts'
  | 'id-photos'
  | 'bind-line'
  | 'bind-device'
  | 'device-reset'
  | 'done';

const OTP_COOLDOWN_SEC = 60;

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
    case 'UPLOAD_ID_PHOTOS':
      return 'id-photos';
    case 'BIND_LINE':
      return 'bind-line';
    case 'BIND_DEVICE':
      return 'bind-device';
    case 'DONE':
      return 'done';
    default:
      return 'email';
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
  const busyRef = useRef(false);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const [step, setStep] = useState<Step>(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('deviceReset') === '1' || readDeviceResetSession()) return 'device-reset';
    if (q.get('needDevice') === '1') return 'bind-device';
    return 'email';
  });
  const stepRef = useRef(step);
  stepRef.current = step;
  const stepHistoryRef = useRef<Step[]>([]);

  function advanceStep(next: Step) {
    const cur = stepRef.current;
    if (cur !== next) stepHistoryRef.current.push(cur);
    setStep(next);
  }

  function resetToEmailEntry() {
    stepHistoryRef.current = [];
    resetToEmailEntry();
  }

  function goBackStep() {
    setError('');
    const prev = stepHistoryRef.current.pop();
    if (!prev || prev === 'done') {
      resetToEmailEntry();
      return;
    }
    setStep(prev);
  }
  const [email, setEmail] = useState('');
  /** 入口主鍵：手機＋證件號 */
  const [entryPhone, setEntryPhone] = useState('');
  const [entryIdNumber, setEntryIdNumber] = useState('');
  /** 新客辨識後須先填 Email 驗證 */
  const [needsEmailCapture, setNeedsEmailCapture] = useState(false);
  /** lookup 後用來寄／驗 OTP 的 Email（舊會員檔案 Email 或新客剛填） */
  const [otpIdentity, setOtpIdentity] = useState('');
  const [lookupHint, setLookupHint] = useState<{
    exists: boolean;
    maskedName: string | null;
    hint?: string;
    canSendOtp?: boolean;
    canEmailEnroll?: boolean;
    needsEmail?: boolean;
    maskedEmail?: string | null;
    maskedPhone?: string | null;
    registrationComplete?: boolean;
    nextStepHint?: string | null;
  } | null>(null);
  const [lookupDone, setLookupDone] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [devCode, setDevCode] = useState('');
  const [status, setStatus] = useState<OnboardingStatus | null>(null);

  /** 舊會員 Email 補登 */
  const [enrollPhone, setEnrollPhone] = useState('');
  const [enrollIdNumber, setEnrollIdNumber] = useState('');
  const [enrollEmail, setEnrollEmail] = useState('');
  const [enrollOtpSent, setEnrollOtpSent] = useState(false);
  const [enrollMaskedEmail, setEnrollMaskedEmail] = useState('');
  const [enrollOtp, setEnrollOtp] = useState('');
  const [enrollCooldown, setEnrollCooldown] = useState(0);

  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regIdNumber, setRegIdNumber] = useState('');
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
  /** 入口：會員登入｜查詢／註冊 */
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  /** 登入分頁：展開 Email 登入表單 */
  const [showLoginEmail, setShowLoginEmail] = useState(false);

  /** 註冊必傳證件正／反面 */
  const [idPhotoConsent, setIdPhotoConsent] = useState(false);
  const [idPhotoFrontReady, setIdPhotoFrontReady] = useState(false);
  const [idPhotoBackReady, setIdPhotoBackReady] = useState(false);
  const [idPhotoBusySide, setIdPhotoBusySide] = useState<'front' | 'back' | null>(null);

  /** 換機：身分＋Email → OTP */
  const resetSession = readDeviceResetSession();
  const [resetIdentity, setResetIdentity] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [resetOtp, setResetOtp] = useState('');
  const [resetTicket, setResetTicket] = useState(resetSession?.resetTicket || '');
  const [resetMaskedEmail, setResetMaskedEmail] = useState(resetSession?.maskedEmail || '');
  const [resetOtpSent, setResetOtpSent] = useState(Boolean(resetSession?.resetTicket));
  const [resetCooldown, setResetCooldown] = useState(0);
  const [legalDoc, setLegalDoc] = useState<null | 'rights' | 'privacy'>(null);

  useEffect(() => {
    if (isAuthenticated && !needDevice) navigate('/member', { replace: true });
  }, [isAuthenticated, navigate, needDevice]);

  useEffect(() => {
    if (otpCooldown <= 0) return;
    const timer = window.setTimeout(() => setOtpCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [otpCooldown]);

  useEffect(() => {
    if (enrollCooldown <= 0) return;
    const timer = window.setTimeout(() => setEnrollCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [enrollCooldown]);

  useEffect(() => {
    if (resetCooldown <= 0) return;
    const timer = window.setTimeout(() => setResetCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resetCooldown]);

  async function runExclusive<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

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

    if (!token && !code) return;

    let cancelled = false;
    const finishing = { current: false };

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
      } catch (err) {
        const reset = getDeviceResetRequiredPayload(err);
        if (reset) throw err;
        return false;
      }
    }

    async function finishLineLogin(memberToken: string, opts: { message?: string }) {
      if (finishing.current) return;
      finishing.current = true;
      try {
        const ok = await ensureDeviceBound(memberToken);
        clearOnboardingToken();
        // 已換得 token 後一律導向，勿因 Strict Mode cleanup 放棄
        if (!ok) {
          toast(opts.message || '登入成功，請完成本機裝置綁定', 'success');
          navigate('/?needDevice=1', { replace: true });
          return;
        }
        toast(opts.message || 'LINE 登入成功', 'success');
        navigate('/member', { replace: true });
      } catch (err) {
        finishing.current = false;
        const reset = getDeviceResetRequiredPayload(err);
        if (reset) {
          stashDeviceResetSession({
            resetTicket: reset.resetTicket,
            maskedEmail: reset.maskedEmail,
          });
          advanceStep('device-reset');
          setError(reset.message);
          return;
        }
        if (!cancelled) setError(getErrorMessage(err, '完成登入失敗'));
      }
    }

    void (async () => {
      setBusy(true);
      try {
        if (token) {
          await finishLineLogin(token, { message: '登入成功' });
          return;
        }
        const result = await exchangeLineCode(code!, oauthState);
        if (result.status === 'success' && result.data?.token) {
          await finishLineLogin(result.data.token, {
            message: result.message || 'LINE 登入成功',
          });
          return;
        }
        if (!cancelled) setError(result.message || 'LINE 登入失敗');
      } catch (err) {
        const reset = getDeviceResetRequiredPayload(err);
        if (reset) {
          stashDeviceResetSession({
            resetTicket: reset.resetTicket,
            maskedEmail: reset.maskedEmail,
          });
          setResetTicket(reset.resetTicket);
          setResetMaskedEmail(reset.maskedEmail || '');
          advanceStep('device-reset');
          setError(reset.message);
          return;
        }
        if (!cancelled) setError(getErrorMessage(err, 'LINE 登入連線失敗'));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
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
    if (data.idPhotosReady) {
      setIdPhotoFrontReady(true);
      setIdPhotoBackReady(true);
    }
    if (data.token) {
      finishWithMemberToken(data.token, message);
      return;
    }
    advanceStep(applyStatus(data));
    if (message) toast(message, 'success');
  }

  async function handleUploadIdPhotoDataUrl(side: 'front' | 'back', dataUrl: string) {
    if (!idPhotoConsent) {
      setError('請先勾選同意證件蒐集告知');
      return;
    }
    setError('');
    setIdPhotoBusySide(side);
    try {
      const res = await onboardingUploadIdPhoto(dataUrl, side, { consent: true });
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '上傳失敗');
        return;
      }
      if (side === 'front') setIdPhotoFrontReady(true);
      else setIdPhotoBackReady(true);
      ingestStatus(res.data, res.message);
    } catch (err) {
      setError(getErrorMessage(err, '上傳證件失敗'));
    } finally {
      setIdPhotoBusySide(null);
    }
  }

  async function handleEmailLogin(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLookupDone(false);
    await runExclusive(async () => {
      const mail = email.trim();
      if (!mail || !mail.includes('@')) {
        setError('請輸入登記 Email');
        return;
      }
      const res = await onboardingLookup({ identity: mail });
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '查詢失敗');
        return;
      }

      const exists = Boolean(res.data.exists);
      const incomplete = exists && res.data.registrationComplete === false;

      setLookupHint({
        exists,
        maskedName: res.data.maskedName,
        hint: res.data.hint,
        canSendOtp: res.data.canSendOtp,
        canEmailEnroll: res.data.canEmailEnroll,
        needsEmail: res.data.needsEmail,
        maskedEmail: res.data.maskedEmail,
        maskedPhone: res.data.maskedPhone,
        registrationComplete: res.data.registrationComplete,
        nextStepHint: res.data.nextStepHint,
      });
      setLookupDone(true);

      if (!exists) {
        setError('查無此 Email 會員，請改「查詢／註冊」以手機＋證件開始');
        return;
      }

      if (incomplete) {
        setAuthMode('register');
      } else {
        setAuthMode('login');
      }

      if (res.data.canEmailEnroll) {
        setError('此帳號尚未綁定 Email，請改「查詢／註冊」以手機＋證件補登');
        return;
      }

      if (!res.data.canSendOtp || !res.data.otpEmail) {
        setError(res.data.hint || '無法寄送驗證碼，請洽櫃檯');
        return;
      }

      const otpKey = res.data.otpEmail;
      setOtpIdentity(otpKey);
      setEmail(otpKey);

      const send = await onboardingSendOtp(otpKey);
      if (send.status !== 'success') {
        setError(send.message || '無法發送驗證碼');
        return;
      }
      setDevCode(send.data?.devCode || '');
      setOtpCode(send.data?.devCode || '');
      setOtpCooldown(OTP_COOLDOWN_SEC);
      advanceStep('otp');
      toast(
        incomplete
          ? '驗證碼已寄出，請完成驗證後繼續註冊資料'
          : send.message || '驗證碼已寄出',
        'success',
      );
    }).catch((err) => {
      setError(getErrorMessage(err, 'Email 登入失敗'));
    });
  }

  async function handleLookup(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLookupDone(false);
    await runExclusive(async () => {
      const phone = entryPhone.trim();
      const idNumber = entryIdNumber.trim();
      if (!phone || !idNumber) {
        setError('請輸入手機號碼與證件號碼');
        return;
      }

      // 新客已辨識、補填 Email 後寄碼
      if (needsEmailCapture) {
        const mail = email.trim();
        if (!mail || !mail.includes('@')) {
          setError('請輸入有效 Email 以完成綁定驗證');
          return;
        }
        setOtpIdentity(mail);
        const send = await onboardingSendOtp(mail);
        if (send.status !== 'success') {
          setError(send.message || '無法發送驗證碼');
          return;
        }
        setDevCode(send.data?.devCode || '');
        setOtpCode(send.data?.devCode || '');
        setOtpCooldown(OTP_COOLDOWN_SEC);
        setRegPhone(phone);
        setRegIdNumber(idNumber.toUpperCase());
        advanceStep('otp');
        toast(send.message || '驗證碼已寄出', 'success');
        return;
      }

      const res = await onboardingLookup({ phone, idNumber });
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '查詢失敗');
        return;
      }

      const exists = Boolean(res.data.exists);
      const incomplete = exists && res.data.registrationComplete === false;
      const complete = exists && res.data.registrationComplete === true;

      const effectiveMode: 'login' | 'register' =
        res.data.suggestedAuthMode === 'login' || res.data.suggestedAuthMode === 'register'
          ? res.data.suggestedAuthMode
          : incomplete
            ? 'register'
            : complete
              ? 'login'
              : !exists
                ? 'register'
                : authMode;

      if (effectiveMode !== authMode) {
        setAuthMode(effectiveMode);
      }

      setLookupHint({
        exists,
        maskedName: res.data.maskedName,
        hint: res.data.hint,
        canSendOtp: res.data.canSendOtp,
        canEmailEnroll: res.data.canEmailEnroll,
        needsEmail: res.data.needsEmail,
        maskedEmail: res.data.maskedEmail,
        maskedPhone: res.data.maskedPhone,
        registrationComplete: res.data.registrationComplete,
        nextStepHint: res.data.nextStepHint,
      });
      setLookupDone(true);
      setRegPhone(res.data.phone || phone);
      setRegIdNumber(idNumber.toUpperCase());

      // 登入意圖但查無帳號：切註冊並要求 Email
      if (!exists && res.data.needsEmail) {
        setAuthMode('register');
        setNeedsEmailCapture(true);
        toast(res.data.hint || '請先綁定並驗證 Email', 'info');
        return;
      }

      if (complete && authMode === 'register' && !res.data.needsEmail) {
        setAuthMode('login');
      }

      // 無 Email → 補登（證件已於入口核對，預填）
      if (res.data.canEmailEnroll) {
        setEnrollPhone(res.data.enrollPhone || phone);
        setEnrollIdNumber(idNumber.toUpperCase());
        setEnrollEmail('');
        setEnrollOtpSent(false);
        setEnrollOtp('');
        setEnrollMaskedEmail('');
        setDevCode('');
        advanceStep('email-enroll');
        toast(res.data.hint || '請補登並驗證 Email', 'info');
        return;
      }

      if (!res.data.canSendOtp) {
        return;
      }

      const otpKey = res.data.otpEmail || '';
      if (!otpKey) {
        setError('無法取得驗證 Email，請洽櫃檯');
        return;
      }
      setOtpIdentity(otpKey);
      setEmail(otpKey);

      const send = await onboardingSendOtp(otpKey);
      if (send.status !== 'success') {
        setError(send.message || '無法發送驗證碼');
        return;
      }
      setDevCode(send.data?.devCode || '');
      setOtpCode(send.data?.devCode || '');
      setOtpCooldown(OTP_COOLDOWN_SEC);
      advanceStep('otp');
      toast(
        incomplete
          ? '驗證碼已寄出，請完成驗證後繼續註冊資料'
          : send.message || '驗證碼已寄出',
        'success',
      );
    }).catch((err) => {
      setError(getErrorMessage(err, '查詢失敗'));
    });
  }

  async function handleVerifyOtp(e: FormEvent) {
    e.preventDefault();
    setError('');
    await runExclusive(async () => {
      const key = otpIdentity.trim() || email.trim();
      const res = await onboardingVerifyOtp(key, otpCode.trim());
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '驗證失敗');
        return;
      }
      ingestStatus(res.data, res.message);
    }).catch((err) => {
      setError(getErrorMessage(err, '驗證失敗'));
    });
  }

  async function handleRequestEmailEnroll(e?: FormEvent) {
    e?.preventDefault();
    setError('');
    await runExclusive(async () => {
      const res = await onboardingEmailEnrollRequest({
        phone: enrollPhone.trim(),
        idNumber: enrollIdNumber.trim(),
        email: enrollEmail.trim(),
      });
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '無法寄送驗證信');
        return;
      }
      setEnrollOtpSent(true);
      setEnrollMaskedEmail(res.data.maskedEmail || '');
      setDevCode(res.data.devCode || '');
      setEnrollOtp(res.data.devCode || '');
      setEnrollCooldown(OTP_COOLDOWN_SEC);
      setOtpIdentity(res.data.otpEmail || enrollEmail.trim());
      toast(res.message || '驗證碼已發送', 'info');
    }).catch((err) => {
      setError(getErrorMessage(err, '無法寄送 Email 補登驗證信'));
    });
  }

  async function handleVerifyEmailEnroll(e: FormEvent) {
    e.preventDefault();
    setError('');
    await runExclusive(async () => {
      const res = await onboardingEmailEnrollVerify({
        phone: enrollPhone.trim(),
        idNumber: enrollIdNumber.trim(),
        email: enrollEmail.trim(),
        code: enrollOtp.trim(),
      });
      if (res.status !== 'success' || !res.data) {
        setError(res.message || 'Email 補登驗證失敗');
        return;
      }
      ingestStatus(res.data, res.message || 'Email 補登成功，請繼續完成註冊');
    }).catch((err) => {
      setError(getErrorMessage(err, 'Email 補登驗證失敗'));
    });
  }

  async function handleResendOtp() {
    if (otpCooldown > 0 || busyRef.current) return;
    setError('');
    await runExclusive(async () => {
      const key = otpIdentity.trim() || email.trim();
      const send = await onboardingSendOtp(key);
      if (send.status !== 'success') {
        setError(send.message || '重新發送失敗');
        return;
      }
      setDevCode(send.data?.devCode || '');
      setOtpCooldown(OTP_COOLDOWN_SEC);
      toast(send.message || '已重新發送', 'info');
    }).catch((err) => {
      setError(getErrorMessage(err, '重新發送失敗'));
    });
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
    if (!regPhone.trim() || !regIdNumber.trim()) {
      setError('手機號碼與證件號為必填（證件號可為身分證／居留證／護照）');
      return;
    }
    await runExclusive(async () => {
      const res = await onboardingRegister({
        name: regName.trim(),
        phone: regPhone.trim(),
        idNumber: regIdNumber.trim(),
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
    }).catch((err) => {
      setError(getErrorMessage(err, '註冊失敗'));
    });
  }

  async function handleFacePreference(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (loginFaceEnabled === null) {
      setError('請選擇是否使用生物辨識功能');
      return;
    }
    await runExclusive(async () => {
      const res = await onboardingSetFacePreference(loginFaceEnabled);
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '儲存失敗');
        return;
      }
      ingestStatus(res.data, res.message);
    }).catch((err) => {
      setError(getErrorMessage(err, '儲存人臉偏好失敗'));
    });
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
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const res = await onboardingLineLoginUrl();
      if (res.status === 'success' && res.data?.url) {
        window.location.assign(res.data.url);
        return;
      }
      setError(res.message || '無法開啟 LINE 授權');
      busyRef.current = false;
      setBusy(false);
    } catch (err) {
      setError(getErrorMessage(err, '無法連接 LINE'));
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** 已綁定 LINE 的會員：一鍵登入（不帶 bind state） */
  async function handleLineLogin() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const res = await getLineLoginUrl();
      if (res.status === 'success' && res.data?.url) {
        window.location.assign(res.data.url);
        return;
      }
      setError(res.message || '無法開啟 LINE 登入');
      busyRef.current = false;
      setBusy(false);
    } catch (err) {
      setError(getErrorMessage(err, '無法連接 LINE'));
      busyRef.current = false;
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

  async function handleRequestDeviceResetEmail(e?: FormEvent) {
    e?.preventDefault();
    setError('');
    await runExclusive(async () => {
      const res = await requestDeviceResetEmail({
        identity: resetIdentity.trim(),
        email: resetEmail.trim(),
        resetTicket: resetTicket || undefined,
      });
      if (res.status !== 'success' || !res.data) {
        setError(res.message || '無法寄送驗證信');
        return;
      }
      setResetTicket(res.data.resetTicket);
      setResetMaskedEmail(res.data.maskedEmail);
      setResetOtpSent(true);
      setResetCooldown(OTP_COOLDOWN_SEC);
      stashDeviceResetSession({
        resetTicket: res.data.resetTicket,
        maskedEmail: res.data.maskedEmail,
      });
      toast(res.message || '驗證碼已寄出', 'success');
    }).catch((err) => {
      setError(getErrorMessage(err, '無法寄送驗證信'));
    });
  }

  async function handleVerifyDeviceResetEmail(e: FormEvent) {
    e.preventDefault();
    setError('');
    await runExclusive(async () => {
      const res = await verifyDeviceResetEmail({
        identity: resetIdentity.trim(),
        email: resetEmail.trim(),
        otpCode: resetOtp.trim(),
        resetTicket: resetTicket || undefined,
      });
      if (res.status !== 'success' || !res.data?.token) {
        setError(res.message || '換機驗證失敗');
        return;
      }
      clearDeviceResetSession();
      finishWithMemberToken(res.data.token, res.message || '換機成功');
    }).catch((err) => {
      setError(getErrorMessage(err, '換機驗證失敗'));
    });
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
    email: '會員登入／註冊',
    otp: lookupHint?.registrationComplete === false ? '繼續完成註冊' : 'Email 驗證',
    'email-enroll': '補登並驗證 Email',
    register: '新會員資料',
    'face-choice': '是否啟用人臉辨識',
    contracts: status?.faceEnabled ? '簽署入會契約與生物辨識同意書' : '簽署會員契約',
    'id-photos': '拍攝證件正／反面',
    'bind-line': '綁定 LINE（選用）',
    'bind-device': '綁定本機裝置（門禁 QR）',
    'device-reset': '換機驗證',
    done: '完成',
  };

  const viewStep = effectiveStep;

  return (
    <LandingLayout>
      <div className="auth-page">
        <Card className="auth-card member-center-card" variant="elevated" padding="lg">
          {viewStep === 'email' ? (
            <div className="member-center">
              <BrandMark size={72} className="member-center__logo" />
              <p className="member-center__eyebrow">MEMBER CENTER</p>
              <h1 className="member-center__title">會員中心</h1>
              <p className="member-center__lead">
                歡迎來到 1st FITNESS 會員中心。
                {authMode === 'login'
                  ? '已是會員請由此登入。'
                  : ''}
              </p>

              <div className="member-center__segment" role="tablist" aria-label="登入或查詢註冊">
                <button
                  type="button"
                  role="tab"
                  aria-selected={authMode === 'login'}
                  className={`member-center__segment-btn${authMode === 'login' ? ' is-active' : ''}`}
                  onClick={() => {
                    setAuthMode('login');
                    setNeedsEmailCapture(false);
                    setShowLoginEmail(false);
                    setLookupDone(false);
                    setLookupHint(null);
                    setError('');
                  }}
                >
                  會員登入
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={authMode === 'register'}
                  className={`member-center__segment-btn${authMode === 'register' ? ' is-active' : ''}`}
                  onClick={() => {
                    setAuthMode('register');
                    setShowLoginEmail(false);
                    setNeedsEmailCapture(false);
                    setLookupDone(false);
                    setLookupHint(null);
                    setError('');
                  }}
                >
                  查詢／註冊
                </button>
              </div>

              {error && (
                <Alert tone="error" onDismiss={() => setError('')}>
                  {error}
                </Alert>
              )}

              {authMode === 'login' ? (
                <div className="member-center__actions">
                  <p className="member-center__hint">
                    LINE 快速登入僅限已綁定 LINE 的會員；其餘請用 Email 登入。新客請改「查詢／註冊」。
                  </p>
                  <Button
                    type="button"
                    variant="line"
                    size="lg"
                    loading={busy}
                    className="w-full member-center__cta"
                    onClick={() => void handleLineLogin()}
                  >
                    LINE 快速登入
                  </Button>

                  {!showLoginEmail ? (
                    <Button
                      type="button"
                      size="lg"
                      variant="secondary"
                      className="w-full member-center__cta"
                      onClick={() => {
                        setShowLoginEmail(true);
                        setError('');
                      }}
                    >
                      Email 登入
                    </Button>
                  ) : (
                    <form className="form-stack member-center__phone-form" onSubmit={handleEmailLogin}>
                      <Field label="登記 Email" hint="驗證碼將寄至您的登記信箱">
                        <Input
                          type="email"
                          value={email}
                          onChange={(e) => {
                            setEmail(e.target.value);
                            setLookupDone(false);
                            setLookupHint(null);
                          }}
                          placeholder="you@example.com"
                          required
                          autoComplete="email"
                          autoFocus
                        />
                      </Field>
                      {lookupDone && lookupHint?.hint && (
                        <Alert tone={lookupHint.registrationComplete === false ? 'warning' : 'info'}>
                          {lookupHint.hint}
                        </Alert>
                      )}
                      <Button type="submit" size="lg" loading={busy} className="w-full member-center__cta">
                        寄送驗證碼
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setShowLoginEmail(false);
                          setLookupDone(false);
                          setLookupHint(null);
                        }}
                      >
                        收合 Email 登入
                      </Button>
                    </form>
                  )}

                  <p className="member-center__legal">
                    點擊登入即同意
                    <button type="button" className="member-center__link" onClick={() => setLegalDoc('rights')}>
                      會員權益
                    </button>
                    及
                    <button type="button" className="member-center__link" onClick={() => setLegalDoc('privacy')}>
                      隱私權宣告
                    </button>
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      setError('');
                      advanceStep('device-reset');
                    }}
                  >
                    換機／新裝置驗證（Email）
                  </Button>
                </div>
              ) : (
                <form className="form-stack member-center__phone-form" onSubmit={handleLookup}>
                  <p className="member-center__hint">
                  請輸入手機與證件號查詢；系統將辨識新舊會員。
                  </p>
                  <Field label="手機號碼" hint="台灣 09 開頭，或含國碼國際門號">
                    <Input
                      type="tel"
                      value={entryPhone}
                      onChange={(e) => {
                        setEntryPhone(e.target.value);
                        setNeedsEmailCapture(false);
                        setLookupDone(false);
                        setLookupHint(null);
                      }}
                      placeholder="0912345678 或 +8190…"
                      required
                      autoComplete="tel"
                      inputMode="tel"
                      autoFocus
                      readOnly={needsEmailCapture}
                    />
                  </Field>
                  <Field label="證件號碼" hint="身分證／居留證／護照／國籍證件">
                    <Input
                      value={entryIdNumber}
                      onChange={(e) => {
                        setEntryIdNumber(e.target.value.toUpperCase());
                        setNeedsEmailCapture(false);
                        setLookupDone(false);
                        setLookupHint(null);
                      }}
                      placeholder="A123456789 或護照／國籍證件號"
                      required
                      autoComplete="off"
                      readOnly={needsEmailCapture}
                    />
                  </Field>

                  {needsEmailCapture && (
                    <Field
                      label="Email（綁定並驗證）"
                      hint="新客或未登記 Email 須先完成驗證；驗證碼將寄至此信箱"
                    >
                      <Input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        required
                        autoComplete="email"
                        autoFocus
                      />
                    </Field>
                  )}

                  {lookupDone && lookupHint?.hint && (
                    <Alert
                      tone={
                        !lookupHint.exists ||
                        lookupHint.needsEmail ||
                        lookupHint.canSendOtp === false ||
                        lookupHint.registrationComplete === false
                          ? 'warning'
                          : 'info'
                      }
                    >
                      {lookupHint.hint}
                      {lookupHint.exists && lookupHint.registrationComplete === false && (
                        <div className="text-sm" style={{ marginTop: '0.5rem' }}>
                          下一步：{lookupHint.nextStepHint || '完成註冊會員資料'}
                        </div>
                      )}
                    </Alert>
                  )}

                  <Button type="submit" size="lg" loading={busy} className="w-full member-center__cta">
                    {needsEmailCapture ? '寄送 Email 驗證碼' : '查詢並繼續'}
                  </Button>

                  {needsEmailCapture && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setNeedsEmailCapture(false);
                        setEmail('');
                        setLookupDone(false);
                        setLookupHint(null);
                      }}
                    >
                      返回修改手機／證件
                    </Button>
                  )}

                  <p className="member-center__legal">
                    點擊繼續即同意
                    <button type="button" className="member-center__link" onClick={() => setLegalDoc('rights')}>
                      會員權益
                    </button>
                    及
                    <button type="button" className="member-center__link" onClick={() => setLegalDoc('privacy')}>
                      隱私權宣告
                    </button>
                  </p>
                </form>
              )}
            </div>
          ) : (
            <>
              <div className="auth-card__hero member-center__step-hero">
                {viewStep !== 'done' && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="member-center__back"
                    disabled={busy}
                    onClick={goBackStep}
                  >
                    ← 上一步
                  </Button>
                )}
                <BrandMark size={48} />
                <p className="member-center__eyebrow">MEMBER CENTER</p>
                <h2>{titleByStep[viewStep]}</h2>
                <p>
                  {viewStep === 'otp' &&
                    (lookupHint?.exists
                      ? lookupHint.registrationComplete === false
                        ? `註冊尚未完成（${lookupHint.nextStepHint || '未完步驟'}）。請輸入寄至 ${lookupHint.maskedEmail || '登記 Email'} 的驗證碼，繼續完成會員資料`
                        : `歡迎回來，${lookupHint.maskedName || '會員'}，請輸入寄至 ${lookupHint.maskedEmail || '登記 Email'} 的驗證碼`
                      : '請輸入寄至您 Email 的驗證碼以繼續註冊')}
                  {viewStep === 'email-enroll' &&
                    '請確認手機與證件，並填寫要綁定的 Email；驗證通過後即可繼續完成註冊'}
                  {viewStep === 'register' &&
                    '請填寫並確認會員資料、選擇綁定分店，並選擇是否使用生物辨識（須完成才算註冊完成）'}
                  {viewStep === 'face-choice' &&
                    '請選擇是否使用人臉進出場；完成後將簽署必簽會員契約（啟用則另簽生物辨識同意書）'}
                  {viewStep === 'contracts' &&
                    (status?.faceEnabled
                      ? '請閱讀並電子簽署入會契約與生物辨識同意書'
                      : '請閱讀並電子簽署會員契約書')}
                  {viewStep === 'id-photos' &&
                    '新會員須以本機相機拍攝證件正／反面後，才能綁定裝置進出場（無法從相簿選檔）'}
                  {viewStep === 'bind-line' &&
                    '鼓勵綁定 LINE 以便下次快速登入（非必要）；可略過，直接綁本機裝置後顯示門禁 QR'}
                  {viewStep === 'bind-device' &&
                    '綁定本機瀏覽器／手機裝置後即可使用會員專區 30 秒動態 QR 進出場（一機一帳）'}
                  {viewStep === 'device-reset' &&
                    '請輸入身分證／居留證號（或註冊手機）與登記 Email，驗證信通過後才可換機'}
                  {viewStep === 'done' && '已完成所有步驟'}
                </p>
              </div>

              {error && (
                <Alert tone="error" onDismiss={() => setError('')}>
                  {error}
                </Alert>
              )}
            </>
          )}

          {viewStep === 'otp' && (
            <form className="form-stack" onSubmit={handleVerifyOtp}>
              <Field label="驗證碼" hint={devCode ? `開發模式碼：${devCode}` : '請輸入 6 碼'}>
                <Input
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  required
                />
              </Field>
              <Button type="submit" size="lg" loading={busy} className="w-full member-center__cta">
                驗證並繼續
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || otpCooldown > 0}
                onClick={() => void handleResendOtp()}
              >
                {otpCooldown > 0 ? `重新發送（${otpCooldown}s）` : '重新發送驗證碼'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  resetToEmailEntry();
                  setNeedsEmailCapture(false);
                  if (authMode === 'login') setShowLoginEmail(true);
                  setOtpCode('');
                  setDevCode('');
                  setOtpCooldown(0);
                  setLookupDone(false);
                  setLookupHint(null);
                }}
              >
                {authMode === 'login' ? '返回 Email 登入' : '返回修改手機／證件'}
              </Button>
            </form>
          )}

          {viewStep === 'email-enroll' && (
            <form
              className="form-stack"
              onSubmit={enrollOtpSent ? handleVerifyEmailEnroll : handleRequestEmailEnroll}
            >
              <Alert tone="info">
                請綁定並驗證 Email。手機與證件已於入口核對。
                {lookupHint?.maskedName ? ` 會員：${lookupHint.maskedName}` : ''}
                {lookupHint?.nextStepHint && lookupHint.registrationComplete === false
                  ? `（尚未完成：${lookupHint.nextStepHint}）`
                  : ''}
                {enrollMaskedEmail ? ` 驗證信將寄至 ${enrollMaskedEmail}` : ''}
              </Alert>
              <Field label="註冊手機" hint={lookupHint?.maskedPhone || undefined}>
                <Input
                  value={enrollPhone}
                  onChange={(e) => setEnrollPhone(e.target.value)}
                  inputMode="tel"
                  placeholder="0912345678"
                  required
                  autoComplete="tel"
                  readOnly
                  disabled={enrollOtpSent}
                />
              </Field>
              <Field label="證件號碼" hint="身分證／居留證／護照／國籍證件（已核對）">
                <Input
                  value={enrollIdNumber}
                  onChange={(e) => setEnrollIdNumber(e.target.value.toUpperCase())}
                  placeholder="A123456789 或護照號"
                  required
                  autoComplete="off"
                  readOnly
                  disabled={enrollOtpSent}
                />
              </Field>
              <Field label="要補登的 Email">
                <Input
                  type="email"
                  value={enrollEmail}
                  onChange={(e) => setEnrollEmail(e.target.value)}
                  required
                  autoComplete="email"
                  disabled={enrollOtpSent}
                />
              </Field>
              {enrollOtpSent && (
                <Field label="Email 驗證碼" hint={devCode ? `開發模式碼：${devCode}` : '6 碼；錯誤 3 次即作廢'}>
                  <Input
                    value={enrollOtp}
                    onChange={(e) => setEnrollOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    required
                  />
                </Field>
              )}
              <Button type="submit" size="lg" loading={busy} className="w-full member-center__cta">
                {enrollOtpSent ? '驗證並繼續註冊' : '寄送 Email 驗證碼'}
              </Button>
              {enrollOtpSent && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || enrollCooldown > 0}
                  onClick={() => void handleRequestEmailEnroll()}
                >
                  {enrollCooldown > 0 ? `重新發送（${enrollCooldown}s）` : '重新發送驗證碼'}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (enrollOtpSent) {
                    setEnrollOtpSent(false);
                    setEnrollOtp('');
                    setDevCode('');
                    setEnrollMaskedEmail('');
                    return;
                  }
                  resetToEmailEntry();
                  setNeedsEmailCapture(false);
                  setLookupDone(false);
                  setLookupHint(null);
                }}
              >
                {enrollOtpSent ? '更改 Email' : '返回查詢'}
              </Button>
            </form>
          )}

          {viewStep === 'face-choice' && (
            <form className="form-stack" onSubmit={handleFacePreference}>
              <Alert tone="info">
                舊會員需先完成必簽會員契約，並確認是否啟用人臉，才能繼續綁定 LINE／裝置。
              </Alert>
              <fieldset className="auth-choice-list">
                <legend className="field__label">是否使用生物辨識功能（人臉進出場）</legend>
                <label className="auth-choice">
                  <input
                    type="radio"
                    name="loginFaceEnabled"
                    checked={loginFaceEnabled === true}
                    onChange={() => setLoginFaceEnabled(true)}
                  />
                  <span>是，我要使用人臉辨識（須加簽生物辨識同意書）</span>
                </label>
                <label className="auth-choice">
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
              <Field label="Email（已驗證）">
                <Input value={status?.email || email} readOnly disabled />
              </Field>
              <Field label="手機號碼" hint="已於入口確認">
                <Input
                  value={regPhone}
                  onChange={(e) => setRegPhone(e.target.value)}
                  inputMode="tel"
                  placeholder="0912345678 或 +8190…"
                  required
                  autoComplete="tel"
                  readOnly
                />
              </Field>
              <Field
                label="證件號碼"
                hint="身分證／居留證／護照／國籍證件（已於入口確認）"
              >
                <Input
                  value={regIdNumber}
                  onChange={(e) => setRegIdNumber(e.target.value.toUpperCase())}
                  autoComplete="off"
                  placeholder="A123456789 或護照號"
                  required
                  readOnly
                />
              </Field>
              <Field label="緊急聯絡人">
                <Input
                  value={regEmergency}
                  onChange={(e) => setRegEmergency(e.target.value)}
                  required
                />
              </Field>
              <Field label="緊急聯絡人電話" hint="台灣或國際門號皆可">
                <Input
                  value={regEmergencyPhone}
                  onChange={(e) => setRegEmergencyPhone(e.target.value)}
                  inputMode="tel"
                  placeholder="0912345678 或 +1…"
                  required
                />
              </Field>
              <fieldset className="auth-choice-list">
                <legend className="field__label">綁定分店（必選）</legend>
                {registerBranches.length === 0 ? (
                  <Alert tone="warning">尚無可選分店，請稍後再試或洽櫃檯</Alert>
                ) : (
                  registerBranches.map((b) => (
                    <label key={b.id} className="auth-choice">
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
              <fieldset className="auth-choice-list">
                <legend className="field__label">是否使用生物辨識功能（人臉進出場）</legend>
                <label className="auth-choice">
                  <input
                    type="radio"
                    name="faceEnabled"
                    checked={regFaceEnabled === true}
                    onChange={() => setRegFaceEnabled(true)}
                  />
                  <span>是，我要使用人臉辨識（須加簽生物辨識同意書）</span>
                </label>
                <label className="auth-choice">
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
                    ? '尚未設定「新會員」入會契約，請洽總部於「合約」建立用途為「新會員入會」的契約後再繼續。完成簽署後才能綁定裝置進出場。'
                    : '尚無待簽契約，請重新整理狀態。'}
                  <Button className="mt-md" variant="secondary" onClick={() => void refreshStatus()}>
                    重新整理狀態
                  </Button>
                </Alert>
              ) : (
                (status?.contracts || []).map((c) => (
                  <div key={c.contractId} className="auth-contract-row">
                    <div>
                      <strong>{c.title || c.displayName}</strong>
                      <div className="text-muted text-sm">
                        {c.isBiometrics ? '生物辨識 · ' : ''}
                        {c.versionLabel || ''} · {c.signed ? '已簽署' : '待簽署'}
                      </div>
                    </div>
                    <Button
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

          {viewStep === 'id-photos' && (
            <div className="form-stack">
              <Alert tone="info">
                證件影像僅供會籍核對。請用本機相機現場拍攝正／反面（自動存成
                JPG），無法從相簿選檔。可拍身分證、居留證或護照頁面。
              </Alert>
              <label className="id-photo-consent">
                <input
                  type="checkbox"
                  checked={idPhotoConsent}
                  onChange={(e) => setIdPhotoConsent(e.target.checked)}
                />
                <span>
                  我已了解蒐集目的與保存期間，同意拍攝證件正／反面供會籍核對使用。
                </span>
              </label>
              {!idPhotoConsent && (
                <Alert tone="warning">請先勾選同意後再開啟相機</Alert>
              )}
              <div className="id-photo-grid">
                <MemberIdPhotoCamera
                  side="front"
                  sideLabel="證件正面"
                  disabled={!idPhotoConsent}
                  busy={idPhotoBusySide === 'front'}
                  alreadyDone={idPhotoFrontReady}
                  onCaptured={(dataUrl) => void handleUploadIdPhotoDataUrl('front', dataUrl)}
                />
                <MemberIdPhotoCamera
                  side="back"
                  sideLabel="證件反面"
                  disabled={!idPhotoConsent}
                  busy={idPhotoBusySide === 'back'}
                  alreadyDone={idPhotoBackReady}
                  onCaptured={(dataUrl) => void handleUploadIdPhotoDataUrl('back', dataUrl)}
                />
              </div>
              {idPhotoFrontReady && idPhotoBackReady ? (
                <Button
                  type="button"
                  size="lg"
                  className="w-full"
                  onClick={() => void refreshStatus()}
                >
                  證件已齊，繼續綁定裝置
                </Button>
              ) : (
                <Alert tone="warning">請拍攝正面與反面後即可繼續</Alert>
              )}
            </div>
          )}

          {viewStep === 'bind-line' && (
            <div className="form-stack">
              <Alert tone="info">
                鼓勵綁定 LINE 以便下次快速登入（非必要）。可略過，改綁本機裝置後即可於網頁產生門禁 QR。
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
              <Button
                type="button"
                size="lg"
                variant="secondary"
                disabled={busy}
                className="w-full"
                onClick={() => advanceStep('bind-device')}
              >
                略過 LINE，改綁本機裝置
              </Button>
            </div>
          )}

          {viewStep === 'bind-device' && (
            <div className="form-stack">
              <Alert tone="info">
                將綁定目前瀏覽器／手機的裝置碼，用於會員專區動態門禁 QR（一機一帳）。無需安裝
                LINE。若想之後用 LINE 快速登入，可於會員中心再綁。
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
                  variant="ghost"
                  disabled={busy}
                  onClick={() => advanceStep('bind-line')}
                >
                  改為綁定 LINE（選用）
                </Button>
              )}
            </div>
          )}

          {viewStep === 'device-reset' && (
            <form
              className="form-stack"
              onSubmit={
                resetOtpSent ? handleVerifyDeviceResetEmail : handleRequestDeviceResetEmail
              }
            >
              <Alert tone="info">
                須同時核對「身分證／居留證／護照或註冊手機」與「登記 Email」後才寄驗證信。自助換機有頻率上限（約
                24 小時 1 次、近月有限次數）；超過請洽櫃檯臨櫃重置。收不到信亦請洽櫃檯。
                {resetMaskedEmail ? ` 目標信箱：${resetMaskedEmail}` : ''}
              </Alert>
              <Field label="身分證／居留證號或註冊手機">
                <Input
                  value={resetIdentity}
                  onChange={(e) => setResetIdentity(e.target.value)}
                  placeholder="A123456789 或 0912345678"
                  required
                  autoComplete="off"
                />
              </Field>
              <Field label="登記 Email">
                <Input
                  type="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </Field>
              {resetOtpSent && (
                <Field label="Email 驗證碼" hint="6 碼；錯誤 3 次即作廢">
                  <Input
                    value={resetOtp}
                    onChange={(e) => setResetOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    required
                  />
                </Field>
              )}
              <Button type="submit" size="lg" loading={busy} className="w-full member-center__cta">
                {resetOtpSent ? '驗證並換機' : '寄送 Email 驗證碼'}
              </Button>
              {resetOtpSent && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || resetCooldown > 0}
                  onClick={() => void handleRequestDeviceResetEmail()}
                >
                  {resetCooldown > 0 ? `重新發送（${resetCooldown}s）` : '重新發送驗證碼'}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  clearDeviceResetSession();
                  setResetOtpSent(false);
                  setResetOtp('');
                  setResetTicket('');
                  resetToEmailEntry();
                  setNeedsEmailCapture(false);
                }}
              >
                返回登入
              </Button>
            </form>
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

      <Modal
        open={legalDoc !== null}
        title={legalDoc === 'privacy' ? '隱私權宣告（摘要）' : '會員權益（摘要）'}
        onClose={() => setLegalDoc(null)}
        footer={
          <Button type="button" onClick={() => setLegalDoc(null)}>
            我知道了
          </Button>
        }
      >
        {legalDoc === 'privacy' ? (
          <div className="form-stack text-sm">
            <p>我們會依營運與法令需要，蒐集與使用您的會員資料，重點如下：</p>
            <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
              <li>身分與聯絡資料：用於登入、通知、會籍與客服。</li>
              <li>進場與消費紀錄：用於門禁、計費、發票與對帳。</li>
              <li>證件影像：僅供會籍查驗，加密保存；一般櫃檯無法直接預覽原圖。</li>
              <li>人臉特徵（若您同意）：僅用於進場辨識，可依規定申請停止使用。</li>
            </ul>
            <p className="text-muted">完整條款以館方公告與定型化契約為準；如需查閱或更正個資，請洽櫃檯。</p>
          </div>
        ) : (
          <div className="form-stack text-sm">
            <p>成為會員後，您可依方案使用以下服務（實際內容以購買方案為準）：</p>
            <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
              <li>依規定進出場與使用場館設施。</li>
              <li>查看錢包餘額、會籍效期與消費紀錄。</li>
              <li>線上或臨櫃購買方案、請假與查詢課程（視館方開放項目）。</li>
              <li>依消保法與定型化契約主張退費等權益。</li>
            </ul>
            <p className="text-muted">未完成必簽契約、證件建檔或帳號遭警示時，部分功能（含進場）可能暫時無法使用。</p>
          </div>
        )}
      </Modal>
    </LandingLayout>
  );
}
