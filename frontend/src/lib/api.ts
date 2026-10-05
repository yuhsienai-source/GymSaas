import axios, { AxiosHeaders, type AxiosInstance } from 'axios';
import {
  getMemberToken,
  setMemberToken,
  getStaffToken,
  getOrCreateDeviceId,
  getOnboardingToken,
  clearMemberToken,
  clearStaffToken,
  MEMBER_AUTH_LOST_EVENT,
  STAFF_AUTH_LOST_EVENT,
  STAFF_OFF_DUTY_EVENT,
} from './storage';
import type { EmploymentType, LeaveType } from './laborLaw';
import type {
  ApiResponse,
  MemberProfile,
  MemberWallet,
  PtContract,
  Promotion,
  QrCodeResponse,
  OpsMember,
  Branch,
  GateDevice,
  Venue,
  Trainer,
  Product,
  ProductKind,
  TaxType,
  LegalEntity,
  ProductMaster,
  BranchStockRow,
  Supplier,
  SupplierPaymentTerm,
  PurchaseOrder,
  PurchaseReceipt,
  OpsReceiptRow,
  SupplierPayable,
  PayableAgingRow,
  SupplierPayment,
  SupplierPaymentMethod,
  EInvoiceRow,
  EInvoiceLogRow,
  SalesReconciliation,
  StockMovement,
  PosPayMethod,
  PosCheckoutResult,
  StaffAccount,
  StaffAvatar,
  StaffConsentTemplate,
  StaffFaceConsent,
  StaffPermission,
  StaffPhotoStatus,
  PublicHoliday,
  RosterBranchConfig,
  MyRosterOverview,
  RosterAckStatus,
  RosterCellCode,
  RosterView,
  MemberIdentifyResult,
  MembershipContract,
  TrainerDashboardData,
  GymContractPreset,
  ContractAuditLog,
  MemberContractSignature,
  MemberContractBoardItem,
  MemberContractListItem,
  CoursePlan,
  CardSubscription,
  HqCompensationLog,
  CmsAnnouncement,
  CmsBranchIntro,
  CmsFaqItem,
  CmsTrainerPublic,
  MemberOrderHistoryItem,
  MemberClassRecords,
  MemberSubscription,
  MemberGiftCards,
  MemberPointsLedgerEntry,
  MarketingCampaign,
  LotteryPool,
  StaffAttendanceRow,
  StaffLeaveRow,
  StaffScheduleRow,
  AttendanceFlag,
  AttendanceOverview,
  AttendanceRecord,
  HolidayCalendar,
  LeaveOverview,
  LeaveStatus,
  MyAttendance,
  ScheduleBrief,
  StaffDutyStatus,
  MyLeaves,
  PayrollExport,
  PayrollAdjustmentType,
  PayrollConfigData,
  PayrollRunDetail,
  PayrollRunSummary,
  PayProfileList,
  StaffPayProfileData,
  MyPayslipDetail,
  MyPayslipSummary,
  ScheduleOverview,
  ScheduleOverviewRow,
  ScheduleSource,
  StaffLineStatus,
  StaffNotificationInbox,
  StaffNotificationItem,
  CoachCommissionRule,
  CoachCourseKind,
  CoachTierRate,
  HqCoachPerformanceItem,
  TrainerMyPerformance,
  MyCoachPlans,
  CoachWeekPlan,
  CoachPlanSlot,
  CoachPlanStatus,
  CoachPlanReviewList,
  WeekPlanRole,
  ClassCheckInTokenResult,
  GroupAdminSeries,
  GroupEnrollKind,
  GroupEnrollResult,
  GroupMakeupOption,
  GroupMemberOverview,
  GroupRefundPreview,
  GroupSellableSeries,
  GroupSeriesDetail,
  GroupSeriesRoster,
  AllowanceExportPayload,
  AllowanceListPayload,
  AllowancePrintPayload,
  RefundLookupResult,
  RefundInvoiceResolveBody,
  RefundGatewayRetryData,
  RefundPreview,
  RefundRecord,
  RefundScope,
  RefundTerminationClause,
} from '../types/api';
import type { AllowanceSignPreview } from '../types/posDisplayBus';
import type { StaffInfo, StaffRole } from './storage';
import type { BranchType, TrainerLevel, TrainerRole } from './orgStructure';

function createClient(getToken: () => string | null): AxiosInstance {
  const client = axios.create({ baseURL: '/api' });
  client.interceptors.request.use((config) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });
  return client;
}

export const publicApi = axios.create({ baseURL: '/api' });
export const memberApi = createClient(getMemberToken);
export const staffApi = createClient(getStaffToken);
export const onboardingApi = createClient(getOnboardingToken);
export const gateApi = axios.create({
  baseURL: '/api/gate',
  timeout: 2500, // 分店外網抖動：短逾時，前端顯示重試而非白屏
});

const SESSION_AUTH_CODES = new Set([
  'AUTH_EXPIRED',
  'AUTH_REQUIRED',
  'DEVICE_MISMATCH',
  'DEVICE_REQUIRED',
]);

let memberAuthRedirecting = false;
let staffAuthRedirecting = false;

export function readApiErrorCode(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const code = (error.response?.data as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function readApiErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return fallback;
  const msg = (error.response?.data as { message?: string } | undefined)?.message;
  return msg || fallback;
}

/** 登入票失效／缺票（非模組權限不足）→ 清 JWT 並硬導登入頁 */
function isSessionAuthFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error) || !error.response) return false;
  const status = error.response.status;
  const code = readApiErrorCode(error);
  if (code && SESSION_AUTH_CODES.has(code)) return true;
  // 相容舊後端（尚無 code）：僅對過期／缺票文案導向，勿把模組 403 當登出
  if (status === 401) return true;
  if (status === 403) {
    const msg = readApiErrorMessage(error, '');
    return /已過期|遭竄改|缺少.*憑證|無效的登入憑證|非員工憑證|非會員憑證|憑證異常/.test(msg);
  }
  return false;
}

function redirectMemberLogin(message: string) {
  clearMemberToken();
  if (typeof window === 'undefined' || memberAuthRedirecting) return;
  memberAuthRedirecting = true;
  window.dispatchEvent(
    new CustomEvent(MEMBER_AUTH_LOST_EVENT, { detail: { message } }),
  );
  const path = window.location.pathname;
  if (path === '/' || path === '/member/login') return;
  window.location.replace(`/?login_error=${encodeURIComponent(message)}`);
}

function redirectStaffLogin(message: string) {
  clearStaffToken();
  if (typeof window === 'undefined' || staffAuthRedirecting) return;
  staffAuthRedirecting = true;
  window.dispatchEvent(
    new CustomEvent(STAFF_AUTH_LOST_EVENT, { detail: { message } }),
  );
  const path = window.location.pathname;
  if (path === '/staff/login' || path.startsWith('/staff/login')) {
    // 已在登入頁：強制重整以吃掉過期 token 的 React state
    const target = `/staff/login?login_error=${encodeURIComponent(message)}`;
    if (window.location.href.includes('login_error=')) return;
    window.location.replace(target);
    return;
  }
  window.location.replace(`/staff/login?login_error=${encodeURIComponent(message)}`);
}

/** 會員 API：一律帶本機 deviceId；登入過期／DEVICE_MISMATCH 清 JWT 並強制回登入 */
memberApi.interceptors.request.use((config) => {
  const deviceId = getOrCreateDeviceId();
  const headers = AxiosHeaders.from(config.headers ?? {});
  headers.set('X-Device-Id', deviceId);
  config.headers = headers;
  return config;
});
memberApi.interceptors.response.use(
  (res) => res,
  (error) => {
    if (isSessionAuthFailure(error)) {
      redirectMemberLogin(readApiErrorMessage(error, '登入已過期，請重新登入'));
    }
    return Promise.reject(error);
  },
);

/** 員工 API：JWT 過期／缺票 → 清憑證並硬導員工登入（模組權限 403 不導）；403 OFF_DUTY → 通知 AuthContext 切非值勤模式 */
staffApi.interceptors.response.use(
  (res) => res,
  (error) => {
    if (isSessionAuthFailure(error)) {
      redirectStaffLogin(readApiErrorMessage(error, '登入已過期，請重新登入'));
    } else if (readApiErrorCode(error) === 'OFF_DUTY' && typeof window !== 'undefined') {
      const duty = (error.response?.data as { data?: { duty?: StaffDutyStatus } } | undefined)?.data?.duty ?? null;
      window.dispatchEvent(new CustomEvent(STAFF_OFF_DUTY_EVENT, { detail: { duty } }));
    }
    return Promise.reject(error);
  },
);

export function getErrorMessage(error: unknown, fallback = '系統錯誤'): string {
  if (axios.isAxiosError(error)) {
    const apiMsg = (error.response?.data as ApiResponse | undefined)?.message;
    if (apiMsg) return apiMsg;

    // 無 HTTP 回應：多半是手機連錯位址、自簽憑證未信任、或 API／proxy 未開
    if (!error.response) {
      const host =
        typeof window !== 'undefined' ? window.location.host : '';
      const isLocalhostHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
      if (isLocalhostHost && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        return '無法連線：手機請勿使用 localhost，改開電腦的區網 IP（例如 https://192.168.x.x:5173），並先信任憑證後再開一次 /api/health';
      }
      if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
        return '無法連線到登入服務：請確認已啟動 API（npm run dev:api）與前端，並在瀏覽器信任本機 HTTPS 憑證（可先開啟 /api/health）';
      }
      return '無法連線到登入服務：請確認後端 API 已啟動（預設 :8000）且前端 proxy 正常';
    }

    if (error.response.status >= 500) {
      return apiMsg || '伺服器錯誤，請稍後再試';
    }
    return fallback;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

/** LINE／換票回 DEVICE_MISMATCH_RESET_REQUIRED 時取出換機票 */
export function getDeviceResetRequiredPayload(error: unknown): {
  resetTicket: string;
  maskedEmail?: string;
  message: string;
} | null {
  if (!axios.isAxiosError(error) || !error.response?.data) return null;
  const data = error.response.data as {
    code?: string;
    message?: string;
    resetTicket?: string;
    maskedEmail?: string;
  };
  if (data.code !== 'DEVICE_MISMATCH_RESET_REQUIRED' || !data.resetTicket) return null;
  return {
    resetTicket: data.resetTicket,
    maskedEmail: data.maskedEmail,
    message: data.message || '偵測到新裝置，請完成 Email 換機驗證',
  };
}

/** 閘機／業務錯誤的結構化欄位（memberId、code） */
export function getApiErrorDetails(error: unknown): {
  message: string;
  memberId?: number;
  code?: string;
  status?: number;
} {
  const message = getErrorMessage(error);
  if (!axios.isAxiosError(error) || !error.response?.data) {
    return { message };
  }
  const data = error.response.data as {
    message?: string;
    memberId?: number;
    code?: string;
  };
  const memberId =
    typeof data.memberId === 'number' && Number.isFinite(data.memberId)
      ? data.memberId
      : undefined;
  const code = typeof data.code === 'string' ? data.code : undefined;
  return {
    message: data.message || message,
    memberId,
    code,
    status: error.response.status,
  };
}

/** 閘機配對金鑰／權限錯誤（應重新配對）；網路／5xx 不算 */
export function isGatePairAuthError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || !error.response) return false;
  const status = error.response.status;
  return status === 401 || status === 403;
}

/** 診斷：前端 → Vite proxy → 後端是否通 */
export async function pingApiHealth() {
  const { data } = await publicApi.get<ApiResponse>('/health', { timeout: 8000 });
  return data;
}

// ── Auth ──
export async function getLineLoginUrl(state?: string) {
  const { data } = await publicApi.get<ApiResponse<{ url: string; state: string }>>(
    '/auth/line/login-url',
    { params: state ? { state } : undefined },
  );
  return data;
}

type LineExchangeResult = ApiResponse<{
  token: string;
  member: {
    id: number;
    name: string;
    plan: string;
    hasDeviceBound?: boolean;
    hasLineBound?: boolean;
  };
}>;

/** 同一 auth_code／LINE code 只打一次（Strict Mode 雙 effect 共用結果） */
const lineExchangeInflight = new Map<string, Promise<LineExchangeResult>>();

function onceLineExchange(key: string, run: () => Promise<LineExchangeResult>) {
  const existing = lineExchangeInflight.get(key);
  if (existing) return existing;
  const pending = run().finally(() => {
    globalThis.setTimeout(() => {
      if (lineExchangeInflight.get(key) === pending) lineExchangeInflight.delete(key);
    }, 15_000);
  });
  lineExchangeInflight.set(key, pending);
  return pending;
}

export async function exchangeLineCode(code: string, state?: string | null) {
  const deviceId = getOrCreateDeviceId();
  return onceLineExchange(`line:${code}:${state || ''}`, async () => {
    const { data } = await publicApi.post<LineExchangeResult>('/auth/line/token', {
      code,
      state: state || undefined,
      deviceId,
    });
    return data;
  });
}

export async function exchangeAuthCallbackCode(authCode: string) {
  const deviceId = getOrCreateDeviceId();
  return onceLineExchange(`auth:${authCode}`, async () => {
    const { data } = await publicApi.post<LineExchangeResult>('/auth/exchange-auth-code', {
      authCode,
      deviceId,
    });
    return data;
  });
}

export type OnboardingStatus = {
  email?: string | null;
  phone?: string | null;
  purpose: 'LOGIN' | 'REGISTER' | string;
  isNew: boolean;
  faceEnabled?: boolean;
  facePreferenceSet?: boolean;
  member: {
    id: number;
    name: string;
    phone: string;
    email?: string | null;
    hasLineBound: boolean;
    hasDeviceBound: boolean;
    faceEnabled?: boolean;
    facePreferenceSet?: boolean;
    plan: string;
  } | null;
  contracts: {
    contractId: number;
    title: string;
    shortName?: string | null;
    displayName?: string;
    purpose?: string | null;
    isBiometrics?: boolean;
    versionLabel?: string | null;
    signed: boolean;
  }[];
  needContracts: boolean;
  allContractsSigned: boolean;
  missingNewMemberContract?: boolean;
  idPhotosReady?: boolean;
  nextStep:
    | 'REGISTER_PROFILE'
    | 'CHOOSE_FACE'
    | 'SIGN_CONTRACTS'
    | 'UPLOAD_ID_PHOTOS'
    | 'BIND_LINE'
    | 'BIND_DEVICE'
    | 'DONE'
    | string;
  /** LINE 為選用；Email OTP 通道可略過 */
  lineOptional?: boolean;
  hasLineBound?: boolean;
  onboardingToken?: string;
  token?: string;
  devCode?: string;
};

export async function onboardingLookup(
  identityOrPayload:
    | string
    | {
        identity?: string;
        phone?: string;
        idNumber?: string;
        email?: string;
      },
) {
  const body =
    typeof identityOrPayload === 'string'
      ? { identity: identityOrPayload }
      : identityOrPayload;
  const { data } = await publicApi.post<
    ApiResponse<{
      exists: boolean;
      lookupKind?: 'email' | 'phone' | 'phone_id' | string;
      maskedName: string | null;
      maskedEmail?: string | null;
      maskedPhone?: string | null;
      phone?: string | null;
      hasEmail?: boolean;
      hasIdNumber?: boolean;
      canEmailEnroll?: boolean;
      canSendOtp?: boolean;
      canStartRegister?: boolean;
      needsEmail?: boolean;
      hasLineBound: boolean;
      hasDeviceBound: boolean;
      registrationComplete?: boolean;
      nextStep?: string | null;
      nextStepHint?: string | null;
      suggestedAuthMode?: 'login' | 'register' | string;
      registration?: {
        facePreferenceReady: boolean;
        allContractsSigned: boolean;
        hasLineBound: boolean;
        hasDeviceBound: boolean;
        missingNewMemberContract: boolean;
      } | null;
      hint?: string;
      otpEmail?: string | null;
      enrollPhone?: string | null;
    }>
  >('/onboarding/lookup', body);
  return data;
}

export async function onboardingSendOtp(identity: string) {
  const { data } = await publicApi.post<
    ApiResponse<{
      exists: boolean;
      purpose: string;
      lookupKind?: string;
      maskedEmail?: string;
      otpEmail?: string;
      expiresInSec: number;
      devCode?: string;
      mock?: boolean;
    }>
  >('/onboarding/otp/send', { identity });
  return data;
}

export async function onboardingVerifyOtp(identity: string, code: string) {
  const { data } = await publicApi.post<ApiResponse<OnboardingStatus>>(
    '/onboarding/otp/verify',
    { identity, code },
  );
  return data;
}

/** 舊會員無 Email：手機＋證件核身後寄補登驗證碼 */
export async function onboardingEmailEnrollRequest(payload: {
  phone: string;
  idNumber: string;
  email: string;
}) {
  const { data } = await publicApi.post<
    ApiResponse<{
      maskedEmail: string;
      otpEmail: string;
      expiresInSec: number;
      devCode?: string;
      mock?: boolean;
    }>
  >('/onboarding/email-enroll/request', payload);
  return data;
}

/** 驗證補登 OTP → 寫入 Email 並回傳 onboarding 狀態 */
export async function onboardingEmailEnrollVerify(payload: {
  phone: string;
  idNumber: string;
  email: string;
  code: string;
}) {
  const { data } = await publicApi.post<ApiResponse<OnboardingStatus & { enrolledEmail?: string }>>(
    '/onboarding/email-enroll/verify',
    payload,
  );
  return data;
}

export async function onboardingStatus() {
  const { data } = await onboardingApi.get<ApiResponse<OnboardingStatus>>('/onboarding/status');
  return data;
}

export async function onboardingRegister(payload: {
  name: string;
  phone: string;
  /** 身分證／居留證／護照（必填） */
  idNumber: string;
  emergencyContact: string;
  emergencyContactPhone: string;
  /** 是否使用生物辨識（人臉）；是則須簽署生物辨識同意書 */
  faceEnabled?: boolean;
  /** 自助註冊綁定分店（僅允許 HP／FD） */
  branchId: number;
}) {
  const { data } = await onboardingApi.post<ApiResponse<OnboardingStatus>>(
    '/onboarding/register',
    payload,
  );
  return data;
}

export async function onboardingBranches() {
  const { data } = await onboardingApi.get<
    ApiResponse<{ branches: { id: number; name: string }[] }>
  >('/onboarding/branches');
  return data;
}

export async function onboardingSetFacePreference(faceEnabled: boolean) {
  const { data } = await onboardingApi.post<ApiResponse<OnboardingStatus>>(
    '/onboarding/face-preference',
    { faceEnabled },
  );
  return data;
}

export async function onboardingOpenContract(contractId: number) {
  const { data } = await onboardingApi.post<
    ApiResponse<{ signature: MemberContractSignature; history: MemberContractSignature[] }>
  >('/onboarding/contracts/open', { contractId });
  return data;
}

export async function onboardingSignContract(signId: number, signatureData: string) {
  const { data } = await onboardingApi.post<ApiResponse<OnboardingStatus>>(
    `/onboarding/contracts/${signId}/sign`,
    { signatureData },
  );
  return data;
}

/** 註冊必傳證件正／反面（onboarding JWT） */
export async function onboardingUploadIdPhoto(
  imageDataUrl: string,
  side: 'front' | 'back' = 'front',
  opts: { consent: boolean } = { consent: true },
) {
  const { data } = await onboardingApi.post<ApiResponse<OnboardingStatus>>(
    '/onboarding/id-photo',
    {
      dataUrl: imageDataUrl,
      side,
      consent: opts.consent,
    },
  );
  return data;
}

export async function onboardingIdPhotoMeta() {
  const { data } = await onboardingApi.get<
    ApiResponse<{
      front?: { photoId?: string } | null;
      back?: { photoId?: string } | null;
      idPhotosReady?: boolean;
      nextStep?: string;
    }>
  >('/onboarding/id-photo/meta');
  return data;
}

export async function onboardingBindDevice(deviceId: string) {
  const { data } = await onboardingApi.post<ApiResponse<OnboardingStatus>>(
    '/onboarding/bind-device',
    { deviceId },
  );
  if (data.status === 'success' && data.data?.token) {
    setMemberToken(data.data.token);
  }
  return data;
}

export async function onboardingLineLoginUrl() {
  const { data } = await onboardingApi.get<
    ApiResponse<{ url: string; state: string; exchangeEndpoint: string }>
  >('/onboarding/line-login-url');
  return data;
}

export async function bindMemberDevice(deviceId: string) {
  const { data } = await memberApi.post<
    ApiResponse<{ id: number; deviceId: string | null; token?: string }>
  >('/member/bind-device', { deviceId });
  if (data.status === 'success' && data.data?.token) {
    setMemberToken(data.data.token);
  }
  return data;
}

/** 員工登入：回傳 duty＝班表值勤判定（null＝判定暫時失敗，登入後再查） */
export async function staffLogin(account: string, password: string) {
  const { data } = await publicApi.post<
    ApiResponse<{ token: string; staff: StaffInfo; duty: StaffDutyStatus | null }>
  >('/admin/login', { account, password });
  return data;
}

/** 目前班表值勤狀態（業務模組海關同一套規則） */
export async function fetchStaffDutyStatus() {
  const { data } = await staffApi.get<ApiResponse<StaffDutyStatus>>('/staff/hr/duty-status');
  return data;
}

export async function fetchStaffMe() {
  const { data } = await staffApi.get<ApiResponse<StaffInfo>>('/admin/me');
  return data;
}

/** 本人頭像縮圖（無照片 data=null） */
export async function fetchMyStaffPhoto() {
  const { data } = await staffApi.get<ApiResponse<StaffAvatar | null>>('/admin/me/photo');
  return data;
}

// ── Member ──
export async function fetchMemberProfile() {
  const { data } = await memberApi.get<ApiResponse<MemberProfile>>('/member/me');
  return data;
}

export async function updateMemberProfile(payload: {
  name?: string;
  emergencyContact?: string | null;
  emergencyContactPhone?: string | null;
}) {
  const { data } = await memberApi.patch<ApiResponse<MemberProfile>>('/member/me', payload);
  return data;
}

export async function fetchMemberWallet() {
  const { data } = await memberApi.get<ApiResponse<MemberWallet>>('/member/wallet');
  return data;
}

export async function fetchMemberQrCode() {
  const deviceId = getOrCreateDeviceId();
  const { data } = await memberApi.post<QrCodeResponse & ApiResponse>('/member/qr-code', { deviceId }, {
    headers: { 'X-Device-Id': deviceId },
  });
  return data;
}

export async function fetchPtContracts() {
  const { data } = await memberApi.get<ApiResponse<PtContract[]>>('/member/pt-contracts');
  return data;
}

export async function fetchMemberClasses(days?: number) {
  const { data } = await memberApi.get('/member/classes', {
    params: days ? { days } : undefined,
  });
  return data;
}

export async function fetchMemberReservations(params?: { includePast?: boolean; take?: number }) {
  const { data } = await memberApi.get('/member/reservations', {
    params: {
      includePast: params?.includePast ? '1' : undefined,
      take: params?.take,
    },
  });
  return data;
}

export async function bookMemberClass(classId: number) {
  const { data } = await memberApi.post('/member/book-class', { classId });
  return data;
}

export async function cancelMemberReservation(id: number) {
  const { data } = await memberApi.post(`/member/reservations/${id}/cancel`);
  return data;
}

/** 會員查看所屬教練排休（避開預約） */
export async function fetchMemberTrainerTimeOffs(
  trainerId: number,
  params?: { from?: string; to?: string; take?: number },
) {
  const { data } = await memberApi.get(`/member/trainers/${trainerId}/time-offs`, { params });
  return data;
}

/** 會員契約清單（已簽署 + 應簽署未簽署） */
export async function fetchMemberSignedContracts() {
  const { data } = await memberApi.get<ApiResponse<MemberContractListItem[]>>('/member/contracts');
  return data;
}

// ── Gate ──
export async function fetchGateBranches() {
  const { data } = await gateApi.get<ApiResponse<{ id: number; name: string; code?: string | null }[]>>(
    '/branches',
  );
  return data;
}

export async function pairGateDevice(deviceCode: string, deviceKey: string) {
  const { data } = await gateApi.post('/device/pair', { deviceCode, deviceKey });
  return data;
}

export async function gateCheckIn(
  qrToken: string,
  opts?: { branchId?: number | null; deviceCode?: string; deviceKey?: string },
) {
  const { data } = await gateApi.post('/check-in', {
    qrToken,
    entryMethod: 'QR',
    ...(opts?.deviceCode && opts?.deviceKey
      ? { deviceCode: opts.deviceCode, deviceKey: opts.deviceKey }
      : opts?.branchId
        ? { branchId: opts.branchId }
        : {}),
  });
  return data;
}

export async function gateCheckOut(
  qrToken: string,
  opts?: { branchId?: number | null; deviceCode?: string; deviceKey?: string },
) {
  const { data } = await gateApi.post('/check-out', {
    qrToken,
    exitMethod: 'QR',
    ...(opts?.deviceCode && opts?.deviceKey
      ? { deviceCode: opts.deviceCode, deviceKey: opts.deviceKey }
      : opts?.branchId
        ? { branchId: opts.branchId }
        : {}),
  });
  return data;
}

export type GateDeviceAuth = {
  deviceCode?: string;
  deviceKey?: string;
  branchId?: number | null;
};

function gateDevicePayload(opts?: GateDeviceAuth) {
  if (opts?.deviceCode && opts?.deviceKey) {
    return { deviceCode: opts.deviceCode, deviceKey: opts.deviceKey };
  }
  if (opts?.branchId) return { branchId: opts.branchId };
  return {};
}

/** 人臉進場（禁傳 memberId；身分由 faceImage 後端解析） */
export async function gateCheckInFace(faceImage: string, opts?: GateDeviceAuth) {
  const { data } = await gateApi.post('/check-in/face', {
    faceImage,
    ...gateDevicePayload(opts),
  });
  return data;
}

/** 人臉出場 */
export async function gateCheckOutFace(faceImage: string, opts?: GateDeviceAuth) {
  const { data } = await gateApi.post('/check-out/face', {
    faceImage,
    ...gateDevicePayload(opts),
  });
  return data;
}

export async function fetchGateFaceStatus() {
  const { data } = await gateApi.get<
    ApiResponse<{
      provider: string;
      mockMode: boolean;
      similarityThreshold: number;
      qrTtlMs: number;
      qrSkewMs?: number;
    }>
  >('/face/status', { timeout: 5000 });
  return data;
}

/** 閘機時鐘校準（NTP 漂移） */
export async function fetchGateSyncTime() {
  const t0 = Date.now();
  const { data } = await gateApi.get<
    ApiResponse<{
      serverNow: number;
      iso: string;
      qrTtlMs: number;
      qrSkewMs: number;
    }>
  >('/sync-time', { timeout: 2500 });
  const t1 = Date.now();
  const serverNow = data.data?.serverNow ?? t1;
  const rtt = t1 - t0;
  const offsetMs = serverNow + Math.floor(rtt / 2) - t1;
  return {
    ...data,
    offsetMs,
    rtt,
  };
}

// ── Ops ──
export async function fetchOpsMembers(params?: {
  q?: string;
  take?: number;
  skip?: number;
  id?: number;
  lite?: boolean;
}) {
  const { data } = await staffApi.get<
    ApiResponse<{
      items: OpsMember[];
      total: number;
      take: number;
      skip: number;
    }>
  >('/ops/members', {
    params: {
      q: params?.q || undefined,
      take: params?.take,
      skip: params?.skip,
      id: params?.id,
      lite: params?.lite ? 1 : undefined,
    },
  });
  return data;
}

export async function lookupOpsMemberByPhone(
  phone: string,
  scope: 'ops' | 'pt' | 'trainer' = 'ops',
) {
  const { data } = await staffApi.get<ApiResponse<MemberIdentifyResult>>(
    `/${scope}/members/lookup`,
    { params: { phone } },
  );
  return data;
}

export async function identifyOpsMember(
  payload:
    | { method: 'PHONE'; phone: string }
    | { method: 'QR'; qrToken: string }
    | { method: 'FACE'; faceImage: string },
  scope: 'ops' | 'pt' | 'trainer' = 'ops',
) {
  const { data } = await staffApi.post<ApiResponse<MemberIdentifyResult>>(
    `/${scope}/members/identify`,
    payload,
  );
  return data;
}

export async function createOpsMember(payload: {
  name: string;
  phone: string;
  /** 身分證／居留證／護照（必填） */
  idNumber: string;
  branchIds: number[];
  faceEnabled?: boolean;
  email?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<OpsMember>>('/ops/members', payload);
  return data;
}

export async function updateOpsMember(
  memberId: number,
  payload: {
    name?: string;
    phone?: string;
    email?: string | null;
    idNumber?: string;
    isAlert?: boolean;
    faceEnabled?: boolean;
    emergencyContact?: string | null;
    emergencyContactPhone?: string | null;
    branchIds?: number[];
  },
) {
  const { data } = await staffApi.patch<ApiResponse<OpsMember>>(
    `/ops/members/${memberId}`,
    payload,
  );
  return data;
}

export async function bindOpsMemberLine(memberId: number, lineId: string) {
  const { data } = await staffApi.post<ApiResponse<OpsMember>>(
    `/ops/members/${memberId}/bind-line`,
    { lineId },
  );
  return data;
}

export async function unbindOpsMemberLine(memberId: number) {
  const { data } = await staffApi.post<ApiResponse<OpsMember>>(
    `/ops/members/${memberId}/unbind-line`,
  );
  return data;
}

export async function bindOpsMemberDevice(memberId: number, deviceId: string) {
  const { data } = await staffApi.post<ApiResponse<OpsMember>>(
    `/ops/members/${memberId}/bind-device`,
    { deviceId },
  );
  return data;
}

export async function unbindOpsMemberDevice(memberId: number) {
  const { data } = await staffApi.post<ApiResponse<OpsMember>>(
    `/ops/members/${memberId}/unbind-device`,
  );
  return data;
}

/** 臨櫃核身重置裝置（DUTY+；Email 收不到時的備援） */
export async function resetOpsMemberDevice(memberId: number, reason?: string) {
  const { data } = await staffApi.post<ApiResponse<OpsMember>>(
    `/ops/members/${memberId}/reset-device`,
    reason ? { reason } : {},
  );
  return data;
}

/** 自助換機：雙重核對後寄 Email OTP */
export async function requestDeviceResetEmail(payload: {
  identity: string;
  email: string;
  resetTicket?: string;
}) {
  const { data } = await publicApi.post<
    ApiResponse<{
      maskedEmail: string;
      expiresInSec: number;
      resetTicket: string;
      mock?: boolean;
    }>
  >('/auth/device-reset/request-email', payload);
  return data;
}

/** 自助換機：驗證 Email OTP 並改綁本機裝置 */
export async function verifyDeviceResetEmail(payload: {
  identity: string;
  email: string;
  otpCode: string;
  resetTicket?: string;
  newDeviceId?: string;
}) {
  const deviceId = payload.newDeviceId || getOrCreateDeviceId();
  const { data } = await publicApi.post<
    ApiResponse<{
      token: string;
      member: {
        id: number;
        name: string;
        plan: string;
        hasDeviceBound: boolean;
        hasLineBound: boolean;
      };
      deviceChanged: boolean;
    }>
  >('/auth/device-reset/verify-email', {
    ...payload,
    newDeviceId: deviceId,
    deviceId,
  });
  return data;
}

export async function fetchOpsPromotions() {
  const { data } = await staffApi.get<ApiResponse<Promotion[]>>('/ops/promotions');
  return data;
}

export async function fetchOpsCoursePlans(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<CoursePlan[]>>('/ops/course-plans', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function fetchOpsTrainers() {
  const { data } = await staffApi.get<ApiResponse<Trainer[]>>('/ops/trainers');
  return data;
}

export async function opsCheckout(payload: {
  branchId?: number;
  memberId?: number;
  items?: { productId: number; qty: number }[];
  promotionId?: number;
  qty?: number;
  courseItems?: { coursePlanId: number; qty: number; secondPersonOnSite?: boolean }[];
  /** 團課期班（整期／單堂）：金額由後端依剩餘堂數計價 */
  groupItems?: { seriesId: number; kind: GroupEnrollKind; classId?: number }[];
  trainerId?: number;
  payments?: { method: string; amount: number; voucherCode?: string }[];
  carrierNum?: string;
  buyerUbn?: string;
  loveCode?: string;
  cardMode?: 'LUMP' | 'INSTALLMENT' | 'RECURRING';
  cardInst?: number;
  periodType?: 'W' | 'M' | 'Y';
  periodTimes?: number;
  recurringAmount?: number;
  /** 臨櫃 LinePay POS：會員付款碼 */
  linePayOneTimeKey?: string;
}) {
  const { data } = await staffApi.post<
    ApiResponse<{
      checkoutId?: string;
      saleId?: string | null;
      orderId?: string | null;
      amount?: number;
      yipayAmount?: number;
      channel?: string;
      terminalHint?: string;
      invoiceNumber?: string | null;
      /** Soft-split: one invoice per leg (SAL / promo / PT / GROUP). */
      invoices?: Array<{
        leg: 'SALE' | 'PROMO' | 'PT' | 'GROUP' | string;
        id: string;
        invoiceNumber: string | null;
        amount: number;
        ok?: boolean;
        message?: string;
      }>;
      actionUrl?: string;
      payload?: Record<string, string>;
      paymentUrl?: string;
      transactionId?: string;
      linePayAmount?: number;
      linePayMode?: 'POS' | 'ONLINE' | string;
      payMethod?: string;
      message?: string;
      cardMode?: string;
      needsPeriodBind?: boolean;
      recurringAmount?: number | null;
      periodTimes?: number | null;
      groupEnrollmentIds?: number[];
    }>
  >('/ops/checkout', payload);
  return data;
}

/** 作廢待付款（乙禾／PayUNi 未完成）之 CHK／SAL／儲值單；後端回補預扣零錢包（DUTY+） */
export async function opsCancelPendingPayment(id: string, body: { reason: string; checked: boolean }) {
  const { data } = await staffApi.post<
    ApiResponse<{
      id: string;
      kind: 'CHECKOUT' | 'SALE' | 'ORDER';
      walletRestored: number;
      memberWallet: { cashWallet: number; bonusWallet: number } | null;
    }>
  >(`/ops/pending-payments/${encodeURIComponent(id)}/cancel`, body);
  return data;
}

/** 乙禾／凱基固定式刷卡機：端末成功後確認入帳 */
export async function opsConfirmYipay(payload: {
  checkoutId?: string;
  orderId?: string;
  saleId?: string;
  terminalRef?: string;
}) {
  const { data } = await staffApi.post<
    ApiResponse<{
      checkoutId?: string;
      orderId?: string;
      saleId?: string | null;
      invoiceNumber?: string | null;
      invoices?: Array<{ invoiceNumber: string | null; leg?: string }>;
      alreadyPaid?: boolean;
      terminalRef?: string | null;
      needsPeriodBind?: boolean;
      actionUrl?: string;
      payload?: Record<string, string>;
      periodAmt?: number;
      periodTimes?: number;
      messageHint?: string;
      bindError?: string;
    }>
  >('/ops/confirm-yipay', payload);
  return data;
}

export async function opsTopup(
  memberId: number,
  promotionId: number,
  options?: {
    qty?: number;
    payMethod?: 'CASH' | 'CARD' | 'YIPAY' | 'VOUCHER';
    payments?: { method: string; amount: number; voucherCode?: string }[];
    carrierNum?: string;
    buyerUbn?: string;
    loveCode?: string;
    cardMode?: 'LUMP' | 'INSTALLMENT' | 'RECURRING';
    cardInst?: number;
    periodType?: 'W' | 'M' | 'Y';
    periodTimes?: number;
    recurringAmount?: number;
    linePayOneTimeKey?: string;
  },
) {
  const { data } = await staffApi.post('/ops/topup', {
    memberId,
    promotionId,
    ...(options?.qty !== undefined ? { qty: options.qty } : {}),
    ...(options?.payments ? { payments: options.payments } : {}),
    ...(options?.payMethod && !options?.payments ? { payMethod: options.payMethod } : {}),
    ...(options?.carrierNum ? { carrierNum: options.carrierNum } : {}),
    ...(options?.buyerUbn ? { buyerUbn: options.buyerUbn } : {}),
    ...(options?.loveCode ? { loveCode: options.loveCode } : {}),
    ...(options?.cardMode ? { cardMode: options.cardMode } : {}),
    ...(options?.cardInst != null ? { cardInst: options.cardInst } : {}),
    ...(options?.periodType ? { periodType: options.periodType } : {}),
    ...(options?.periodTimes != null ? { periodTimes: options.periodTimes } : {}),
    ...(options?.recurringAmount != null ? { recurringAmount: options.recurringAmount } : {}),
    ...(options?.linePayOneTimeKey ? { linePayOneTimeKey: options.linePayOneTimeKey } : {}),
  });
  return data;
}

// ── 退費／折讓：前端只送單號、scope、品項數量與原因；金額一律由後端試算 ──

function refundRef(id: string) {
  return encodeURIComponent(String(id || '').trim().toUpperCase());
}

export async function opsRefundLookup(params: { orderId?: string; invoiceNumber?: string }) {
  const { data } = await staffApi.get<ApiResponse<RefundLookupResult>>('/ops/refund-lookup', { params });
  return data;
}

export async function previewTopupCancel(orderId: string) {
  const { data } = await staffApi.get<ApiResponse<RefundPreview>>(`/ops/topups/${refundRef(orderId)}/cancel-preview`);
  return data;
}

/** 退費送出冪等鍵：同一次送出（含逾時重按）沿用同一鍵，後端回傳同一張退費單 */
export function newRefundIdempotencyKey() {
  return `rfk_${crypto.randomUUID().replace(/-/g, '')}`;
}

export async function executeTopupCancel(
  orderId: string,
  body: { quoteToken: string; reason: string; buyerEmail?: string },
  idempotencyKey: string,
) {
  const { data } = await staffApi.post<ApiResponse<RefundRecord>>(
    `/ops/topups/${refundRef(orderId)}/cancel`,
    {
      quoteToken: body.quoteToken,
      reason: body.reason,
      ...(body.buyerEmail?.trim() ? { buyerEmail: body.buyerEmail.trim() } : {}),
    },
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
  return data;
}

export type SubOrderRefundItem = { orderItemId: number; qty: number };

export type ShortfallResolution = 'PAID_AT_POS' | 'FLAG_ALERT_FOR_RECOVERY';

/** 手續費政策：僅條款與「調降後手續費」，金額上限與實退一律由後端計算 */
export interface RefundFeePolicyInput {
  clause?: RefundTerminationClause;
  overrideFeeAmount?: number | null;
}

function feePolicyFields(p: RefundFeePolicyInput) {
  return {
    ...(p.clause && p.clause !== 'VOLUNTARY' ? { clause: p.clause } : {}),
    ...(p.overrideFeeAmount != null ? { overrideFeeAmount: p.overrideFeeAmount } : {}),
  };
}

export async function previewSubOrderRefund(
  subOrderId: string,
  params: { scope?: RefundScope; items?: SubOrderRefundItem[] } & RefundFeePolicyInput,
) {
  const { data } = await staffApi.get<ApiResponse<RefundPreview>>(
    `/ops/sub-orders/${refundRef(subOrderId)}/refund-preview`,
    {
      params: {
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.items?.length ? { items: JSON.stringify(params.items) } : {}),
        ...feePolicyFields(params),
      },
    },
  );
  return data;
}

export async function executeSubOrderRefund(
  subOrderId: string,
  body: {
    quoteToken: string;
    scope: RefundScope;
    items?: SubOrderRefundItem[];
    reason: string;
    buyerEmail?: string;
    /** 課程分期應補繳之處置：已臨櫃收訖（須附收款憑證）／主管核准立案追償（後端列欠款黑名單） */
    shortfallResolution?: ShortfallResolution;
    shortfallNote?: string;
  } & RefundFeePolicyInput,
  idempotencyKey: string,
) {
  const { data } = await staffApi.post<ApiResponse<RefundRecord>>(
    `/ops/sub-orders/${refundRef(subOrderId)}/refund`,
    {
      quoteToken: body.quoteToken,
      scope: body.scope,
      ...(body.items?.length ? { items: body.items } : {}),
      reason: body.reason,
      ...(body.buyerEmail?.trim() ? { buyerEmail: body.buyerEmail.trim() } : {}),
      ...feePolicyFields(body),
      ...(body.shortfallResolution ? { shortfallResolution: body.shortfallResolution } : {}),
      ...(body.shortfallResolution && body.shortfallNote?.trim() ? { shortfallNote: body.shortfallNote.trim() } : {}),
    },
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
  return data;
}

export async function fetchRefunds(params?: {
  status?: string;
  branchId?: number;
  subOrderId?: string;
  memberId?: number;
  take?: number;
}) {
  const { data } = await staffApi.get<ApiResponse<RefundRecord[]>>('/ops/refunds', { params });
  return data;
}

export async function fetchRefund(id: string) {
  const { data } = await staffApi.get<ApiResponse<RefundRecord>>(`/ops/refunds/${refundRef(id)}`);
  return data;
}

/** 分段檢查點重試：已退成的金流不再打、作廢先查遠端；回傳每步結果與退費單 */
export async function retryRefundGateway(id: string, confirmGatewayNotRefunded = false) {
  const { data } = await staffApi.post<ApiResponse<RefundGatewayRetryData>>(
    `/ops/refunds/${refundRef(id)}/retry-gateway`,
    { ...(confirmGatewayNotRefunded ? { confirmGatewayNotRefunded: true } : {}) },
  );
  return data;
}

export async function confirmYipayRefund(
  id: string,
  paymentId: string,
  body: { rrn: string; authCode: string; cardLast4: string; terminalRef?: string },
) {
  const { data } = await staffApi.post<ApiResponse<RefundRecord>>(
    `/ops/refunds/${refundRef(id)}/payments/${encodeURIComponent(paymentId)}/yipay-confirm`,
    {
      rrn: body.rrn.trim(),
      authCode: body.authCode.trim().toUpperCase(),
      cardLast4: body.cardLast4.trim(),
      ...(body.terminalRef?.trim() ? { terminalRef: body.terminalRef.trim() } : {}),
    },
  );
  return data;
}

export async function fallbackRefundToCash(
  id: string,
  paymentId: string,
  body: { reason: string; confirmGatewayNotRefunded?: boolean },
) {
  const { data } = await staffApi.post<ApiResponse<RefundRecord>>(
    `/ops/refunds/${refundRef(id)}/payments/${encodeURIComponent(paymentId)}/cash-fallback`,
    { reason: body.reason, ...(body.confirmGatewayNotRefunded ? { confirmGatewayNotRefunded: true } : {}) },
  );
  return data;
}

/** ezPay 折讓結果不明之核對（DUTY+）：已開立帶 ezPayAllowanceNo；未開立必須 confirmEzPayNotIssued */
export async function resolveRefundInvoice(id: string, body: RefundInvoiceResolveBody) {
  const payload =
    body.outcome === 'ISSUED'
      ? { einvoiceId: body.einvoiceId, outcome: body.outcome, ezPayAllowanceNo: body.ezPayAllowanceNo.trim().toUpperCase(), reason: body.reason.trim() }
      : { einvoiceId: body.einvoiceId, outcome: body.outcome, confirmEzPayNotIssued: true as const, reason: body.reason.trim() };
  const { data } = await staffApi.post<ApiResponse<RefundRecord>>(`/ops/refunds/${refundRef(id)}/invoice-resolve`, payload);
  return data;
}

export async function abortRefund(id: string, reason: string) {
  const { data } = await staffApi.post<ApiResponse<RefundRecord>>(`/ops/refunds/${refundRef(id)}/abort`, { reason });
  return data;
}

/** 客顯折讓預覽：金額／稅額由後端產生，綁 requestId＋previewToken（10 分鐘） */
export async function fetchAllowanceSignPreview(refundId: string) {
  const { data } = await staffApi.post<ApiResponse<AllowanceSignPreview>>(
    `/ops/refunds/${refundRef(refundId)}/signature-preview`,
    {},
  );
  return data;
}

/** 客顯親簽歸檔：multipart（previewToken、requestId、signature＝PNG Blob），簽名不轉 Base64 */
export async function submitRefundSignature(
  refundId: string,
  body: { previewToken: string; requestId: string; payloadHash: string; pointCount: number; strokeCount: number; pathLength: number; signatureBlob: Blob },
) {
  const form = new FormData();
  form.append('previewToken', body.previewToken);
  form.append('requestId', body.requestId);
  form.append('payloadHash', body.payloadHash);
  form.append('pointCount', String(body.pointCount));
  form.append('strokeCount', String(body.strokeCount));
  form.append('pathLength', String(body.pathLength));
  form.append('signature', body.signatureBlob, `${body.requestId}.png`);
  // 勿手設 Content-Type，讓瀏覽器帶 multipart boundary
  const { data } = await staffApi.post<ApiResponse<RefundRecord>>(`/ops/refunds/${refundRef(refundId)}/signature`, form);
  return data;
}

export async function fetchAllowances(params?: {
  from?: string;
  to?: string;
  branchId?: number;
  allowanceNo?: string;
  invoiceNumber?: string;
  memberId?: number;
  member?: string;
  subOrderId?: string;
  refundId?: string;
  q?: string;
  exportState?: AllowanceExportState;
  take?: number;
}) {
  const { data } = await staffApi.get<ApiResponse<AllowanceListPayload>>('/ops/allowances', { params });
  return data;
}

export type AllowanceExportState = 'ALL' | 'EXPORTED' | 'UNEXPORTED';

export type AllowanceExportFilters = {
  from: string;
  to: string;
  branchId?: number;
  allowanceNo?: string;
  invoiceNumber?: string;
  member?: string;
  subOrderId?: string;
  exportState?: AllowanceExportState;
  /** true 才寫入 exportedToAcctAt；false 只回對帳檔，可重複下載 */
  markExported?: boolean;
};

/** 會計匯出：後端回 columns／rows 並標記首次匯出時間（前端只排版） */
export async function exportAllowancesForAccounting(filters: AllowanceExportFilters) {
  const { data } = await staffApi.post<ApiResponse<AllowanceExportPayload>>('/ops/allowances/export', filters);
  return data;
}

/** id＝IAL… 或折讓號；purpose=print 才計入列印次數（客顯推送用 display） */
export async function fetchAllowancePrintPayload(idOrNo: string, purpose: 'print' | 'display' = 'print') {
  const { data } = await staffApi.get<ApiResponse<AllowancePrintPayload>>(
    `/ops/allowances/${encodeURIComponent(String(idOrNo || '').trim())}/print-payload`,
    { params: { purpose } },
  );
  return data;
}

export async function fetchOpsCardSubscriptions(params?: {
  memberNo?: string;
  memberId?: number;
  status?: string;
}) {
  const { data } = await staffApi.get<ApiResponse<CardSubscription[]>>('/ops/card-subscriptions', {
    params,
  });
  return data;
}

function normalizeSubscriptionRef(id: string) {
  return String(id || '').trim().toUpperCase();
}

export async function previewCancelCardSubscription(id: string) {
  const ref = encodeURIComponent(normalizeSubscriptionRef(id));
  const { data } = await staffApi.get(`/ops/card-subscriptions/${ref}/cancel-preview`);
  return data;
}

export async function cancelOpsCardSubscription(
  id: string,
  options?: {
    reason?: string;
    expirePolicy?: 'KEEP' | 'CUT_UNUSED' | 'CUT_NO_ALLOWANCE';
    doAllowance?: boolean;
    settle?: boolean;
  },
) {
  const ref = encodeURIComponent(normalizeSubscriptionRef(id));
  const { data } = await staffApi.post(
    `/ops/card-subscriptions/${ref}/cancel`,
    {
      ...(options?.reason?.trim() ? { reason: options.reason.trim() } : {}),
      ...(options?.expirePolicy ? { expirePolicy: options.expirePolicy } : {}),
      ...(options?.doAllowance != null ? { doAllowance: options.doAllowance } : {}),
      ...(options?.settle ? { settle: true } : {}),
    },
  );
  return data;
}

export async function pauseOpsCardSubscription(id: string) {
  const ref = encodeURIComponent(normalizeSubscriptionRef(id));
  const { data } = await staffApi.post<ApiResponse<CardSubscription>>(
    `/ops/card-subscriptions/${ref}/pause`,
  );
  return data;
}

export async function resumeOpsCardSubscription(id: string) {
  const ref = encodeURIComponent(normalizeSubscriptionRef(id));
  const { data } = await staffApi.post<ApiResponse<CardSubscription>>(
    `/ops/card-subscriptions/${ref}/resume`,
  );
  return data;
}

export async function rebindOpsCardSubscription(id: string) {
  const ref = encodeURIComponent(normalizeSubscriptionRef(id));
  const { data } = await staffApi.post<
    ApiResponse<{
      subscriptionId: string;
      actionUrl: string;
      payload: Record<string, string>;
      bindOnly?: boolean;
      rebind?: boolean;
      rebindPending?: boolean;
      periodAmt?: number;
      periodTimes?: number;
      messageHint?: string;
    }>
  >(`/ops/card-subscriptions/${ref}/rebind`);
  return data;
}

export async function fetchOpsCardSubscriptionRebindStatus(id: string) {
  const ref = encodeURIComponent(normalizeSubscriptionRef(id));
  const { data } = await staffApi.get<
    ApiResponse<{
      subscriptionId: string;
      status: string;
      rebindPending: boolean;
      hasCreditHash: boolean;
      creditUpdated: boolean;
      lastError?: string | null;
      updatedAt?: string;
      nextChargeAt?: string | null;
    }>
  >(`/ops/card-subscriptions/${ref}/rebind-status`);
  return data;
}

export async function runDueCardSubscriptions(limit?: number) {
  const { data } = await staffApi.post('/ops/card-subscriptions/run-due', {
    ...(limit != null ? { limit } : {}),
  });
  return data;
}

export async function fetchOpsMemberLeaves(params?: {
  memberNo?: string;
  memberId?: number;
  status?: string;
}) {
  const { data } = await staffApi.get('/ops/member-leaves', { params });
  return data;
}

export async function startOpsMemberLeave(body: {
  memberNo?: string;
  memberId?: number;
  days: number;
  reason?: string;
  subscriptionId?: string;
}) {
  const { data } = await staffApi.post('/ops/member-leaves', body);
  return data;
}

export async function endOpsMemberLeave(
  leaveId: number,
  options?: { reason?: string; resumeSubscription?: boolean },
) {
  const { data } = await staffApi.post(`/ops/member-leaves/${leaveId}/end`, options || {});
  return data;
}

export async function completeOpsMemberLeave(leaveId: number) {
  const { data } = await staffApi.post(`/ops/member-leaves/${leaveId}/complete`);
  return data;
}

export async function opsCancelGate(logId: number | string, reason?: string) {
  const { data } = await staffApi.post('/ops/cancel-gate', {
    logId,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
  });
  return data;
}

export async function fetchOpsActiveCheckIns(branchId?: number | '') {
  const { data } = await staffApi.get('/ops/check-ins/active', {
    params: branchId === '' || branchId == null ? undefined : { branchId },
  });
  return data;
}

/** 櫃檯補登出場（依進場快照計費） */
export async function opsManualCheckOut(logId: number | string) {
  const { data } = await staffApi.post(`/ops/check-ins/${logId}/check-out`);
  return data;
}

export async function opsBindFace(memberId: number, faceImage: string) {
  const { data } = await staffApi.post(`/ops/members/${memberId}/face`, { faceImage });
  return data;
}

export async function resetMemberDevice(memberId: number) {
  const { data } = await staffApi.post(`/admin/members/${memberId}/reset-device`);
  return data;
}

// ── HQ ──
export async function fetchHqOverview() {
  const { data } = await staffApi.get('/hq/overview');
  return data;
}

export async function fetchBranches() {
  const { data } = await staffApi.get<ApiResponse<Branch[]>>('/hq/branches');
  return data;
}

export async function createBranch(
  name: string,
  address?: string,
  opts?: {
    code: string;
    type?: BranchType;
    parentId?: number | null;
    legalEntityId?: number | null;
  },
) {
  const { data } = await staffApi.post<ApiResponse<Branch>>('/hq/branches', {
    name,
    address,
    code: opts?.code,
    type: opts?.type,
    parentId: opts?.parentId ?? null,
    ...(opts?.legalEntityId !== undefined ? { legalEntityId: opts.legalEntityId } : {}),
  });
  return data;
}

export async function updateHqBranch(
  id: number,
  payload: Partial<{
    name: string;
    code: string;
    type: BranchType;
    parentId: number | null;
    address: string | null;
    isActive: boolean;
    legalEntityId: number | null;
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<Branch>>(`/hq/branches/${id}`, payload);
  return data;
}

/** 無關聯則硬刪；有歷史／綁定則軟刪（isActive=false） */
export async function deleteHqBranch(id: number) {
  const { data } = await staffApi.delete<ApiResponse<Branch | { id: number }>>(`/hq/branches/${id}`);
  return data;
}

export async function fetchHqGateDevices(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<GateDevice[]>>('/hq/gate-devices', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function createHqGateDevice(payload: {
  code: string;
  name: string;
  branchId: number;
}) {
  const { data } = await staffApi.post<ApiResponse<GateDevice>>('/hq/gate-devices', payload);
  return data;
}

export async function updateHqGateDevice(
  id: number,
  payload: Partial<{ code: string; name: string; branchId: number; isActive: boolean }>,
) {
  const { data } = await staffApi.patch<ApiResponse<GateDevice>>(
    `/hq/gate-devices/${id}`,
    payload,
  );
  return data;
}

export async function rotateHqGateDeviceKey(id: number) {
  const { data } = await staffApi.post<ApiResponse<GateDevice>>(
    `/hq/gate-devices/${id}/rotate-key`,
  );
  return data;
}

export async function fetchHqVenues(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<Venue[]>>('/hq/venues', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function createVenue(
  branchId: number,
  name: string,
  stations?: string,
) {
  const { data } = await staffApi.post<ApiResponse<Venue>>('/hq/venues', {
    branchId,
    name,
    ...(stations !== undefined ? { stations } : {}),
  });
  return data;
}

export async function updateHqVenue(
  id: number,
  payload: { name?: string; stations?: string },
) {
  const { data } = await staffApi.patch<ApiResponse<Venue>>(`/hq/venues/${id}`, payload);
  return data;
}

export async function deleteHqVenue(id: number) {
  const { data } = await staffApi.delete<ApiResponse<{ id: number }>>(`/hq/venues/${id}`);
  return data;
}

export async function fetchHqPromotions(branchId?: number, kind?: 'SALE' | 'COMPENSATION') {
  const { data } = await staffApi.get<ApiResponse<Promotion[]>>('/hq/promotions', {
    params: {
      ...(branchId ? { branchId } : {}),
      ...(kind ? { kind } : {}),
    },
  });
  return data;
}

export async function createPromotion(payload: {
  branchIds: number[];
  name: string;
  price: number;
  bonusGiven?: number;
  kind?: 'SALE' | 'COMPENSATION';
  usageType?: 'TIMED' | 'UNLIMITED';
  planMode?: 'STANDING' | 'CAMPAIGN';
  saleStartAt?: string | null;
  saleEndAt?: string | null;
  durationDays?: number | null;
  unitDays?: number | null;
  periodCount?: number | null;
  requiresMemberContract?: boolean;
  enableCardRecurring?: boolean;
  recurringAmount?: number | null;
  payuniPeriodHash?: string | null;
  payuniPeriodHashOnline?: string | null;
  contractIds?: number[];
}) {
  const { data } = await staffApi.post<ApiResponse<Promotion | Promotion[]>>('/hq/promotions', payload);
  return data;
}

export async function updateHqPromotion(
  id: number,
  payload: Partial<{
    name: string;
    price: number;
    bonusGiven: number;
    kind: 'SALE' | 'COMPENSATION';
    usageType: 'TIMED' | 'UNLIMITED';
    planMode: 'STANDING' | 'CAMPAIGN';
    saleStartAt: string | null;
    saleEndAt: string | null;
    durationDays: number | null;
    unitDays: number | null;
    periodCount: number | null;
    requiresMemberContract: boolean;
    enableCardRecurring: boolean;
    recurringAmount: number | null;
    payuniPeriodHash: string | null;
    payuniPeriodHashOnline: string | null;
    isActive: boolean;
    contractIds: number[];
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<Promotion>>(`/hq/promotions/${id}`, payload);
  return data;
}

export async function searchHqMembers(q: string) {
  const { data } = await staffApi.get<
    ApiResponse<
      Pick<
        OpsMember,
        | 'id'
        | 'memberNo'
        | 'name'
        | 'phone'
        | 'plan'
        | 'expireDate'
        | 'cashWallet'
        | 'bonusWallet'
        | 'isAlert'
      >[]
    >
  >('/hq/members/search', { params: { q } });
  return data;
}

export async function fetchHqCompensationLogs(params?: {
  memberId?: number;
  action?: string;
  limit?: number;
}) {
  const { data } = await staffApi.get<ApiResponse<HqCompensationLog[]>>('/hq/compensation-logs', {
    params,
  });
  return data;
}

export async function compensateHqMemberBonus(
  memberId: number,
  payload: { promotionId: number; reason: string },
) {
  const { data } = await staffApi.post<
    ApiResponse<{
      member: OpsMember;
      bonusAdded: number;
      promotion: Promotion;
      log: HqCompensationLog;
    }>
  >(`/hq/members/${memberId}/compensate-bonus`, payload);
  return data;
}

export async function compensateHqMemberExpire(
  memberId: number,
  payload: { days: number; reason: string },
) {
  const { data } = await staffApi.post<
    ApiResponse<{
      member: OpsMember;
      days: number;
      expireDateBefore?: string | null;
      expireDateAfter?: string | null;
      log: HqCompensationLog;
    }>
  >(`/hq/members/${memberId}/compensate-expire`, payload);
  return data;
}

export async function clearHqMemberAlert(memberId: number, payload: { reason: string }) {
  const { data } = await staffApi.post<
    ApiResponse<{ member: OpsMember; alreadyCleared: boolean; log: HqCompensationLog }>
  >(`/hq/members/${memberId}/clear-alert`, payload);
  return data;
}

export async function compensateHqMemberCourse(
  memberId: number,
  payload: { coursePlanId: number; trainerId: number; reason: string },
) {
  const { data } = await staffApi.post<
    ApiResponse<{
      member: OpsMember;
      contract: {
        id: number;
        source: string;
        totalSessions: number;
        pricePaid: number;
        coursePlanId?: number | null;
      };
      sessions: number;
      coursePlan: CoursePlan;
      log: HqCompensationLog;
    }>
  >(`/hq/members/${memberId}/compensate-course`, payload);
  return data;
}

export async function deleteHqPromotion(id: number) {
  const { data } = await staffApi.delete<ApiResponse<Promotion | { id: number }>>(
    `/hq/promotions/${id}`,
  );
  return data;
}

export async function fetchHqCoursePlans(branchId?: number, kind?: 'SALE' | 'COMPENSATION') {
  const { data } = await staffApi.get<ApiResponse<CoursePlan[]>>('/hq/course-plans', {
    params: {
      ...(branchId ? { branchId } : {}),
      ...(kind ? { kind } : {}),
    },
  });
  return data;
}

export async function createHqCoursePlan(payload: {
  branchIds: number[];
  name: string;
  kind?: 'SALE' | 'COMPENSATION';
  planType: 'CUSTOM_PT' | 'GROUP';
  planMode?: 'STANDING' | 'CAMPAIGN';
  saleStartAt?: string | null;
  saleEndAt?: string | null;
  price: number;
  sessions?: number | null;
  capacity?: number | null;
  /** GROUP：單堂插班價（null＝不開放單堂） */
  dropInPrice?: number | null;
  /** GROUP：最低開班人數（0／null＝不設） */
  minEnrollment?: number | null;
  description?: string | null;
  enableCardRecurring?: boolean;
  recurringPeriods?: number | null;
  recurringAmount?: number | null;
  recurringAmount4?: number | null;
  recurringAmountFinal?: number | null;
  payuniPeriodHash?: string | null;
  payuniPeriodHashOnline?: string | null;
  requiresMemberContract?: boolean;
  enableSecondPerson?: boolean;
  giftLabel?: string | null;
  giftQty?: number | null;
  contractIds?: number[];
}) {
  const { data } = await staffApi.post<ApiResponse<CoursePlan | CoursePlan[]>>(
    '/hq/course-plans',
    payload,
  );
  return data;
}

export async function updateHqCoursePlan(
  id: number,
  payload: Partial<{
    name: string;
    kind: 'SALE' | 'COMPENSATION';
    planType: 'CUSTOM_PT' | 'GROUP';
    planMode: 'STANDING' | 'CAMPAIGN';
    saleStartAt: string | null;
    saleEndAt: string | null;
    price: number;
    sessions: number | null;
    capacity: number | null;
    dropInPrice: number | null;
    minEnrollment: number | null;
    description: string | null;
    enableCardRecurring: boolean;
    recurringPeriods: number | null;
    recurringAmount: number | null;
    recurringAmount4: number | null;
    recurringAmountFinal: number | null;
    payuniPeriodHash: string | null;
    payuniPeriodHashOnline: string | null;
    requiresMemberContract: boolean;
    enableSecondPerson: boolean;
    giftLabel: string | null;
    giftQty: number | null;
    contractIds: number[];
    isActive: boolean;
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<CoursePlan>>(`/hq/course-plans/${id}`, payload);
  return data;
}

export async function deleteHqCoursePlan(id: number) {
  const { data } = await staffApi.delete<ApiResponse<CoursePlan | { id: number }>>(
    `/hq/course-plans/${id}`,
  );
  return data;
}

export async function fetchHqTrainers() {
  const { data } = await staffApi.get<ApiResponse<Trainer[]>>('/hq/trainers');
  return data;
}

export async function createHqTrainer(payload: {
  name: string;
  phone: string;
  role?: TrainerRole;
  level?: TrainerLevel;
  displayName?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<Trainer>>('/hq/trainers', payload);
  return data;
}

export async function updateHqTrainer(
  id: number,
  payload: Partial<{
    name: string;
    phone: string;
    role: TrainerRole;
    level: TrainerLevel;
    isActive: boolean;
    staffId: number | null;
    displayName: string;
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<Trainer>>(`/hq/trainers/${id}`, payload);
  return data;
}

export async function assignTrainer(
  trainerId: number,
  role: TrainerRole,
  branchIds: number[],
  level?: TrainerLevel,
) {
  const { data } = await staffApi.post('/hq/trainers/assign', {
    trainerId,
    role,
    branchIds,
    level,
  });
  return data;
}

// ── HQ 進銷存／電子發票（ADMIN）──

export type LegalEntityInput = {
  code: string;
  name: string;
  ubn: string;
  address: string | null;
  phone: string | null;
  ezpayMerchantId: string | null;
  isActive: boolean;
};

export async function fetchHqLegalEntities() {
  const { data } = await staffApi.get<ApiResponse<LegalEntity[]>>('/hq/legal-entities');
  return data;
}

export async function createHqLegalEntity(payload: Partial<LegalEntityInput>) {
  const { data } = await staffApi.post<ApiResponse<LegalEntity>>('/hq/legal-entities', payload);
  return data;
}

export async function updateHqLegalEntity(id: number, payload: Partial<LegalEntityInput>) {
  const { data } = await staffApi.patch<ApiResponse<LegalEntity>>(`/hq/legal-entities/${id}`, payload);
  return data;
}

/** 主檔不含庫存／成本：庫存走進貨／盤點，成本由驗收移動平均 */
export type ProductMasterInput = {
  sku: string;
  barcode: string | null;
  name: string;
  invoiceName: string | null;
  unit: string;
  productKind: ProductKind;
  taxType: TaxType;
  listPrice: number;
  isActive: boolean;
};

export async function fetchHqProducts(params?: { q?: string; activeOnly?: boolean }) {
  const { data } = await staffApi.get<ApiResponse<ProductMaster[]>>('/hq/products', {
    params: {
      ...(params?.q ? { q: params.q } : {}),
      ...(params?.activeOnly ? { active: '1' } : {}),
    },
  });
  return data;
}

export async function createHqProduct(payload: Partial<ProductMasterInput>) {
  const { data } = await staffApi.post<ApiResponse<ProductMaster>>('/hq/products', payload);
  return data;
}

export async function updateHqProduct(id: number, payload: Partial<ProductMasterInput>) {
  const { data } = await staffApi.patch<ApiResponse<ProductMaster>>(`/hq/products/${id}`, payload);
  return data;
}

export async function fetchHqBranchStocks(params?: { branchId?: number; productId?: number; q?: string }) {
  const { data } = await staffApi.get<ApiResponse<BranchStockRow[]>>('/hq/branch-stocks', { params });
  return data;
}

/** 分店上架設定（售價／安全庫存／上架）；不可改 onHand */
export async function upsertHqBranchStock(payload: {
  branchId: number;
  productId: number;
  salePrice?: number | null;
  safetyStock?: number | null;
  isListed?: boolean;
}) {
  const { data } = await staffApi.put<ApiResponse<BranchStockRow>>('/hq/branch-stocks', payload);
  return data;
}

export async function fetchHqStockMovements(params?: {
  branchId?: number;
  productId?: number;
  refType?: string;
  from?: string;
  to?: string;
}) {
  const { data } = await staffApi.get<ApiResponse<StockMovement[]>>('/hq/stock-movements', { params });
  return data;
}

export type StockTransferResult = { transferId: string; items: { productId: number; qty: number; unitCost: number }[] };

export async function createHqStockTransfer(payload: {
  fromBranchId: number;
  toBranchId: number;
  items: { productId: number; qty: number }[];
  note?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<StockTransferResult>>('/hq/stock-transfers', payload);
  return data;
}

export type SupplierInput = {
  name: string;
  ubn: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  paymentTermType: SupplierPaymentTerm;
  paymentTermDays: number;
  note: string | null;
  isActive: boolean;
};

export async function fetchHqSuppliers(activeOnly = false) {
  const { data } = await staffApi.get<ApiResponse<Supplier[]>>('/hq/suppliers', {
    params: activeOnly ? { active: '1' } : undefined,
  });
  return data;
}

export async function createHqSupplier(payload: Partial<SupplierInput>) {
  const { data } = await staffApi.post<ApiResponse<Supplier>>('/hq/suppliers', payload);
  return data;
}

export async function updateHqSupplier(id: number, payload: Partial<SupplierInput>) {
  const { data } = await staffApi.patch<ApiResponse<Supplier>>(`/hq/suppliers/${id}`, payload);
  return data;
}

export type PurchaseOrderLineInput = { productId: number; qty: number; unitCost: number; taxType?: TaxType };

export async function fetchHqPurchaseOrders(params?: {
  status?: string;
  branchId?: number;
  supplierId?: number;
  legalEntityId?: number;
}) {
  const { data } = await staffApi.get<ApiResponse<PurchaseOrder[]>>('/hq/purchase-orders', { params });
  return data;
}

export async function createHqPurchaseOrder(payload: {
  branchId: number;
  supplierId: number;
  items: PurchaseOrderLineInput[];
  expectedAt?: string | null;
  note?: string | null;
}) {
  const { data } = await staffApi.post<ApiResponse<PurchaseOrder>>('/hq/purchase-orders', payload);
  return data;
}

export async function updateHqPurchaseOrder(
  id: string,
  payload: Partial<{ supplierId: number; items: PurchaseOrderLineInput[]; expectedAt: string | null; note: string | null }>,
) {
  const { data } = await staffApi.patch<ApiResponse<PurchaseOrder>>(
    `/hq/purchase-orders/${encodeURIComponent(id)}`,
    payload,
  );
  return data;
}

/** order＝送出採購；cancel＝取消（必填原因）；close＝短交結案 */
export async function transitionHqPurchaseOrder(id: string, action: 'order' | 'cancel' | 'close', reason?: string) {
  const { data } = await staffApi.post<ApiResponse<PurchaseOrder>>(
    `/hq/purchase-orders/${encodeURIComponent(id)}/${action}`,
    reason ? { reason } : {},
  );
  return data;
}

export async function fetchHqPurchaseReceipts(params?: { branchId?: number; supplierId?: number; purchaseOrderId?: string }) {
  const { data } = await staffApi.get<ApiResponse<PurchaseReceipt[]>>('/hq/purchase-receipts', { params });
  return data;
}

/** 總部驗收：依採購單（進價預設取採購單）或無單進貨（需分店＋供應商＋進價） */
export async function createHqPurchaseReceipt(payload: {
  purchaseOrderId?: string;
  branchId?: number;
  supplierId?: number;
  items: { poItemId?: number; productId?: number; qty: number; unitCost?: number }[];
  supplierInvoiceNo?: string;
  supplierInvoiceDate?: string;
  note?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<{ receipt: PurchaseReceipt; payable: SupplierPayable }>>(
    '/hq/purchase-receipts',
    payload,
  );
  return data;
}

export async function setHqReceiptSupplierInvoice(
  receiptId: string,
  payload: { supplierInvoiceNo: string; supplierInvoiceDate?: string },
) {
  const { data } = await staffApi.patch<ApiResponse<PurchaseReceipt>>(
    `/hq/purchase-receipts/${encodeURIComponent(receiptId)}/supplier-invoice`,
    payload,
  );
  return data;
}

/** status：UNPAID（未付＋部分付）／OPEN／PARTIAL／PAID／VOID */
export async function fetchHqPayables(params?: { status?: string; legalEntityId?: number; supplierId?: number }) {
  const { data } = await staffApi.get<ApiResponse<SupplierPayable[]>>('/hq/payables', { params });
  return data;
}

export async function fetchHqPayableAging(legalEntityId?: number) {
  const { data } = await staffApi.get<ApiResponse<PayableAgingRow[]>>('/hq/payables/aging', {
    params: legalEntityId ? { legalEntityId } : undefined,
  });
  return data;
}

export async function voidHqPayable(id: string, reason: string) {
  const { data } = await staffApi.post<ApiResponse<SupplierPayable>>(
    `/hq/payables/${encodeURIComponent(id)}/void`,
    { reason },
  );
  return data;
}

export async function fetchHqSupplierPayments(params?: { legalEntityId?: number; supplierId?: number }) {
  const { data } = await staffApi.get<ApiResponse<SupplierPayment[]>>('/hq/supplier-payments', { params });
  return data;
}

/** 沖銷合計須等於付款金額（後端驗證） */
export async function createHqSupplierPayment(payload: {
  legalEntityId: number;
  supplierId: number;
  amount: number;
  method: SupplierPaymentMethod;
  paidAt?: string;
  reference?: string;
  note?: string;
  allocations: { payableId: string; amount: number }[];
}) {
  const { data } = await staffApi.post<ApiResponse<SupplierPayment>>('/hq/supplier-payments', payload);
  return data;
}

export async function fetchHqEInvoices(params?: {
  q?: string;
  status?: string;
  legalEntityId?: number;
  branchId?: number;
  category?: 'B2B' | 'B2C';
  from?: string;
  to?: string;
}) {
  const { data } = await staffApi.get<ApiResponse<EInvoiceRow[]>>('/hq/einvoices', { params });
  return data;
}

export async function retryHqEInvoice(id: string) {
  const { data } = await staffApi.post<ApiResponse<InvoiceIssueJobRow>>(
    `/hq/einvoices/${encodeURIComponent(id)}/retry`,
  );
  return data;
}

export async function fetchHqEInvoiceLogs(id: string) {
  const { data } = await staffApi.get<ApiResponse<EInvoiceLogRow[]>>(`/hq/einvoices/${encodeURIComponent(id)}/logs`);
  return data;
}

/** 跨營業人 ezPay 呼叫紀錄；result 省略時後端只回 FAILED */
export async function fetchHqEInvoiceCallLogs(params?: {
  result?: '' | 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  action?: 'ISSUE' | 'RECOVER' | 'VOID' | 'ALLOWANCE';
  legalEntityId?: number;
  from?: string;
  to?: string;
}) {
  const { data } = await staffApi.get<ApiResponse<EInvoiceLogRow[]>>('/hq/einvoice-logs', { params });
  return data;
}

// ── 門市進銷存（DUTY+，限可操作分店）──

export async function fetchOpsStocks(params?: { branchId?: number; q?: string }) {
  const { data } = await staffApi.get<ApiResponse<BranchStockRow[]>>('/ops/inventory/stocks', { params });
  return data;
}

export async function createOpsStockAdjustment(payload: {
  branchId: number;
  productId: number;
  reason: 'LOSS' | 'GAIN' | 'COUNT';
  qty: number;
  note?: string | null;
}) {
  const { data } = await staffApi.post<
    ApiResponse<{ productId: number; onHand: number; previousQty: number; reason: string; movement: StockMovement | null }>
  >('/ops/inventory/stock-adjustments', payload);
  return data;
}

export async function fetchOpsStockMovements(params?: {
  branchId?: number;
  productId?: number;
  refType?: string;
}) {
  const { data } = await staffApi.get<ApiResponse<StockMovement[]>>('/ops/inventory/stock-movements', {
    params,
  });
  return data;
}

/** 待驗收採購單（ORDERED／PARTIAL） */
export async function fetchOpsPendingPurchaseOrders(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<PurchaseOrder[]>>('/ops/inventory/purchase-orders', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

/** 門市驗收只能依採購單、只送數量（進價以採購單為準） */
export async function createOpsReceipt(payload: {
  purchaseOrderId: string;
  items: { poItemId: number; qty: number }[];
  supplierInvoiceNo?: string;
  supplierInvoiceDate?: string;
  note?: string;
}) {
  const { data } = await staffApi.post<
    ApiResponse<{ receiptId: string; purchaseOrderId: string; payableId: string; items: number }>
  >('/ops/inventory/receipts', payload);
  return data;
}

export async function fetchOpsReceipts(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<OpsReceiptRow[]>>('/ops/inventory/receipts', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

/** 同營業人分店間調撥；跨統編 409 */
export async function createOpsTransfer(payload: {
  fromBranchId: number;
  toBranchId: number;
  items: { productId: number; qty: number }[];
  note?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<StockTransferResult>>('/ops/inventory/transfers', payload);
  return data;
}

export async function fetchHqStaffPhoto(id: number) {
  const { data } = await staffApi.get<ApiResponse<StaffAvatar | null>>(`/hq/staff/${id}/photo`);
  return data;
}

/** 上傳員工照片；enrollFace=true 須員工已親簽有效之生物辨識電子同意書 */
export async function uploadHqStaffPhoto(id: number, image: string, enrollFace: boolean) {
  const { data } = await staffApi.post<ApiResponse<StaffPhotoStatus>>(`/hq/staff/${id}/photo`, {
    image,
    enrollFace,
  });
  return data;
}

export async function fetchStaffBiometricsConsentTemplate() {
  const { data } = await staffApi.get<ApiResponse<StaffConsentTemplate>>('/hq/staff-consent/biometrics');
  return data;
}

/** 目前有效之員工生物辨識簽署（含簽名影像）；未簽 data=null */
export async function fetchHqStaffFaceConsent(id: number) {
  const { data } = await staffApi.get<ApiResponse<StaffFaceConsent | null>>(`/hq/staff/${id}/face-consent`);
  return data;
}

/** 員工親簽生物辨識同意書；bodyHash 須為目前條文版本 */
export async function signHqStaffFaceConsent(id: number, signatureData: string, bodyHash: string) {
  const { data } = await staffApi.post<
    ApiResponse<{ id: number; version: string; signerName: string; signedAt: string }>
  >(`/hq/staff/${id}/face-consent`, { signatureData, bodyHash });
  return data;
}

export async function deleteHqStaffPhoto(id: number) {
  const { data } = await staffApi.delete<ApiResponse<StaffPhotoStatus>>(`/hq/staff/${id}/photo`);
  return data;
}

/** 撤回生物辨識同意（刪 Face8 特徵，保留頭像） */
export async function revokeHqStaffFace(id: number) {
  const { data } = await staffApi.delete<ApiResponse<StaffPhotoStatus>>(`/hq/staff/${id}/face`);
  return data;
}

export async function fetchHqStaff() {
  const { data } = await staffApi.get<ApiResponse<StaffAccount[]>>('/hq/staff');
  return data;
}

export async function createHqStaff(payload: {
  account: string;
  password: string;
  name: string;
  displayName?: string;
  role: StaffRole;
  branchId?: number | null;
  permissions: StaffPermission[];
  employmentType: EmploymentType;
  hireDate: string;
  weeklyHours?: number | null;
  laborActApplies?: boolean;
}) {
  const { data } = await staffApi.post<ApiResponse<StaffAccount>>('/hq/staff', payload);
  return data;
}

export async function updateHqStaff(
  id: number,
  payload: Partial<{
    name: string;
    displayName: string;
    role: StaffRole;
    branchId: number | null;
    permissions: StaffPermission[];
    isActive: boolean;
    password: string;
    employmentType: EmploymentType;
    hireDate: string | null;
    weeklyHours: number | null;
    laborActApplies: boolean;
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<StaffAccount>>(`/hq/staff/${id}`, payload);
  return data;
}

export async function fetchOpsBranches() {
  const { data } = await staffApi.get<ApiResponse<Branch[]>>('/ops/branches');
  return data;
}

export async function fetchOpsShiftCurrent(branchId: number) {
  const { data } = await staffApi.get('/ops/shift/current', { params: { branchId } });
  return data;
}

export async function fetchOpsShiftHistory(branchId: number, take?: number) {
  const { data } = await staffApi.get('/ops/shift/history', {
    params: { branchId, ...(take != null ? { take } : {}) },
  });
  return data;
}

/** 乙禾 EDC 日結對帳 */
export async function fetchOpsYipayReconcile(params?: {
  day?: string;
  branchId?: number | '';
  edcCount?: number | string;
  edcAmount?: number | string;
}) {
  const { data } = await staffApi.get<
    ApiResponse<{
      day: string;
      system: { count: number; amount: number; items: Array<{ kind: string; id: string; amount: number }> };
      captures: {
        confirmedCount: number;
        confirmedAmount: number;
        pendingCount: number;
        pendingAmount: number;
        orphanCount: number;
        pending: Array<{ id: string; targetType: string; targetId: string; amount: number; rrn?: string | null; status: string }>;
        orphans: Array<{ id: string; targetType: string; targetId: string; amount: number; rrn?: string | null; status: string }>;
      };
      edcCompare: {
        edcCount: number;
        edcAmount: number;
        systemCount: number;
        systemAmount: number;
        countDiff: number;
        amountDiff: number;
        matched: boolean;
      } | null;
      hints: string[];
      needsAttention: boolean;
      pendingCount?: number;
      orphanCount?: number;
      pending?: Array<{
        id: string;
        targetType: string;
        targetId: string;
        amount: number;
        rrn?: string | null;
        status: string;
      }>;
      orphans?: Array<{
        id: string;
        targetType: string;
        targetId: string;
        amount: number;
        rrn?: string | null;
        status: string;
      }>;
    }>
  >('/ops/yipay/reconcile', {
    params: {
      ...(params?.day ? { day: params.day } : {}),
      ...(params?.branchId !== undefined && params.branchId !== ''
        ? { branchId: params.branchId }
        : {}),
      ...(params?.edcCount != null && params.edcCount !== ''
        ? { edcCount: params.edcCount }
        : {}),
      ...(params?.edcAmount != null && params.edcAmount !== ''
        ? { edcAmount: params.edcAmount }
        : {}),
    },
  });
  return data;
}

export type InvoiceIssueJobRow = {
  id: string;
  refType: string;
  refId: string;
  leg: string;
  amount: number;
  itemDesc: string;
  status: string;
  retryCount: number;
  lastError?: string | null;
  invoiceNumber?: string | null;
  checkoutId?: string | null;
  updatedAt?: string;
  /** 原始電子發票狀態（status 為佇列相容值） */
  einvoiceStatus?: string;
  category?: 'B2B' | 'B2C';
  branchId?: number | null;
  legalEntity?: { id: number; code: string; name: string } | null;
};

export async function fetchOpsInvoiceJobs(params?: {
  status?: string;
  take?: number;
  checkoutId?: string;
}) {
  const { data } = await staffApi.get<ApiResponse<{ items: InvoiceIssueJobRow[] }>>(
    '/ops/invoice-jobs',
    {
      params: {
        ...(params?.status ? { status: params.status } : {}),
        ...(params?.take != null ? { take: params.take } : {}),
        ...(params?.checkoutId ? { checkoutId: params.checkoutId } : {}),
      },
    },
  );
  return data;
}

export async function retryOpsInvoiceJob(jobId: string) {
  const { data } = await staffApi.post<ApiResponse<InvoiceIssueJobRow>>(
    `/ops/invoice-jobs/${encodeURIComponent(jobId)}/retry`,
  );
  return data;
}

export async function openOpsShift(body: {
  branchId: number;
  slot: 'MORNING' | 'EVENING' | 'MIDDAY';
  note?: string;
}) {
  const { data } = await staffApi.post('/ops/shift/open', body);
  return data;
}

export async function closeOpsShift(
  shiftId: string,
  body: {
    countedCash?: number;
    matchExpected?: boolean;
    note?: string;
    cashDenominations?: Record<string, number>;
    closeChecklist?: Record<string, boolean>;
  },
) {
  const { data } = await staffApi.post(`/ops/shift/${encodeURIComponent(shiftId)}/close`, body);
  return data;
}

export async function fetchOpsProducts(branchId: number) {
  const { data } = await staffApi.get<ApiResponse<Product[]>>('/ops/products', {
    params: { branchId },
  });
  return data;
}

export async function posCheckout(payload: {
  branchId: number;
  memberId?: number;
  payMethod?: PosPayMethod;
  payments?: { method: string; amount: number; voucherCode?: string }[];
  items: { productId: number; qty: number }[];
  carrierNum?: string;
  buyerUbn?: string;
  loveCode?: string;
  cardMode?: 'LUMP' | 'INSTALLMENT' | 'RECURRING';
  cardInst?: number;
  periodType?: 'W' | 'M' | 'Y';
  periodTimes?: number;
}) {
  const { data } = await staffApi.post<ApiResponse<PosCheckoutResult>>('/ops/pos/checkout', payload);
  return data;
}

/** 幕前金流：同頁導向（一次付清／分期） */
function redirectToCheckOut(actionUrl: string, payload: Record<string, string>) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = actionUrl;
  for (const key of Object.keys(payload)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = key;
    input.value = payload[key];
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/**
 * 續期收款：另開分頁送 PayUNi（該支付頁不回流 ReturnURL）
 * 原頁靠 Notify + 輪詢完成交易收尾
 */
function openPayuniCheckoutInNewTab(actionUrl: string, payload: Record<string, string>) {
  const win = window.open('about:blank', 'payuni_period_checkout');
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = actionUrl;
  form.target = win ? 'payuni_period_checkout' : '_blank';
  for (const key of Object.keys(payload)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = key;
    input.value = payload[key];
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
  return win;
}

export async function fetchOpsCheckoutStatus(ref: string) {
  const id = encodeURIComponent(String(ref || '').trim());
  const { data } = await staffApi.get<
    ApiResponse<{
      kind: 'checkout' | 'order';
      checkoutId?: string | null;
      orderId?: string | null;
      saleId?: string | null;
      payStatus: string;
      amount: number;
      cardAmount?: number;
      cardMode?: string | null;
      merchantNo?: string | null;
      invoiceNumber?: string | null;
      ptFulfilled?: boolean | null;
      hasCreditHash?: boolean;
      updatedAt?: string;
    }>
  >(`/ops/checkout/${id}`);
  return data;
}

export { redirectToCheckOut, openPayuniCheckoutInNewTab };

// ── PT／團課管理 ──
export async function fetchPtDashboard() {
  const { data } = await staffApi.get('/pt/dashboard-data');
  return data;
}

/** 團課期班開班：價格／堂數／最低開班人數快照自 GROUP 課程方案，展開堂數須等於方案堂數 */
export async function scheduleGroupClass(payload: {
  coursePlanId: number;
  title?: string;
  venueId: number;
  stationId?: number;
  /** 期班開始日 YYYY-MM-DD */
  startDate: string;
  /** 期班結束日 YYYY-MM-DD（含） */
  endDate: string;
  /** 每週幾 0=日…6=六（可多選） */
  weekdays: number[];
  startTime: string;
  endTime: string;
  /** 省略＝沿用課程方案人數上限 */
  capacity?: number;
  trainerId: number;
  /** 報名截止 YYYY-MM-DD（省略＝開課前 2 日） */
  enrollDeadline?: string;
}) {
  const { data } = await staffApi.post('/pt/schedule-group-class', payload);
  return data;
}

export async function fetchGroupSeriesAdmin(includeEnded = false) {
  const { data } = await staffApi.get<ApiResponse<GroupAdminSeries[]>>('/pt/group-series', {
    params: includeEnded ? { includeEnded: '1' } : undefined,
  });
  return data;
}

export async function fetchGroupSeriesRoster(seriesId: number) {
  const { data } = await staffApi.get<ApiResponse<GroupSeriesRoster>>(`/pt/group-series/${seriesId}/roster`);
  return data;
}

/** 取消期班（限 ADMIN）：已報名者未履約部分全額退費 */
export async function cancelGroupSeries(seriesId: number, reason: string) {
  const { data } = await staffApi.post<
    ApiResponse<{ removedClasses: number; refunded: unknown[]; failed: unknown[] }>
  >(`/pt/group-series/${seriesId}/cancel`, { reason });
  return data;
}

// ── 櫃檯團課 ──
export async function fetchOpsGroupSellable(params: { branchId?: number; memberId?: number }) {
  const { data } = await staffApi.get<ApiResponse<GroupSellableSeries[]>>('/ops/group/sellable', { params });
  return data;
}

export async function fetchOpsGroupSeriesDetail(seriesId: number, memberId?: number) {
  const { data } = await staffApi.get<ApiResponse<GroupSeriesDetail>>(`/ops/group/series/${seriesId}`, {
    params: memberId ? { memberId } : undefined,
  });
  return data;
}

export async function fetchOpsMemberGroup(memberId: number) {
  const { data } = await staffApi.get<ApiResponse<GroupMemberOverview>>(`/ops/group/members/${memberId}`);
  return data;
}

export async function opsJoinGroupWaitlist(payload: { memberId: number; seriesId: number }) {
  const { data } = await staffApi.post<ApiResponse<{ id: number; position: number }>>(
    '/ops/group/waitlist',
    payload,
  );
  return data;
}

export async function fetchOpsGroupRefundPreview(enrollmentId: number) {
  const { data } = await staffApi.get<ApiResponse<GroupRefundPreview>>(
    `/ops/group/enrollments/${enrollmentId}/refund-preview`,
  );
  return data;
}

/** 團課退費（DUTY+）：金額由後端依消保公式計算，只送原因 */
export async function opsRefundGroupEnrollment(enrollmentId: number, reason: string) {
  const { data } = await staffApi.post<ApiResponse<{ refundAmount: number; fee: number }>>(
    `/ops/group/enrollments/${enrollmentId}/refund`,
    { reason },
  );
  return data;
}

export async function buyPtContract(payload: {
  memberId: number;
  trainerId: number;
  items: { coursePlanId: number; qty: number }[];
  carrierNum?: string;
  buyerUbn?: string;
  loveCode?: string;
}) {
  const { data } = await staffApi.post('/pt/buy-contract', payload);
  return data;
}

/** @deprecated 私教合約排課；團課請用 scheduleGroupClass */
export async function schedulePtSession(payload: {
  contractId: number;
  venueId: number;
  stationId?: number;
  startAt: string;
  endAt: string;
}) {
  const { data } = await staffApi.post('/pt/schedule-session', payload);
  return data;
}

// ── Trainer ──
export async function registerTrainer(name: string, phone: string, expertise?: string) {
  const { data } = await staffApi.post<ApiResponse<Trainer>>('/trainer/register', {
    name,
    phone,
    expertise,
  });
  return data;
}

export async function fetchTrainerDashboard(viewAsTrainerId?: number) {
  const { data } = await staffApi.get<ApiResponse<TrainerDashboardData>>('/trainer/dashboard', {
    params: viewAsTrainerId ? { viewAsTrainerId } : undefined,
  });
  return data;
}

export async function scheduleClass(payload: {
  venueId: number;
  stationId?: number;
  title: string;
  type?: string;
  startAt: string;
  endAt: string;
  capacity?: number;
  /** 僅總部代排時需要 */
  trainerId?: number;
}) {
  const { data } = await staffApi.post('/trainer/schedule-class', payload);
  return data;
}

export async function bookClass(memberId: number, classId: number) {
  const { data } = await staffApi.post('/trainer/book-class', { memberId, classId });
  return data;
}

/** 代約私教：依購買合約自選日期／時間開堂＋扣堂 */
export async function schedulePrivateSession(payload: {
  contractId: number;
  venueId: number;
  stationId?: number;
  startAt: string;
  endAt: string;
  viewAsTrainerId?: number;
}) {
  const { data } = await staffApi.post('/trainer/schedule-private', payload);
  return data;
}

/** 拖拉改期：僅改時間／場地，不重扣堂 */
export async function rescheduleTrainerClass(
  classId: number,
  payload: {
    startAt: string;
    endAt: string;
    venueId?: number;
    stationId?: number | null;
    viewAsTrainerId?: number;
  },
) {
  const { data } = await staffApi.patch(`/trainer/classes/${classId}/reschedule`, payload);
  return data;
}

export async function fetchConsultGuests(params?: { q?: string; take?: number; viewAsTrainerId?: number }) {
  const { data } = await staffApi.get('/trainer/consult-guests', { params });
  return data;
}

export async function bookConsultGuest(body: {
  classId: number;
  name: string;
  phone: string;
  note?: string;
  consultGuestId?: number;
}) {
  const { data } = await staffApi.post('/trainer/book-consult', body);
  return data;
}

/** 諮詢客人代約：自選日期／時間開 CONSULT 堂（無需選課程） */
export async function scheduleConsultGuest(payload: {
  venueId: number;
  stationId?: number;
  startAt: string;
  endAt: string;
  name: string;
  phone: string;
  note?: string;
  consultGuestId?: number;
  capacity?: number;
  viewAsTrainerId?: number;
}) {
  const { data } = await staffApi.post('/trainer/schedule-consult', payload);
  return data;
}

export async function fetchTrainerTimeOffs(params?: {
  viewAsTrainerId?: number;
  from?: string;
  to?: string;
  take?: number;
}) {
  const { data } = await staffApi.get('/trainer/time-offs', {
    params: {
      viewAsTrainerId: params?.viewAsTrainerId,
      from: params?.from,
      to: params?.to,
      take: params?.take,
    },
  });
  return data;
}

export async function createTrainerTimeOff(body: {
  startAt: string;
  endAt: string;
  reason?: string;
  note?: string;
  viewAsTrainerId?: number;
  trainerId?: number;
}) {
  const { data } = await staffApi.post('/trainer/time-offs', body);
  return data;
}

export async function updateTrainerTimeOff(
  id: number,
  body: {
    startAt?: string;
    endAt?: string;
    reason?: string;
    note?: string | null;
    viewAsTrainerId?: number;
  },
) {
  const { data } = await staffApi.patch(`/trainer/time-offs/${id}`, body);
  return data;
}

export async function deleteTrainerTimeOff(id: number, viewAsTrainerId?: number) {
  const { data } = await staffApi.delete(`/trainer/time-offs/${id}`, {
    params: viewAsTrainerId ? { viewAsTrainerId } : undefined,
  });
  return data;
}

// ── HQ 報表 ──
export type ReportQuery = {
  from?: string;
  to?: string;
  q?: string;
  status?: string;
  branchId?: number;
  trainerId?: number;
};

export type ReportPayload<T> = {
  rows: T[];
  summary: Record<string, number>;
};

async function fetchHqReport<T>(path: string, params: ReportQuery) {
  const { data } = await staffApi.get<ApiResponse<ReportPayload<T>>>(`/hq/reports/${path}`, {
    params: {
      from: params.from || undefined,
      to: params.to || undefined,
      q: params.q || undefined,
      status: params.status || undefined,
      branchId: params.branchId || undefined,
      trainerId: params.trainerId || undefined,
    },
  });
  return data;
}

export function fetchOrdersReport(params: ReportQuery) {
  return fetchHqReport<Record<string, unknown>>('orders', params);
}

export function fetchTopupReport(params: ReportQuery) {
  return fetchHqReport<Record<string, unknown>>('topup', params);
}

export function fetchGateReport(params: ReportQuery) {
  return fetchHqReport<Record<string, unknown>>('gate', params);
}

export function fetchSalesReport(params: ReportQuery) {
  return fetchHqReport<Record<string, unknown>>('sales', params);
}

export function fetchCoursePurchasesReport(params: ReportQuery) {
  return fetchHqReport<Record<string, unknown>>('course-purchases', params);
}

export function fetchTrainerReport(params: ReportQuery) {
  return fetchHqReport<Record<string, unknown>>('trainer', params);
}

export async function fetchReportBranches() {
  const { data } = await staffApi.get<ApiResponse<Branch[]>>('/hq/reports/branches');
  return data;
}

/** 門市銷貨對帳（ADMIN）；from／to 為台灣日 YYYY-MM-DD，branchId 省略＝全部門市 */
export async function fetchSalesReconciliation(params: { from: string; to: string; branchId?: number; includeCancelled?: boolean }) {
  const { data } = await staffApi.get<ApiResponse<SalesReconciliation>>('/hq/reports/sales-reconciliation', {
    params: {
      from: params.from,
      to: params.to,
      ...(params.branchId ? { branchId: params.branchId } : {}),
      ...(params.includeCancelled === false ? { includeCancelled: '0' } : {}),
    },
  });
  return data;
}

export type AnalyticsKind =
  | 'overview'
  | 'daily'
  | 'branch'
  | 'pay-mix'
  | 'products'
  | 'trainer';

export async function fetchSalesAnalytics(
  params: ReportQuery & { kind: AnalyticsKind },
) {
  const { data } = await staffApi.get<
    ApiResponse<ReportPayload<Record<string, unknown>> & { kind?: string }>
  >('/hq/reports/analytics', {
    params: {
      kind: params.kind,
      from: params.from || undefined,
      to: params.to || undefined,
      q: params.q || undefined,
      branchId: params.branchId || undefined,
      trainerId: params.trainerId || undefined,
    },
  });
  return data;
}

// ── HQ 電子合約範本 ──
export async function fetchHqContractPresets() {
  const { data } = await staffApi.get<ApiResponse<GymContractPreset[]>>('/hq/contracts/presets');
  return data;
}

export async function fetchHqContracts(status: 'ACTIVE' | 'VOIDED' | 'ALL' = 'ALL') {
  const { data } = await staffApi.get<ApiResponse<MembershipContract[]>>('/hq/contracts', {
    params: { status },
  });
  return data;
}

export async function fetchHqContractAudit(id: number, limit = 100) {
  const { data } = await staffApi.get<ApiResponse<ContractAuditLog[]>>(
    `/hq/contracts/${id}/audit`,
    { params: { limit } },
  );
  return data;
}

export async function createHqContract(payload: {
  title: string;
  shortName?: string;
  body: string;
  /** 初版版本備註，預設 V1；建立後鎖定 */
  versionBase?: string;
  /** @deprecated 相容舊欄位；等同 versionBase */
  changeNote?: string;
  purpose?: 'GENERAL' | 'NEW_MEMBER' | 'BIOMETRICS_CONSENT';
  /** 來自專業範本的 key（僅稽核用） */
  presetKey?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<MembershipContract>>('/hq/contracts', {
    ...payload,
    versionBase: payload.versionBase ?? payload.changeNote,
  });
  return data;
}

export async function updateHqContract(
  id: number,
  payload: {
    changeNote: string;
  } & Partial<{
    title: string;
    shortName: string | null;
    body: string;
    /** 條文異動時後端一律升版；此旗標保留相容 */
    bumpVersion: boolean;
    purpose: 'GENERAL' | 'NEW_MEMBER' | 'BIOMETRICS_CONSENT';
    status: 'ACTIVE' | 'VOIDED';
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<MembershipContract>>(
    `/hq/contracts/${id}`,
    payload,
  );
  return data;
}

// ── Ops 會員合約簽署 ──
export async function fetchOpsContracts() {
  const { data } = await staffApi.get<
    ApiResponse<{ id: number; title: string; status: string }[]>
  >('/ops/contracts');
  return data;
}

export async function fetchMemberContracts(memberId: number) {
  const { data } = await staffApi.get<
    ApiResponse<{
      board: MemberContractBoardItem[];
      signatures: MemberContractSignature[];
    }>
  >(`/ops/members/${memberId}/contracts`);
  return data;
}

export async function openMemberContract(memberId: number, contractId: number) {
  const { data } = await staffApi.post<
    ApiResponse<{
      signature: MemberContractSignature;
      boardItem: MemberContractBoardItem | null;
      history: MemberContractSignature[];
    }>
  >(`/ops/members/${memberId}/contracts/open`, { contractId });
  return data;
}

export async function assignMemberContracts(
  memberId: number,
  payload: { contractIds?: number[]; promotionId?: number },
) {
  const { data } = await staffApi.post<ApiResponse<MemberContractSignature[]>>(
    `/ops/members/${memberId}/contracts/assign`,
    payload,
  );
  return data;
}

export async function resignMemberContract(memberId: number, signId: number) {
  const { data } = await staffApi.post<
    ApiResponse<{
      signature: MemberContractSignature;
      history: MemberContractSignature[];
    }>
  >(`/ops/members/${memberId}/contracts/${signId}/resign`);
  return data;
}

export async function signMemberContract(
  memberId: number,
  signId: number,
  signatureData: string,
) {
  const { data } = await staffApi.post<
    ApiResponse<{
      signature: MemberContractSignature;
      history: MemberContractSignature[];
    }>
  >(`/ops/members/${memberId}/contracts/${signId}/sign`, { signatureData });
  return data;
}

// ── CMS（公開 + 總部管理）──
export async function fetchCmsAnnouncements(branchId?: number) {
  const { data } = await publicApi.get<ApiResponse<CmsAnnouncement[]>>('/cms/announcements', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function fetchCmsFaq(branchId?: number) {
  const { data } = await publicApi.get<ApiResponse<CmsFaqItem[]>>('/cms/faq', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function fetchCmsBranches() {
  const { data } = await publicApi.get<ApiResponse<CmsBranchIntro[]>>('/cms/branches');
  return data;
}

export async function fetchCmsBranch(id: number) {
  const { data } = await publicApi.get<ApiResponse<CmsBranchIntro>>(`/cms/branches/${id}`);
  return data;
}

export async function fetchCmsTrainers(branchId?: number) {
  const { data } = await publicApi.get<ApiResponse<CmsTrainerPublic[]>>('/cms/trainers', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function submitCmsContact(payload: {
  name: string;
  email?: string;
  phone?: string;
  message: string;
}) {
  const { data } = await publicApi.post<ApiResponse<{ id: number; createdAt: string }>>(
    '/cms/contact',
    payload,
  );
  return data;
}

export async function createCmsAnnouncement(payload: {
  title: string;
  body: string;
  branchId?: number | null;
  category?: string;
  pushEnabled?: boolean;
  publishedAt?: string;
  expiresAt?: string | null;
  isActive?: boolean;
}) {
  const { data } = await staffApi.post<ApiResponse<CmsAnnouncement>>('/cms/announcements', payload);
  return data;
}

export async function updateCmsAnnouncement(
  id: number,
  payload: Partial<{
    title: string;
    body: string;
    branchId: number | null;
    category: string;
    pushEnabled: boolean;
    publishedAt: string;
    expiresAt: string | null;
    isActive: boolean;
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<CmsAnnouncement>>(
    `/cms/announcements/${id}`,
    payload,
  );
  return data;
}

export async function deleteCmsAnnouncement(id: number) {
  const { data } = await staffApi.delete<ApiResponse>(`/cms/announcements/${id}`);
  return data;
}

export async function createCmsFaq(payload: {
  question: string;
  answer: string;
  branchId?: number | null;
  category?: string;
  sortOrder?: number;
  isActive?: boolean;
}) {
  const { data } = await staffApi.post<ApiResponse<CmsFaqItem>>('/cms/faq', payload);
  return data;
}

export async function updateCmsFaq(
  id: number,
  payload: Partial<{
    question: string;
    answer: string;
    branchId: number | null;
    category: string;
    sortOrder: number;
    isActive: boolean;
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<CmsFaqItem>>(`/cms/faq/${id}`, payload);
  return data;
}

export async function deleteCmsFaq(id: number) {
  const { data } = await staffApi.delete<ApiResponse>(`/cms/faq/${id}`);
  return data;
}

export async function updateCmsBranchContent(
  id: number,
  payload: {
    introText?: string | null;
    introImages?: unknown;
    introVideos?: unknown;
    showOccupancy?: boolean;
  },
) {
  const { data } = await staffApi.patch<ApiResponse<CmsBranchIntro>>(
    `/cms/branches/${id}/content`,
    payload,
  );
  return data;
}

// ── 會員延伸 ──
export async function fetchMemberPromotions() {
  const { data } = await memberApi.get<ApiResponse<Promotion[]>>('/member/promotions');
  return data;
}

export async function createMemberOrder(payload: {
  promotionId: number;
  payMethod?: 'CARD' | 'LINEPAY';
  cardMode?: 'LUMP' | 'INSTALLMENT' | 'RECURRING';
  cardInst?: number;
  periodType?: 'W' | 'M' | 'Y';
  periodTimes?: number;
}) {
  const { data } = await memberApi.post<
    ApiResponse<{
      payMethod?: string;
      linePayMode?: string;
      paymentUrl?: string;
      transactionId?: string;
      actionUrl?: string;
      payload?: Record<string, string>;
      orderId?: string;
      promotionId?: number;
      amount?: number;
      bonusGiven?: number;
      cardMode?: string;
      cardInst?: number | null;
      periodType?: string | null;
      periodTimes?: number | null;
    }>
  >('/member/orders', payload);
  return data;
}

export async function fetchMemberOrdersHistory(take?: number) {
  const { data } = await memberApi.get<ApiResponse<MemberOrderHistoryItem[]>>(
    '/member/orders-history',
    { params: take ? { take } : undefined },
  );
  return data;
}

export async function fetchMemberClassRecords(take?: number) {
  const { data } = await memberApi.get<ApiResponse<MemberClassRecords>>('/member/class-records', {
    params: take ? { take } : undefined,
  });
  return data;
}

export async function fetchMemberSelfTrainingPlans() {
  const { data } = await memberApi.get<
    ApiResponse<
      { id: number; title: string; exercises?: unknown; trainer?: { id: number; name: string } }[]
    >
  >('/member/self-training-plans');
  return data;
}

export async function fetchMemberTrainingRecords() {
  const { data } = await memberApi.get<
    ApiResponse<
      {
        id: number;
        title: string;
        content?: string | null;
        sharedAt?: string;
        trainer?: { id: number; name: string };
      }[]
    >
  >('/member/training-records');
  return data;
}

export async function submitMemberClassLeave(payload: { reservationId: number; reason?: string }) {
  const { data } = await memberApi.post<ApiResponse>('/member/class-leave', payload);
  return data;
}

// ── 會員團課（付費期班）：金額由後端依剩餘堂數計價，禁止帶 amount／memberId ──
export async function fetchMemberGroupSeries(branchId?: number) {
  const { data } = await memberApi.get<ApiResponse<GroupSellableSeries[]>>('/member/group/series', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function fetchMemberGroupSeriesDetail(seriesId: number) {
  const { data } = await memberApi.get<ApiResponse<GroupSeriesDetail>>(`/member/group/series/${seriesId}`);
  return data;
}

export async function fetchMemberGroupOverview() {
  const { data } = await memberApi.get<ApiResponse<GroupMemberOverview>>('/member/group/me');
  return data;
}

export async function enrollMemberGroup(payload: {
  seriesId: number;
  kind: GroupEnrollKind;
  classId?: number;
  payMethod: 'CARD' | 'LINEPAY';
}) {
  const { data } = await memberApi.post<ApiResponse<GroupEnrollResult>>('/member/group/enroll', payload);
  return data;
}

export async function joinMemberGroupWaitlist(seriesId: number) {
  const { data } = await memberApi.post<ApiResponse<{ id: number; position: number }>>(
    '/member/group/waitlist',
    { seriesId },
  );
  return data;
}

export async function cancelMemberGroupWaitlist(waitlistId: number) {
  const { data } = await memberApi.post<ApiResponse>(`/member/group/waitlist/${waitlistId}/cancel`);
  return data;
}

export async function requestMemberGroupLeave(reservationId: number) {
  const { data } = await memberApi.post<
    ApiResponse<{ kind: 'MAKEUP_CREDIT' | 'MAKEUP_RESTORED'; creditId: number; expiresAt?: string }>
  >(`/member/group/reservations/${reservationId}/leave`, {});
  return data;
}

export async function fetchMemberMakeupOptions(creditId: number) {
  const { data } = await memberApi.get<
    ApiResponse<{ credit: { id: number; expiresAt: string }; options: GroupMakeupOption[] }>
  >(`/member/group/makeup-credits/${creditId}/options`);
  return data;
}

export async function bookMemberGroupMakeup(payload: { creditId: number; classId: number }) {
  const { data } = await memberApi.post<ApiResponse>('/member/group/makeup', payload);
  return data;
}

export async function submitMemberSubscriptionLeave(payload: {
  days?: number;
  reason?: string;
  subscriptionId?: string;
}) {
  const { data } = await memberApi.post<ApiResponse>('/member/subscription-leave', payload);
  return data;
}

/**
 * 會員自助請假（起迄日＋證明圖）。
 * `POST /member/leave-application`：multipart（欄位 proof）或 JSON（proofImage data URL）。
 * 不傳 memberId。
 */
export async function submitMemberLeaveApplication(payload: {
  startDate: string;
  endDate: string;
  proofFile?: File | null;
  reason?: string;
  subscriptionId?: string;
}) {
  const start = new Date(`${payload.startDate}T00:00:00`);
  const end = new Date(`${payload.endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('請假日期無效');
  }
  if (end < start) {
    throw new Error('結束日不可早於起始日');
  }

  if (payload.proofFile) {
    const form = new FormData();
    form.append('startDate', payload.startDate);
    form.append('endDate', payload.endDate);
    if (payload.reason?.trim()) form.append('reason', payload.reason.trim());
    if (payload.subscriptionId) form.append('subscriptionId', payload.subscriptionId);
    form.append('proof', payload.proofFile);
    // 勿手設 Content-Type，讓瀏覽器帶 multipart boundary
    const { data } = await memberApi.post<ApiResponse>('/member/leave-application', form);
    return data;
  }

  const { data } = await memberApi.post<ApiResponse>('/member/leave-application', {
    startDate: payload.startDate,
    endDate: payload.endDate,
    reason: payload.reason?.trim() || undefined,
    subscriptionId: payload.subscriptionId || undefined,
  });
  return data;
}

export async function submitMemberSubscriptionCancel(payload: {
  subscriptionId: string;
  mode?: 'KEEP' | 'CUT';
  reason?: string;
}) {
  const { data } = await memberApi.post<ApiResponse>('/member/subscription-cancel', payload);
  return data;
}

export async function fetchMemberSubscriptions() {
  const { data } = await memberApi.get<ApiResponse<MemberSubscription[]>>('/member/subscriptions');
  return data;
}

export async function rebindMemberSubscription(id: string) {
  const ref = encodeURIComponent(String(id || '').trim());
  const { data } = await memberApi.post<
    ApiResponse<{
      subscriptionId: string;
      actionUrl: string;
      payload: Record<string, string>;
      bindOnly?: boolean;
      rebind?: boolean;
      rebindPending?: boolean;
      messageHint?: string;
    }>
  >(`/member/subscriptions/${ref}/rebind`);
  return data;
}

/** 更換信用卡／約定扣款：取得 PayUNi 頁面（實際路徑 `/member/subscriptions/:id/rebind`） */
export async function requestMemberCardBinding(subscriptionId: string) {
  return rebindMemberSubscription(subscriptionId);
}

export async function fetchMemberSubscriptionRebindStatus(id: string) {
  const ref = encodeURIComponent(String(id || '').trim());
  const { data } = await memberApi.get<
    ApiResponse<{
      subscriptionId: string;
      status: string;
      rebindPending: boolean;
      hasCreditHash: boolean;
      creditUpdated: boolean;
      lastError?: string | null;
      updatedAt?: string;
    }>
  >(`/member/subscriptions/${ref}/rebind-status`);
  return data;
}

/** 綁卡狀態輪詢（與 rebind-status 同契約） */
export async function fetchMemberCardBindingStatus(subscriptionId: string) {
  return fetchMemberSubscriptionRebindStatus(subscriptionId);
}

/** 看板即時人數（公開） */
export async function fetchBoardOccupancy() {
  const { data } = await publicApi.get<
    ApiResponse<{
      presentCount: number;
      capacity: number;
      available: number;
      utilization: number;
      isFull: boolean;
      updatedAt: string;
    }>
  >('/board/occupancy');
  return data;
}

/**
 * 容留人數顯示開關。`Branch.showOccupancy`；可選 `branchId`。
 */
export async function fetchBoardOccupancySettings(params?: { branchId?: number }) {
  try {
    const { data } = await publicApi.get<
      ApiResponse<{ isDisplay: boolean; branchId?: number | null }>
    >('/board/occupancy-settings', { params });
    return data;
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 501)) {
      return {
        status: 'success' as const,
        data: { isDisplay: false },
        message: 'occupancy-settings unavailable',
      };
    }
    throw err;
  }
}

export async function patchMemberProfileExt(payload: {
  email?: string;
  gender?: string;
  birthDate?: string | null;
  idPhotoUrl?: string | null;
}) {
  const { data } = await memberApi.patch<ApiResponse>('/member/profile-ext', payload);
  return data;
}

// ── 會員行銷 ──
export async function fetchMemberGiftCards() {
  const { data } = await memberApi.get<ApiResponse<MemberGiftCards>>('/member/marketing/gift-cards/mine');
  return data;
}

export async function redeemMemberGiftCard(code: string) {
  const { data } = await memberApi.post<ApiResponse>('/member/marketing/gift-cards/redeem', { code });
  return data;
}

export async function fetchMemberPointsLedger() {
  const { data } = await memberApi.get<ApiResponse<MemberPointsLedgerEntry[]>>(
    '/member/marketing/points/ledger',
  );
  return data;
}

export async function fetchMemberLotteryEntries() {
  const { data } = await memberApi.get<
    ApiResponse<
      {
        id: number;
        pool?: { id: number; name: string; status?: string; drawAt?: string };
        createdAt?: string;
      }[]
    >
  >('/member/marketing/lottery/entries');
  return data;
}

export async function fetchMemberInbodyVouchers() {
  const { data } = await memberApi.get<
    ApiResponse<{ id: number; code: string; status: string; createdAt?: string }[]>
  >('/member/marketing/inbody-vouchers');
  return data;
}

// ── HQ 行銷 ──
export async function fetchHqMarketingCampaigns() {
  const { data } = await staffApi.get<ApiResponse<MarketingCampaign[]>>('/hq/marketing/campaigns');
  return data;
}

export async function createHqMarketingCampaign(payload: {
  name: string;
  segment: string;
  message: string;
  scheduledAt?: string | null;
  status?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<MarketingCampaign>>(
    '/hq/marketing/campaigns',
    payload,
  );
  return data;
}

export async function updateHqMarketingCampaign(
  id: number,
  payload: Partial<{ name: string; segment: string; message: string; scheduledAt: string | null; status: string }>,
) {
  const { data } = await staffApi.patch<ApiResponse<MarketingCampaign>>(
    `/hq/marketing/campaigns/${id}`,
    payload,
  );
  return data;
}

export async function sendHqMarketingCampaign(id: number) {
  const { data } = await staffApi.post<ApiResponse>(`/hq/marketing/campaigns/${id}/send`);
  return data;
}

export async function fetchHqDormantList(segment: string) {
  const { data } = await staffApi.get<
    ApiResponse<{ segment: string; count: number; items: unknown[] }>
  >('/hq/marketing/dormant-lists', { params: { segment } });
  return data;
}

export async function fetchHqLotteryPools() {
  const { data } = await staffApi.get<ApiResponse<LotteryPool[]>>('/hq/marketing/lottery-pools');
  return data;
}

export async function createHqLotteryPool(payload: {
  name: string;
  drawAt?: string | null;
  status?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<LotteryPool>>('/hq/marketing/lottery-pools', payload);
  return data;
}

export async function drawHqLotteryPool(id: number) {
  const { data } = await staffApi.post<ApiResponse>(`/hq/marketing/lottery-pools/${id}/draw`);
  return data;
}

export async function issueHqGiftCard(payload: { amount: number; purchaserId?: number }) {
  const { data } = await staffApi.post<
    ApiResponse<{ id: string; code: string; amount: number; status: string }>
  >('/hq/marketing/gift-cards/issue', payload);
  return data;
}

export async function grantHqInbodyVoucher(payload: { memberId: number; qty?: number }) {
  const { data } = await staffApi.post<ApiResponse>('/hq/marketing/inbody-vouchers/grant', payload);
  return data;
}

// ── HQ HR ──
/** 區間考勤（台北日期，預設近 7 日）；遲到／早退／曠職等旗標由後端比對已生效班表 */
export async function fetchHqHrAttendance(params?: {
  from?: string;
  to?: string;
  branchId?: number;
  staffId?: number;
  flag?: AttendanceFlag | 'ABSENT';
}) {
  const { data } = await staffApi.get<ApiResponse<AttendanceOverview>>('/hq/hr/attendance', { params });
  return data;
}

/** 總部補登（必填原因；未填下班＝上班中） */
export async function createHqHrAttendance(payload: {
  staffId: number;
  punchIn: string;
  punchOut?: string;
  branchId?: number;
  /** 綁定該員工之已生效班次（自曠職列補登時帶入） */
  scheduleId?: number;
  reason: string;
}) {
  const { data } = await staffApi.post<ApiResponse<AttendanceRecord>>('/hq/hr/attendance', payload);
  return data;
}

/** 總部更正（必填原因，留存更正者） */
export async function correctHqHrAttendance(
  id: number,
  payload: { punchIn?: string; punchOut?: string | null; reason: string },
) {
  const { data } = await staffApi.patch<ApiResponse<AttendanceRecord>>(`/hq/hr/attendance/${id}`, payload);
  return data;
}

export async function fetchHqHrLeaves(params?: {
  status?: LeaveStatus;
  staffId?: number;
  branchId?: number;
  from?: string;
  to?: string;
}) {
  const { data } = await staffApi.get<ApiResponse<LeaveOverview>>('/hq/hr/leaves', { params });
  return data;
}

/** HQ 代建請假（直接核准）；特休／國休由後端檢查額度 */
export async function createHqHrLeave(payload: {
  staffId: number;
  startAt: string;
  endAt: string;
  leaveType: LeaveType;
  hours?: number;
  reason?: string;
  proofUrl?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<StaffLeaveRow>>('/hq/hr/leaves', payload);
  return data;
}

export async function fetchRosterConfigs() {
  const { data } = await staffApi.get<ApiResponse<RosterBranchConfig[]>>('/staff/roster/configs');
  return data;
}

/** 早／晚班場務人力後端強制 ≥ 2；週期起算日已有排班期後不可改 */
export async function updateRosterConfig(
  branchId: number,
  payload: { cycleAnchorDate: string; morningHeadcount: number; eveningHeadcount: number },
) {
  const { data } = await staffApi.put<ApiResponse<RosterView['config']>>(`/staff/roster/configs/${branchId}`, payload);
  return data;
}

/** 含 date 之 28 日四週變形排班檢視（合規檢查由後端計算） */
export async function fetchRoster(branchId: number, date?: string) {
  const { data } = await staffApi.get<ApiResponse<RosterView>>('/staff/roster', { params: { branchId, date } });
  return data;
}

export async function createRosterPeriod(branchId: number, startDate: string) {
  const { data } = await staffApi.post<ApiResponse<RosterView>>('/staff/roster/periods', { branchId, startDate });
  return data;
}

export async function generateRosterPeriod(periodId: number) {
  const { data } = await staffApi.post<ApiResponse<RosterView>>(`/staff/roster/periods/${periodId}/generate`);
  return data;
}

export async function setRosterCell(periodId: number, payload: { staffId: number; date: string; value: RosterCellCode | null }) {
  const { data } = await staffApi.put<ApiResponse<RosterView>>(`/staff/roster/periods/${periodId}/cells`, payload);
  return data;
}

export async function publishRosterPeriod(periodId: number) {
  const { data } = await staffApi.post<ApiResponse<RosterView>>(`/staff/roster/periods/${periodId}/publish`);
  return data;
}

export async function unpublishRosterPeriod(periodId: number, reason: string) {
  const { data } = await staffApi.post<ApiResponse<RosterView>>(`/staff/roster/periods/${periodId}/unpublish`, { reason });
  return data;
}

export async function fetchHqHolidays(year: number) {
  const { data } = await staffApi.get<ApiResponse<HolidayCalendar>>('/hq/hr/holidays', { params: { year } });
  return data;
}

export async function createHqHoliday(payload: { date: string; name: string }) {
  const { data } = await staffApi.post<ApiResponse<PublicHoliday>>('/hq/hr/holidays', payload);
  return data;
}

export async function renameHqHoliday(id: number, name: string) {
  const { data } = await staffApi.patch<ApiResponse<PublicHoliday>>(`/hq/hr/holidays/${id}`, { name });
  return data;
}

/** 補入後端內建之該年預設國定假日（已存在日期略過） */
export async function seedHqDefaultHolidays(year: number) {
  const { data } = await staffApi.post<ApiResponse<{ count: number }>>('/hq/hr/holidays/defaults', { year });
  return data;
}

export async function deleteHqHoliday(id: number) {
  const { data } = await staffApi.delete<ApiResponse>(`/hq/hr/holidays/${id}`);
  return data;
}

/** 審核：待審 → 核准／拒絕；已核准 → 撤銷（拒絕與撤銷必填 note） */
export async function patchHqHrLeave(
  id: number,
  payload: { status: 'APPROVED' | 'REJECTED' | 'CANCELLED'; note?: string },
) {
  const { data } = await staffApi.patch<ApiResponse<StaffLeaveRow>>(`/hq/hr/leaves/${id}`, payload);
  return data;
}

/** 總部班表總覽（from/to 為台北日期 YYYY-MM-DD，預設今日起 14 日） */
export async function fetchHqHrSchedules(params?: {
  staffId?: number;
  branchId?: number;
  from?: string;
  to?: string;
  source?: ScheduleSource;
  includeOff?: boolean;
}) {
  const { includeOff, ...rest } = params ?? {};
  const { data } = await staffApi.get<ApiResponse<ScheduleOverview>>('/hq/hr/schedules', {
    params: { ...rest, includeOff: includeOff ? '1' : undefined },
  });
  return data;
}

/** 總部臨時排班：僅限不列四週排班編制之員工（場務／實習教練回 409 USE_ROSTER） */
export async function patchHqHrSchedule(
  id: number,
  payload: Partial<{ startAt: string; endAt: string; branchId: number | null; note: string }>,
) {
  const { data } = await staffApi.patch<ApiResponse<ScheduleOverviewRow>>(
    `/hq/hr/schedules/${id}`,
    payload,
  );
  return data;
}

export async function deleteHqHrSchedule(id: number) {
  const { data } = await staffApi.delete<ApiResponse>(`/hq/hr/schedules/${id}`);
  return data;
}

/** 工資核算匯出：月度考勤標記／總數＋請假時數（後端彙整；CSV 由前端依 columns 組檔） */
export async function fetchHqPayrollExport(params: { month: string; branchId?: number }) {
  const { data } = await staffApi.get<ApiResponse<PayrollExport>>('/hq/hr/payroll-export', { params });
  return data;
}

// ── 薪資系統（HQ ADMIN；金額一律後端計算） ──
export async function fetchPayrollConfig() {
  const { data } = await staffApi.get<ApiResponse<PayrollConfigData>>('/hq/payroll/config');
  return data;
}

export async function updatePayrollConfig(rates: Record<string, number | string>) {
  const { data } = await staffApi.put<ApiResponse<PayrollConfigData>>('/hq/payroll/config', rates);
  return data;
}

export async function fetchPayProfiles() {
  const { data } = await staffApi.get<ApiResponse<PayProfileList>>('/hq/payroll/profiles');
  return data;
}

export async function savePayProfile(staffId: number, payload: Partial<StaffPayProfileData>) {
  const { data } = await staffApi.put<ApiResponse<StaffPayProfileData>>(`/hq/payroll/profiles/${staffId}`, payload);
  return data;
}

export async function deletePayProfile(staffId: number) {
  const { data } = await staffApi.delete<ApiResponse>(`/hq/payroll/profiles/${staffId}`);
  return data;
}

export async function fetchPayrollRuns() {
  const { data } = await staffApi.get<ApiResponse<{ items: PayrollRunSummary[] }>>('/hq/payroll/runs');
  return data;
}

export async function createPayrollRun(month: string) {
  const { data } = await staffApi.post<ApiResponse<PayrollRunDetail>>('/hq/payroll/runs', { month });
  return data;
}

export async function fetchPayrollRun(id: number) {
  const { data } = await staffApi.get<ApiResponse<PayrollRunDetail>>(`/hq/payroll/runs/${id}`);
  return data;
}

export async function deletePayrollRun(id: number) {
  const { data } = await staffApi.delete<ApiResponse>(`/hq/payroll/runs/${id}`);
  return data;
}

export async function payrollRunAction(id: number, action: 'recalculate' | 'finalize') {
  const { data } = await staffApi.post<ApiResponse<PayrollRunDetail>>(`/hq/payroll/runs/${id}/${action}`);
  return data;
}

export async function reopenPayrollRun(id: number, reason: string) {
  const { data } = await staffApi.post<ApiResponse<PayrollRunDetail>>(`/hq/payroll/runs/${id}/reopen`, { reason });
  return data;
}

export async function decideRunOvertime(id: number, mode: 'SUGGESTED' | 'REJECT') {
  const { data } = await staffApi.put<ApiResponse<PayrollRunDetail>>(`/hq/payroll/runs/${id}/overtime`, { mode });
  return data;
}

export async function decideItemOvertime(
  id: number,
  itemId: number,
  payload: { mode?: 'SUGGESTED' | 'REJECT'; decisions?: { key: string; approvedMinutes: number | null }[] },
) {
  const { data } = await staffApi.put<ApiResponse<PayrollRunDetail>>(`/hq/payroll/runs/${id}/items/${itemId}/overtime`, payload);
  return data;
}

export async function addPayrollAdjustment(
  id: number,
  itemId: number,
  payload: { type: PayrollAdjustmentType; amount: number; label?: string; note?: string },
) {
  const { data } = await staffApi.post<ApiResponse<PayrollRunDetail>>(`/hq/payroll/runs/${id}/items/${itemId}/adjustments`, payload);
  return data;
}

export async function removePayrollAdjustment(id: number, itemId: number, adjId: string) {
  const { data } = await staffApi.delete<ApiResponse<PayrollRunDetail>>(`/hq/payroll/runs/${id}/items/${itemId}/adjustments/${adjId}`);
  return data;
}

// ── 員工本人薪資單（僅已結算） ──
export async function fetchMyPayslips() {
  const { data } = await staffApi.get<ApiResponse<{ items: MyPayslipSummary[] }>>('/staff/hr/payslips');
  return data;
}

export async function fetchMyPayslip(month: string) {
  const { data } = await staffApi.get<ApiResponse<MyPayslipDetail>>(`/staff/hr/payslips/${month}`);
  return data;
}

// ── 員工通知匣＋LINE 推播綁定（本人） ──
export async function fetchMyNotifications() {
  const { data } = await staffApi.get<ApiResponse<StaffNotificationInbox>>('/staff/notifications');
  return data;
}

/** ids 省略＝全部已讀 */
export async function markMyNotificationsRead(ids?: number[]) {
  const { data } = await staffApi.post<ApiResponse<{ updated: number }>>('/staff/notifications/read', ids ? { ids } : {});
  return data;
}

export async function fetchMyLineStatus() {
  const { data } = await staffApi.get<ApiResponse<StaffLineStatus>>('/staff/notifications/line');
  return data;
}

/** 取得 LINE Login 授權網址（state 綁本人，10 分鐘內單次有效） */
export async function createMyLineBindUrl() {
  const { data } = await staffApi.post<ApiResponse<{ url: string }>>('/staff/notifications/line/bind-url');
  return data;
}

export async function bindMyLine(payload: { code: string; state: string }) {
  const { data } = await staffApi.post<ApiResponse<StaffLineStatus>>('/staff/notifications/line/bind', payload);
  return data;
}

export async function setMyLineNotify(notifyEnabled: boolean) {
  const { data } = await staffApi.patch<ApiResponse<StaffLineStatus>>('/staff/notifications/line', { notifyEnabled });
  return data;
}

export async function unbindMyLine() {
  const { data } = await staffApi.delete<ApiResponse<StaffLineStatus>>('/staff/notifications/line');
  return data;
}

export async function sendMyLineTest() {
  const { data } = await staffApi.post<ApiResponse<{ notification: StaffNotificationItem | null }>>(
    '/staff/notifications/line/test',
  );
  return data;
}

// ── 員工 HR 自助 ──
/** 上班打卡：後端依班表值勤窗綁定班次與分店，班外 409 NOT_ON_DUTY／請假 409 ON_LEAVE */
export async function staffHrPunchIn() {
  const { data } = await staffApi.post<
    ApiResponse<StaffAttendanceRow & { staleClosedId: number | null; shift: ScheduleBrief | null; duty: StaffDutyStatus }>
  >('/staff/hr/punch-in', {});
  return data;
}

/** 我的出勤：打卡狀態、今日／下一班、近 30 日考勤（旗標由後端計算） */
export async function fetchMyAttendance() {
  const { data } = await staffApi.get<ApiResponse<MyAttendance>>('/staff/hr/my-attendance');
  return data;
}

export async function fetchMyLeaves() {
  const { data } = await staffApi.get<ApiResponse<MyLeaves>>('/staff/hr/my-leaves');
  return data;
}

export async function cancelMyLeave(id: number) {
  const { data } = await staffApi.post<ApiResponse>(`/staff/hr/my-leaves/${id}/cancel`);
  return data;
}

export async function staffHrPunchOut() {
  const { data } = await staffApi.post<ApiResponse<StaffAttendanceRow & { duty: StaffDutyStatus }>>(
    '/staff/hr/punch-out',
  );
  return data;
}

export async function staffHrLeaveRequest(payload: {
  startAt: string;
  endAt: string;
  leaveType?: LeaveType;
  hours?: number;
  reason?: string;
  proofUrl?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<StaffLeaveRow>>('/staff/hr/leave-request', payload);
  return data;
}

export async function fetchStaffHrMySchedule(params?: { from?: string; to?: string }) {
  const { data } = await staffApi.get<ApiResponse<StaffScheduleRow[]>>('/staff/hr/my-schedule', {
    params,
  });
  return data;
}

export async function fetchMyRosterOverview() {
  const { data } = await staffApi.get<ApiResponse<MyRosterOverview>>('/staff/hr/off-requests');
  return data;
}

export async function submitMyOffRequest(payload: { cycleStartDate: string; dates: string[]; note?: string }) {
  const { data } = await staffApi.put<ApiResponse<MyRosterOverview>>('/staff/hr/off-requests', payload);
  return data;
}

export async function respondRosterAck(payload: {
  cycleStartDate: string;
  status: RosterAckStatus;
  message?: string;
}) {
  const { data } = await staffApi.post<ApiResponse<MyRosterOverview>>('/staff/hr/roster-ack', payload);
  return data;
}

// ── 週班表（教練 → FM／店長核准；店長・GM・FM → ADMIN 核准） ──
export async function fetchMyCoachPlans() {
  const { data } = await staffApi.get<ApiResponse<MyCoachPlans>>('/staff/hr/week-plans');
  return data;
}

export async function saveMyCoachPlan(
  weekStart: string,
  payload: { regularOffDate: string | null; restDayDate: string | null; slots: CoachPlanSlot[]; note?: string },
) {
  const { data } = await staffApi.put<ApiResponse<CoachWeekPlan>>(`/staff/hr/week-plans/${weekStart}`, payload);
  return data;
}

export async function submitMyCoachPlan(weekStart: string) {
  const { data } = await staffApi.post<ApiResponse<CoachWeekPlan>>(`/staff/hr/week-plans/${weekStart}/submit`);
  return data;
}

export async function withdrawMyCoachPlan(weekStart: string) {
  const { data } = await staffApi.post<ApiResponse<CoachWeekPlan>>(`/staff/hr/week-plans/${weekStart}/withdraw`);
  return data;
}

export async function fetchCoachPlanReviews(params?: {
  status?: CoachPlanStatus | 'ALL';
  kind?: WeekPlanRole;
  branchId?: number;
  from?: string;
}) {
  const { data } = await staffApi.get<ApiResponse<CoachPlanReviewList>>('/staff/week-plans', { params });
  return data;
}

export async function reviewCoachPlan(id: number, action: 'approve' | 'reject' | 'reopen', reason?: string) {
  const { data } = await staffApi.post<ApiResponse>(`/staff/week-plans/${id}/${action}`, { reason });
  return data;
}

// ── HQ 教練業績獎金（底薪於薪資設定；獎金併入薪資批次） ──
export async function fetchHqCoachCommissionRules(trainerId?: number) {
  const { data } = await staffApi.get<ApiResponse<CoachCommissionRule[]>>(
    '/hq/coach/commission-rules',
    { params: trainerId ? { trainerId } : undefined },
  );
  return data;
}

export async function putHqCoachCommissionRule(payload: {
  trainerId: number | null;
  courseKind: CoachCourseKind;
  tierRates?: CoachTierRate[] | null;
  sessionBonus?: number | null;
  perHeadRate?: number | null;
}) {
  const { data } = await staffApi.put<ApiResponse<CoachCommissionRule>>('/hq/coach/commission-rules', payload);
  return data;
}

export async function deleteHqCoachCommissionRule(id: number) {
  const { data } = await staffApi.delete<ApiResponse>(`/hq/coach/commission-rules/${id}`);
  return data;
}

export async function fetchHqCoachPerformance(month: string) {
  const { data } = await staffApi.get<ApiResponse<{ month: string; items: HqCoachPerformanceItem[] }>>(
    '/hq/coach/performance',
    { params: { month } },
  );
  return data;
}

export async function fetchTrainerMyPerformance(month: string, viewAsTrainerId?: number) {
  const { data } = await staffApi.get<ApiResponse<TrainerMyPerformance>>('/trainer/performance', {
    params: { month, ...(viewAsTrainerId ? { viewAsTrainerId } : {}) },
  });
  return data;
}

// ── 教練延伸 ──
export async function createTrainerClassCheckInToken(
  classId: number,
  payload?: { kind?: string; viewAsTrainerId?: number },
) {
  const { data } = await staffApi.post<ApiResponse<ClassCheckInTokenResult>>(
    `/trainer/ext/classes/${classId}/check-in-token`,
    payload,
  );
  return data;
}

export async function trainerExtCheckIn(payload: { token: string; reservationId: number }) {
  const { data } = await staffApi.post<ApiResponse>('/trainer/ext/check-in', payload);
  return data;
}

export async function fetchTrainerExtTrainingRecords(params?: {
  memberId?: number;
  viewAsTrainerId?: number;
  take?: number;
}) {
  const { data } = await staffApi.get<
    ApiResponse<
      {
        id: number;
        title: string;
        member?: { id: number; name: string; memberNo?: string };
        createdAt?: string;
      }[]
    >
  >('/trainer/ext/training-records', { params });
  return data;
}

export async function fetchTrainerExtVenueBookings(params?: {
  from?: string;
  to?: string;
  viewAsTrainerId?: number;
}) {
  const { data } = await staffApi.get<
    ApiResponse<
      {
        id: number;
        startAt: string;
        endAt: string;
        venue?: { id: number; name: string };
        note?: string | null;
      }[]
    >
  >('/trainer/ext/venue-bookings', { params });
  return data;
}

// ── Ops 延伸（群組、備註、黑名單、發票、訂閱）──
export async function fetchOpsMemberGroups() {
  const { data } = await staffApi.get<
    ApiResponse<{ id: number; name: string; description?: string; _count?: { members: number } }[]>
  >('/ops/member-groups');
  return data;
}

export async function createOpsMemberGroup(payload: {
  name: string;
  description?: string;
  branchId?: number;
}) {
  const { data } = await staffApi.post<ApiResponse>('/ops/member-groups', payload);
  return data;
}

export async function addOpsMemberToGroup(groupId: number, memberId: number) {
  const { data } = await staffApi.post<ApiResponse>(`/ops/member-groups/${groupId}/members`, {
    memberId,
  });
  return data;
}

export async function fetchOpsMemberNotes(memberId: number) {
  const { data } = await staffApi.get<
    ApiResponse<{ id: number; content: string; visibility: string; createdAt: string }[]>
  >(`/ops/members/${memberId}/notes`);
  return data;
}

export async function createOpsMemberNote(
  memberId: number,
  payload: { content: string; visibility?: 'SHARED' | 'STAFF_ONLY' },
) {
  const { data } = await staffApi.post<ApiResponse>(`/ops/members/${memberId}/notes`, payload);
  return data;
}

export async function adjustOpsMemberExpire(
  memberId: number,
  payload: { days: number; reason: string },
) {
  const { data } = await staffApi.post<ApiResponse<{ expireDate: string }>>(
    `/ops/members/${memberId}/adjust-expire`,
    payload,
  );
  return data;
}

export async function searchOpsInvoices(params: {
  from?: string;
  to?: string;
  invoiceNumber?: string;
}) {
  const { data } = await staffApi.get<
    ApiResponse<
      {
        kind: string;
        id: string;
        amount: number;
        invoiceNumber?: string;
        status: string;
        createdAt: string;
      }[]
    >
  >('/ops/invoices/search', { params });
  return data;
}

export async function fetchOpsPaymentBlacklist() {
  const { data } = await staffApi.get<ApiResponse<unknown[]>>('/ops/payment-blacklist');
  return data;
}

/** 結清欠款（DUTY+）：reason＝POS 收款單號或清償說明（後端必填 ≥2 字並寫稽核） */
export async function opsClearPaymentDebt(memberId: number, reason: string) {
  const { data } = await staffApi.post<ApiResponse<{ memberId: number; isActive: boolean; clearedAt: string }>>(
    `/ops/payment-blacklist/${memberId}/clear`,
    { reason },
  );
  return data;
}

export async function fetchAnalyticsYoy(year?: number) {
  const { data } = await staffApi.get<
    ApiResponse<{
      year: number;
      months: { month: number; amount: number; count: number }[];
      prevYear: number;
      prevMonths: { month: number; amount: number; count: number }[];
    }>
  >('/hq/reports/analytics/yoy', { params: year ? { year } : undefined });
  return data;
}

export async function fetchAnalyticsMembers(params?: { from?: string; to?: string }) {
  const { data } = await staffApi.get<ApiResponse<Record<string, unknown>>>(
    '/hq/reports/analytics/members',
    { params },
  );
  return data;
}

export async function fetchCardSubscriptionBatch(params?: { from?: string; to?: string }) {
  const { data } = await staffApi.get<
    ApiResponse<{ charges: unknown[]; summary: Record<string, number> }>
  >('/hq/reports/card-subscriptions/batch', { params });
  return data;
}

export async function fetchGroupClassCrm(params?: {
  from?: string;
  to?: string;
  branchId?: number;
}) {
  const { data } = await staffApi.get<
    ApiResponse<{ rows: unknown[]; summary: Record<string, unknown> }>
  >('/hq/reports/group-class-crm', { params });
  return data;
}

export type IdPhotoSide = 'front' | 'back';

export async function uploadMemberIdPhoto(
  imageDataUrl: string,
  side: IdPhotoSide = 'front',
  opts?: { consent?: boolean },
) {
  const { data } = await memberApi.post<
    ApiResponse<{
      idPhotoUrl?: string | null;
      idPhotoBackUrl?: string | null;
      side?: IdPhotoSide;
      bytes?: number;
      photoId?: string;
      retentionUntil?: string;
    }>
  >('/member/id-photo', {
    image: imageDataUrl,
    side,
    consent: opts?.consent !== false,
  });
  return data;
}

export async function fetchMemberIdPhotoMeta() {
  const { data } = await memberApi.get<
    ApiResponse<{
      sides: Record<string, unknown>;
      pendingDeletes: {
        id: string;
        side: string;
        status: string;
        reason?: string | null;
        requestedAt: string;
      }[];
    }>
  >('/member/id-photo/meta');
  return data;
}

/** 申請清除證件（須櫃檯核准） */
export async function requestMemberIdPhotoDelete(side: IdPhotoSide | 'both', reason?: string) {
  const { data } = await memberApi.post<
    ApiResponse<{ id: string; side: string; status: string }>
  >('/member/id-photo/delete-request', { side, reason });
  return data;
}

export async function cancelMemberIdPhotoDeleteRequest(requestId: string) {
  const { data } = await memberApi.post<ApiResponse>(
    `/member/id-photo/delete-request/${encodeURIComponent(requestId)}/cancel`,
  );
  return data;
}

/** 認證後證件影像路徑（需帶 token 用 blob fetch） */
export function memberIdPhotoPath(side: IdPhotoSide = 'front') {
  return `/api/member/id-photo?side=${side}`;
}

export async function fetchOpsMemberIdPhotos(memberId: number) {
  const { data } = await staffApi.get<
    ApiResponse<{
      sides: Record<string, { id?: string | null; side: string; createdAt?: string | null } | null>;
      pendingDeletes: {
        id: string;
        side: string;
        status: string;
        reason?: string | null;
        requestedAt: string;
      }[];
      policy?: Record<string, unknown>;
    }>
  >(`/ops/members/${memberId}/id-photos`);
  return data;
}

export function opsMemberIdPhotoPreviewPath(memberId: number, side: IdPhotoSide) {
  return `/api/ops/members/${memberId}/id-photos/${side}/preview`;
}

/** DUTY+：簽發 3～5 分短效調閱 URL（R2 Presigned 或 local token） */
export async function requestOpsMemberIdPhotoPresign(
  memberId: number,
  side: IdPhotoSide,
  reason: string,
) {
  const { data } = await staffApi.post<
    ApiResponse<{
      url: string;
      expiresAt: string;
      expiresIn: number;
      mode: 'r2_presign' | 'local_token' | string;
      side: IdPhotoSide;
      photoId?: string | null;
      driver?: string;
    }>
  >(`/ops/members/${memberId}/id-photos/${side}/presign`, { reason });
  return data;
}

/** 臨櫃代辦上傳證件；須客顯親簽取得之 consentSignatureId */
export async function uploadOpsMemberIdPhoto(
  memberId: number,
  payload: {
    image: string;
    side: IdPhotoSide;
    consentSignatureId: string;
    branchCode?: string;
  },
) {
  const { data } = await staffApi.post<
    ApiResponse<{
      photoId?: string;
      side?: IdPhotoSide;
      bytes?: number;
      retentionUntil?: string;
    }>
  >(`/ops/members/${memberId}/id-photo`, {
    image: payload.image,
    side: payload.side,
    consentSignatureId: payload.consentSignatureId,
    branchCode: payload.branchCode,
  });
  return data;
}

export async function fetchOpsIdPhotoDeleteRequests(status = 'PENDING') {
  const { data } = await staffApi.get<
    ApiResponse<
      {
        id: string;
        side: string;
        status: string;
        reason?: string | null;
        requestedAt: string;
        member?: { id: number; memberNo?: string | null; name: string; phone: string };
      }[]
    >
  >('/ops/id-photo-delete-requests', { params: { status } });
  return data;
}

export async function approveOpsIdPhotoDeleteRequest(requestId: string, note?: string) {
  const { data } = await staffApi.post<ApiResponse>(
    `/ops/id-photo-delete-requests/${encodeURIComponent(requestId)}/approve`,
    { note },
  );
  return data;
}

export async function rejectOpsIdPhotoDeleteRequest(requestId: string, note?: string) {
  const { data } = await staffApi.post<ApiResponse>(
    `/ops/id-photo-delete-requests/${encodeURIComponent(requestId)}/reject`,
    { note },
  );
  return data;
}
