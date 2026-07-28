import axios, { AxiosHeaders, type AxiosInstance } from 'axios';
import {
  getMemberToken,
  setMemberToken,
  getStaffToken,
  getOrCreateDeviceId,
  getOnboardingToken,
  clearMemberToken,
} from './storage';
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
  PurchaseOrder,
  StockMovement,
  PosPayMethod,
  PosCheckoutResult,
  StaffAccount,
  StaffPermission,
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
} from '../types/api';
import type { StaffInfo } from './storage';

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
export const gateApi = axios.create({ baseURL: '/api/gate' });

/** 會員 API：一律帶本機 deviceId；改綁後舊機收到 DEVICE_MISMATCH 則清 JWT 並強制回登入 */
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
    if (axios.isAxiosError(error)) {
      const code = (error.response?.data as { code?: string } | undefined)?.code;
      if (
        error.response?.status === 403 &&
        (code === 'DEVICE_MISMATCH' || code === 'DEVICE_REQUIRED')
      ) {
        clearMemberToken();
        if (typeof window !== 'undefined') {
          const msg = encodeURIComponent(
            (error.response.data as { message?: string })?.message ||
              '裝置已改綁，請重新登入',
          );
          // 硬導向：避免 ProtectedRoute 只看 localStorage 殘留而留在會員殼頁
          window.location.replace(`/?login_error=${msg}`);
        }
      }
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
  phone: string;
  purpose: 'LOGIN' | 'REGISTER' | string;
  isNew: boolean;
  faceEnabled?: boolean;
  facePreferenceSet?: boolean;
  member: {
    id: number;
    name: string;
    phone: string;
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
  nextStep:
    | 'REGISTER_PROFILE'
    | 'CHOOSE_FACE'
    | 'SIGN_CONTRACTS'
    | 'BIND_LINE'
    | 'BIND_DEVICE'
    | 'DONE'
    | string;
  onboardingToken?: string;
  token?: string;
  devCode?: string;
};

export async function onboardingLookup(phone: string) {
  const { data } = await publicApi.post<
    ApiResponse<{
      exists: boolean;
      maskedName: string | null;
      hasLineBound: boolean;
      hasDeviceBound: boolean;
    }>
  >('/onboarding/lookup', { phone });
  return data;
}

export async function onboardingSendOtp(phone: string) {
  const { data } = await publicApi.post<
    ApiResponse<{
      exists: boolean;
      purpose: string;
      expiresInSec: number;
      devCode?: string;
    }>
  >('/onboarding/otp/send', { phone });
  return data;
}

export async function onboardingVerifyOtp(phone: string, code: string) {
  const { data } = await publicApi.post<ApiResponse<OnboardingStatus>>(
    '/onboarding/otp/verify',
    { phone, code },
  );
  return data;
}

export async function onboardingStatus() {
  const { data } = await onboardingApi.get<ApiResponse<OnboardingStatus>>('/onboarding/status');
  return data;
}

export async function onboardingRegister(payload: {
  name: string;
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

export async function staffLogin(account: string, password: string) {
  const { data } = await publicApi.post<
    ApiResponse<{ token: string; staff: StaffInfo }>
  >('/admin/login', { account, password });
  return data;
}

export async function fetchStaffMe() {
  const { data } = await staffApi.get<ApiResponse<StaffInfo>>('/admin/me');
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
    }>
  >('/face/status');
  return data;
}

// ── Ops ──
export async function fetchOpsMembers() {
  const { data } = await staffApi.get<ApiResponse<OpsMember[]>>('/ops/members');
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
  branchIds: number[];
  faceEnabled?: boolean;
}) {
  const { data } = await staffApi.post<ApiResponse<OpsMember>>('/ops/members', payload);
  return data;
}

export async function updateOpsMember(
  memberId: number,
  payload: {
    name?: string;
    phone?: string;
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
}) {
  const { data } = await staffApi.post<
    ApiResponse<{
      checkoutId?: string;
      saleId?: string | null;
      orderId?: string | null;
      amount?: number;
      invoiceNumber?: string | null;
      /** Soft-split: one invoice per leg (SAL / promo / PT). */
      invoices?: Array<{
        leg: 'SALE' | 'PROMO' | 'PT' | string;
        id: string;
        invoiceNumber: string | null;
        amount: number;
        ok?: boolean;
        message?: string;
      }>;
      actionUrl?: string;
      payload?: Record<string, string>;
      payMethod?: string;
      message?: string;
    }>
  >('/ops/checkout', payload);
  return data;
}

export async function opsTopup(
  memberId: number,
  promotionId: number,
  options?: {
    qty?: number;
    payMethod?: 'CASH' | 'CARD' | 'VOUCHER';
    payments?: { method: string; amount: number; voucherCode?: string }[];
    carrierNum?: string;
    buyerUbn?: string;
    loveCode?: string;
    cardMode?: 'LUMP' | 'INSTALLMENT' | 'RECURRING';
    cardInst?: number;
    periodType?: 'W' | 'M' | 'Y';
    periodTimes?: number;
    recurringAmount?: number;
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
  });
  return data;
}

export async function opsRefund(
  orderId: string,
  options?: { invoiceNumber?: string; buyerEmail?: string },
) {
  const { data } = await staffApi.post('/ops/refund', {
    ...(orderId?.trim() ? { orderId: orderId.trim() } : {}),
    ...(options?.invoiceNumber?.trim()
      ? { invoiceNumber: options.invoiceNumber.trim().toUpperCase() }
      : {}),
    ...(options?.buyerEmail?.trim() ? { buyerEmail: options.buyerEmail.trim() } : {}),
  });
  return data;
}

export async function opsRefundLookup(params: { orderId?: string; invoiceNumber?: string }) {
  const { data } = await staffApi.get('/ops/refund-lookup', { params });
  return data;
}

export async function fetchAllowanceSlip(allowanceNo: string) {
  const { data } = await staffApi.get(`/ops/allowances/${encodeURIComponent(allowanceNo)}`);
  return data;
}

export async function fetchAllowanceSlips(params?: {
  orderId?: string;
  invoiceNumber?: string;
  take?: number;
}) {
  const { data } = await staffApi.get('/ops/allowances', { params });
  return data;
}

export async function fetchOpsCardSubscriptions(params?: {
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

export async function runDueCardSubscriptions(limit?: number) {
  const { data } = await staffApi.post('/ops/card-subscriptions/run-due', {
    ...(limit != null ? { limit } : {}),
  });
  return data;
}

export async function fetchOpsMemberLeaves(params?: { memberId?: number; status?: string }) {
  const { data } = await staffApi.get('/ops/member-leaves', { params });
  return data;
}

export async function startOpsMemberLeave(body: {
  memberId: number;
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

export async function opsCancelSale(
  saleId: string,
  reason?: string,
  options?: { prefer?: 'void' | 'allowance' },
) {
  const { data } = await staffApi.post('/ops/cancel-sale', {
    saleId,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
    ...(options?.prefer ? { prefer: options.prefer } : {}),
  });
  return data;
}

/** 取消私教課程購買：prefer void＝沖回｜allowance＝退費折讓 */
export async function opsCancelPtPurchase(options: {
  checkoutId?: string;
  orderId?: string;
  reason?: string;
  prefer?: 'void' | 'allowance';
}) {
  const { data } = await staffApi.post('/ops/cancel-pt-purchase', {
    ...(options.checkoutId?.trim()
      ? { checkoutId: options.checkoutId.trim() }
      : {}),
    ...(options.orderId?.trim() ? { orderId: options.orderId.trim() } : {}),
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    ...(options.prefer ? { prefer: options.prefer } : {}),
  });
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
  opts?: { code: string; invoiceSellerName?: string; invoiceSellerUbn?: string },
) {
  const { data } = await staffApi.post<ApiResponse<Branch>>('/hq/branches', {
    name,
    address,
    code: opts?.code,
    ...(opts?.invoiceSellerName !== undefined
      ? { invoiceSellerName: opts.invoiceSellerName }
      : {}),
    ...(opts?.invoiceSellerUbn !== undefined
      ? { invoiceSellerUbn: opts.invoiceSellerUbn }
      : {}),
  });
  return data;
}

export async function updateHqBranch(
  id: number,
  payload: Partial<{
    name: string;
    code: string;
    address: string | null;
    isActive: boolean;
    invoiceSellerName: string | null;
    invoiceSellerUbn: string | null;
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

export async function fetchHqPromotions(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<Promotion[]>>('/hq/promotions', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function createPromotion(payload: {
  branchIds: number[];
  name: string;
  price: number;
  bonusGiven?: number;
  usageType?: 'TIMED' | 'UNLIMITED';
  planMode?: 'STANDING' | 'CAMPAIGN';
  saleStartAt?: string | null;
  saleEndAt?: string | null;
  durationDays?: number | null;
  unitDays?: number | null;
  periodCount?: number | null;
  requiresMemberContract?: boolean;
  enableCardRecurring?: boolean;
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
    usageType: 'TIMED' | 'UNLIMITED';
    planMode: 'STANDING' | 'CAMPAIGN';
    saleStartAt: string | null;
    saleEndAt: string | null;
    durationDays: number | null;
    unitDays: number | null;
    periodCount: number | null;
    requiresMemberContract: boolean;
    enableCardRecurring: boolean;
    isActive: boolean;
    contractIds: number[];
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<Promotion>>(`/hq/promotions/${id}`, payload);
  return data;
}

export async function deleteHqPromotion(id: number) {
  const { data } = await staffApi.delete<ApiResponse<Promotion | { id: number }>>(
    `/hq/promotions/${id}`,
  );
  return data;
}

export async function fetchHqCoursePlans(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<CoursePlan[]>>('/hq/course-plans', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function createHqCoursePlan(payload: {
  branchIds: number[];
  name: string;
  planType: 'CUSTOM_PT' | 'GROUP';
  planMode?: 'STANDING' | 'CAMPAIGN';
  saleStartAt?: string | null;
  saleEndAt?: string | null;
  price: number;
  sessions?: number | null;
  capacity?: number | null;
  description?: string | null;
  enableCardRecurring?: boolean;
  requiresMemberContract?: boolean;
  enableSecondPerson?: boolean;
  giftLabel?: string | null;
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
    planType: 'CUSTOM_PT' | 'GROUP';
    planMode: 'STANDING' | 'CAMPAIGN';
    saleStartAt: string | null;
    saleEndAt: string | null;
    price: number;
    sessions: number | null;
    capacity: number | null;
    description: string | null;
    enableCardRecurring: boolean;
    requiresMemberContract: boolean;
    enableSecondPerson: boolean;
    giftLabel: string | null;
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
  role?: 'NORMAL' | 'MANAGER';
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
    role: 'NORMAL' | 'MANAGER';
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
  role: 'NORMAL' | 'MANAGER',
  branchIds: number[],
) {
  const { data } = await staffApi.post('/hq/trainers/assign', { trainerId, role, branchIds });
  return data;
}

export async function fetchHqProducts(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<Product[]>>('/hq/products', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function createHqProduct(payload: {
  branchId: number;
  sku: string;
  name: string;
  price: number;
  cost?: number;
  productKind?: 'PHYSICAL' | 'SERVICE';
  safetyStock?: number | null;
}) {
  const { data } = await staffApi.post<ApiResponse<Product>>('/hq/products', payload);
  return data;
}

export async function updateHqProduct(
  id: number,
  payload: Partial<{
    name: string;
    sku: string;
    price: number;
    cost: number;
    isActive: boolean;
    productKind: 'PHYSICAL' | 'SERVICE';
    safetyStock: number | null;
  }>,
) {
  const { data } = await staffApi.patch<ApiResponse<Product>>(`/hq/products/${id}`, payload);
  return data;
}

export async function fetchOpsInventoryProducts(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<Product[]>>('/ops/inventory/products', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function createOpsPurchase(payload: {
  branchId: number;
  supplier?: string;
  note?: string;
  items: { productId: number; qty: number; unitCost: number }[];
}) {
  const { data } = await staffApi.post<ApiResponse<PurchaseOrder>>('/ops/inventory/purchases', payload);
  return data;
}

export async function fetchOpsPurchases(branchId?: number) {
  const { data } = await staffApi.get<ApiResponse<PurchaseOrder[]>>('/ops/inventory/purchases', {
    params: branchId ? { branchId } : undefined,
  });
  return data;
}

export async function createOpsStockAdjustment(payload: {
  productId: number;
  reason: 'LOSS' | 'GAIN' | 'COUNT';
  qty: number;
  note?: string | null;
}) {
  const { data } = await staffApi.post<
    ApiResponse<{
      product: Product;
      movement: StockMovement | null;
      previousQty: number;
      reason: string;
    }>
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

export async function fetchHqStaff() {
  const { data } = await staffApi.get<ApiResponse<StaffAccount[]>>('/hq/staff');
  return data;
}

export async function createHqStaff(payload: {
  account: string;
  password: string;
  name: string;
  displayName?: string;
  role: 'STAFF' | 'DUTY' | 'MANAGER' | 'ADMIN';
  branchId?: number | null;
  permissions: StaffPermission[];
}) {
  const { data } = await staffApi.post<ApiResponse<StaffAccount>>('/hq/staff', payload);
  return data;
}

export async function updateHqStaff(
  id: number,
  payload: Partial<{
    name: string;
    displayName: string;
    role: 'STAFF' | 'DUTY' | 'MANAGER' | 'ADMIN';
    branchId: number | null;
    permissions: StaffPermission[];
    isActive: boolean;
    password: string;
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

export async function openOpsShift(body: {
  branchId: number;
  slot: 'MORNING' | 'MIDDAY' | 'EVENING';
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

export { redirectToCheckOut };

// ── PT／團課管理 ──
export async function fetchPtDashboard() {
  const { data } = await staffApi.get('/pt/dashboard-data');
  return data;
}

export async function scheduleGroupClass(payload: {
  title: string;
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
  capacity: number;
  trainerId: number;
}) {
  const { data } = await staffApi.post('/pt/schedule-group-class', payload);
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
