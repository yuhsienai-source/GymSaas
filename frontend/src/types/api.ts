import type { EmploymentType, LeaveType } from '../lib/laborLaw';
import type { BranchType, TrainerLevel } from '../lib/orgStructure';
import type { StaffPermission, StaffRole } from '../lib/storage';

export interface ApiResponse<T = unknown> {
  status: 'success' | 'error';
  code?: string;
  message?: string;
  data?: T;
}

export interface MemberProfile {
  id: number;
  /** 對外會員編號（自動序號） */
  memberNo?: string | null;
  name: string;
  phone: string;
  emergencyContact?: string | null;
  emergencyContactPhone?: string | null;
  plan: string;
  expireDate: string | null;
  /** 請假結束日；非空且未到期 → 禁止月費通行 */
  leaveUntil?: string | null;
  cashWallet: number;
  bonusWallet: number;
  allowBiometrics: boolean;
  isAlert: boolean;
  hasFaceBound: boolean;
  hasLineBound?: boolean;
  hasDeviceBound?: boolean;
  createdAt: string;
  /** 綁定分店（正式名稱） */
  branches?: { branchId: number; name: string }[];
  /** 分店正式名稱串接，如「體育客和平店(GYM)」 */
  branchLabel?: string | null;
  idPhotoUrl?: string | null;
  idPhotoBackUrl?: string | null;
  email?: string | null;
  gender?: string | null;
  birthDate?: string | null;
}

export interface MemberWallet {
  name: string;
  plan: string;
  expireDate: string | null;
  cashWallet: number;
  bonusWallet: number;
  isAlert: boolean;
}

export interface QrCodeResponse {
  qrToken: string;
  expiresInMs: number;
  ttlSeconds: number;
  message?: string;
}

export interface PtContract {
  id: number;
  member?: { id: number; name: string };
  trainer: { id: number; name: string };
  /** PURCHASE＝付費｜COMPENSATION＝總部補償贈送 */
  source?: 'PURCHASE' | 'COMPENSATION' | string;
  coursePlanId?: number | null;
  coursePlanName?: string | null;
  totalSessions: number;
  usedSessions: number;
  remainingSessions: number;
  pricePaid?: number;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface OpsMember {
  id: number;
  /** 對外會員編號（自動序號） */
  memberNo?: string | null;
  name: string;
  phone: string;
  email?: string | null;
  /** 身分證／居留證／護照（換機核身；開卡／註冊必填） */
  idNumber?: string | null;
  emergencyContact?: string | null;
  emergencyContactPhone?: string | null;
  plan: string;
  /** 會員目前方案名稱（由最近一次已成交購案快照推導） */
  planName?: string | null;
  expireDate?: string | null;
  cashWallet: number;
  bonusWallet: number;
  papagoFaceId: string | null;
  isAlert: boolean;
  allowBiometrics?: boolean;
  /** 櫃檯勾選啟用人臉；為 true 時生物辨識同意書才必簽 */
  faceEnabled?: boolean;
  lineId?: string | null;
  deviceId?: string | null;
  hasFaceBound?: boolean;
  hasDeviceBound?: boolean;
  hasLineBound?: boolean;
  /** 綁定分店（進出場須符合；AC↔HP 可互進） */
  branches?: {
    branchId: number;
    branch?: { id: number; name: string; code?: string | null } | null;
  }[];
  branchIds?: number[];
  /** 會員列表合約欄：所有啟用範本狀態 */
  contracts?: MemberContractBoardItem[];
}

export interface MemberContractBoardItem {
  contractId: number;
  title: string;
  shortName?: string | null;
  displayName?: string;
  purpose?: 'GENERAL' | 'NEW_MEMBER' | 'BIOMETRICS_CONSENT' | string;
  versionId: number | null;
  version: number | null;
  versionLabel?: string | null;
  signatureId: number | null;
  status: 'SIGNED' | 'PENDING' | 'UNSIGNED' | 'NEEDS_RESIGN' | string;
  required: boolean;
  /** 曾簽舊版、目前版本尚未重簽 */
  needsResign?: boolean;
  /** signed=綠 · unsigned=灰 · required=紅（必簽未簽）· resign=紅（版本異動需重簽） */
  tone: 'signed' | 'unsigned' | 'required' | 'resign' | string;
  signedAt?: string | null;
}

/** 會員個人資料頁契約列（已簽／應簽未簽） */
export interface MemberContractListItem extends MemberContractBoardItem {
  body?: string | null;
  changeNote?: string | null;
  signatureData?: string | null;
}

export interface Promotion {
  id: number;
  name: string;
  price: number;
  bonusGiven: number;
  /** SALE＝可售｜COMPENSATION＝客訴補償（禁銷售通路） */
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
  /** 定期定額每期扣款金額 */
  recurringAmount?: number | null;
  /** PayUNi 續期 Hash · 臨櫃 */
  payuniPeriodHash?: string | null;
  /** PayUNi 續期 Hash · 會員線上 */
  payuniPeriodHashOnline?: string | null;
  contracts?: { id: number; title: string; shortName?: string | null; displayName?: string; status: string }[];
  branchId?: number;
  branch?: { id: number; name: string; code?: string | null };
  isActive?: boolean;
  createdAt?: string;
}

export interface HqCompensationLog {
  id: string;
  action: 'BONUS' | 'EXPIRE' | 'CLEAR_ALERT' | 'COURSE' | string;
  memberId: number;
  actorStaffId: number;
  promotionId?: number | null;
  coursePlanId?: number | null;
  reason: string;
  detail?: Record<string, unknown> | null;
  createdAt: string;
  member?: { id: number; memberNo?: string | null; name: string; phone?: string };
  actorStaff?: { id: number; account: string; name: string };
  promotion?: {
    id: number;
    name: string;
    bonusGiven: number;
    price: number;
    kind?: string;
  } | null;
  coursePlan?: {
    id: number;
    name: string;
    sessions?: number | null;
    price: number;
    kind?: string;
  } | null;
}

export interface CardSubscriptionCharge {
  id: string;
  subscriptionId: string;
  orderId?: string | null;
  merchantNo?: string | null;
  amount: number;
  periodIndex: number;
  status: string;
  errorMessage?: string | null;
  attemptedAt: string;
  paidAt?: string | null;
}

export interface CardSubscription {
  id: string;
  memberId: number;
  promotionId?: number | null;
  coursePlanId?: number | null;
  originOrderId?: string | null;
  amount: number;
  periodType: string;
  periodTimes: number;
  chargedCount: number;
  status: string;
  nextChargeAt: string;
  lastChargeAt?: string | null;
  failCount: number;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  member?: {
    id: number;
    name: string;
    memberNo?: string | null;
    phone?: string;
    plan?: string;
    expireDate?: string | null;
    leaveUntil?: string | null;
  };
  promotion?: {
    id: number;
    name: string;
    price: number;
    usageType?: string;
    unitDays?: number | null;
    periodCount?: number | null;
    durationDays?: number | null;
    branchId: number;
    branch?: { id: number; name: string; code?: string | null };
  } | null;
  coursePlan?: {
    id: number;
    name: string;
    price?: number;
    branchId: number;
    branch?: { id: number; name: string; code?: string | null };
  } | null;
  charges?: CardSubscriptionCharge[];
}

export interface MemberLeave {
  id: number;
  memberId: number;
  subscriptionId?: string | null;
  days: number;
  startAt: string;
  endAt: string;
  expireDateBefore?: string | null;
  nextChargeAtBefore?: string | null;
  status: string;
  reason?: string | null;
  staffId?: number | null;
  createdAt: string;
  endedAt?: string | null;
  member?: {
    id: number;
    name: string;
    memberNo?: string | null;
    phone?: string | null;
    leaveUntil?: string | null;
    expireDate?: string | null;
    plan?: string;
  };
  subscription?: {
    id: string;
    status: string;
    nextChargeAt: string;
    amount: number;
  } | null;
}

export interface MembershipContractVersion {
  id: number;
  version: number;
  /** 顯示用標籤：V1、V1.1、V1.2… */
  versionLabel?: string;
  body: string;
  /** 條文 SHA-256 */
  bodyHash?: string | null;
  changeNote?: string | null;
  /** ACTIVE | VOIDED（條文異動後前版作廢） */
  status?: 'ACTIVE' | 'VOIDED' | string;
  createdByStaffId?: number | null;
  createdAt: string;
}

export interface MembershipContractChangeLog {
  id: number;
  action: 'CREATE' | 'UPDATE' | 'BUMP_VERSION' | 'VOID_CONTRACT' | 'REACTIVATE' | string;
  changeNote: string;
  summary?: string | null;
  versionId?: number | null;
  version?: number | null;
  versionLabel?: string | null;
  createdByStaffId?: number | null;
  createdAt: string;
}

export interface ContractAuditLog {
  id: string;
  contractId?: number | null;
  memberId?: number | null;
  signatureId?: number | null;
  versionId?: number | null;
  action: string;
  summary?: string | null;
  changeNote?: string | null;
  detail?: Record<string, unknown> | null;
  actorStaffId?: number | null;
  actorType?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export interface GymContractPreset {
  key: string;
  label: string;
  purpose: 'GENERAL' | 'NEW_MEMBER' | 'BIOMETRICS_CONSENT' | string;
  shortName: string;
  title: string;
  versionBase: string;
  body: string;
}

export interface MembershipContract {
  id: number;
  title: string;
  shortName?: string | null;
  /** 頁面顯示用：優先簡稱，否則完整標題 */
  displayName?: string;
  /** GENERAL | BIOMETRICS_CONSENT | NEW_MEMBER */
  purpose?: 'GENERAL' | 'NEW_MEMBER' | 'BIOMETRICS_CONSENT' | string;
  /** 初版版本備註（建立後鎖定） */
  versionBase?: string;
  status: 'ACTIVE' | 'VOIDED' | string;
  createdAt: string;
  updatedAt: string;
  currentVersion: MembershipContractVersion | null;
  versionCount: number;
  versions: MembershipContractVersion[];
  /** 操作歷程（每次異動含原因） */
  changeLogs?: MembershipContractChangeLog[];
}

export interface MemberContractSignature {
  id: number;
  memberId: number;
  contractId: number;
  contractTitle: string | null;
  contractShortName?: string | null;
  contractDisplayName?: string | null;
  contractStatus: string | null;
  contractVersionId: number;
  version: number | null;
  versionLabel?: string | null;
  body: string | null;
  bodyHash?: string | null;
  changeNote?: string | null;
  status: 'PENDING' | 'SIGNED' | string;
  signatureData: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  actorType?: string | null;
  signedAt: string | null;
  staffId: number | null;
  createdAt: string;
  updatedAt: string;
  /** 會員自查 API 可能附帶 */
  purpose?: 'GENERAL' | 'NEW_MEMBER' | 'BIOMETRICS_CONSENT' | string | null;
}

export interface CoursePlan {
  id: number;
  name: string;
  /** SALE＝可售｜COMPENSATION＝客訴補償課程（禁 POS／私教購案） */
  kind?: 'SALE' | 'COMPENSATION';
  planType: 'CUSTOM_PT' | 'GROUP' | string;
  planMode?: 'STANDING' | 'CAMPAIGN' | string;
  saleStartAt?: string | null;
  saleEndAt?: string | null;
  price: number;
  sessions?: number | null;
  capacity?: number | null;
  /** GROUP：單堂插班價（null＝不開放單堂） */
  dropInPrice?: number | null;
  /** GROUP：最低開班人數 */
  minEnrollment?: number | null;
  description?: string | null;
  requiresMemberContract?: boolean;
  enableCardRecurring?: boolean;
  /** 定期定額可選期數 bitmask：2／4／6（2+4）；null＝無 */
  recurringPeriods?: number | null;
  /** 2 期：第2期扣款金額 */
  recurringAmount?: number | null;
  /** 4 期：第1~3期共用扣款金額 */
  recurringAmount4?: number | null;
  /** 4 期：第4期扣款金額 */
  recurringAmountFinal?: number | null;
  /** PayUNi 續期 Hash · 臨櫃 */
  payuniPeriodHash?: string | null;
  /** PayUNi 續期 Hash · 會員線上 */
  payuniPeriodHashOnline?: string | null;
  /** 是否開放「課程第二人+$500(課程當日現場支付)」 */
  enableSecondPerson?: boolean;
  /** 加贈禮（入購物車，金額 $0） */
  giftLabel?: string | null;
  /** 加贈禮數量 */
  giftQty?: number | null;
  contracts?: { id: number; title: string; shortName?: string | null; displayName?: string; status: string }[];
  branchId?: number;
  branchName?: string;
  branch?: { id: number; name: string; code?: string | null };
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Branch {
  id: number;
  name: string;
  /** 員工端關聯顯示用代碼；會員介面仍用 name */
  code?: string | null;
  address: string | null;
  /** 所屬營業人（獨立統編／ezPay 商店）；發票由提供服務之分店營業人開立 */
  legalEntityId?: number | null;
  legalEntity?: LegalEntityRef | null;
  /** 分店類型（規則見 lib/orgStructure.ts） */
  type?: BranchType;
  /** 隸屬上層分店（僅 CLASS → GYM） */
  parentId?: number | null;
  parent?: { id: number; name: string; code?: string | null; type?: BranchType } | null;
  isActive: boolean;
  _count?: { venues: number; promotions: number; trainers: number; children?: number };
}

/** 進出場閘機裝置（綁定分店） */
export interface GateDevice {
  id: number;
  code: string;
  name: string;
  branchId: number;
  branch?: { id: number; name: string; code?: string | null } | null;
  branchLabel?: string;
  keyPrefix?: string | null;
  /** 僅建立／輪替時回傳一次 */
  deviceKey?: string;
  keyNote?: string;
  isActive: boolean;
  lastSeenAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface VenueStation {
  id: number;
  venueId: number;
  name: string;
  sortOrder?: number;
}

export interface Venue {
  id: number;
  name: string;
  branchId: number;
  branch?: { id: number; name: string; code?: string | null; parentId?: number | null };
  /** 場地下可選站點（A~E、外區等） */
  stations?: VenueStation[];
}

export interface Trainer {
  id: number;
  name: string;
  /** 對外顯示名稱（預設匿名） */
  displayName?: string | null;
  phone?: string;
  expertise?: string;
  role?: string;
  level?: TrainerLevel;
  isActive?: boolean;
  staffId?: number | null;
  staff?: {
    id: number;
    account: string;
    name: string;
    displayName?: string | null;
    isActive: boolean;
  } | null;
  branches?: { branchId: number; branch: { id: number; name: string; code?: string | null } }[];
}

export interface TrainerInboxItem {
  id: string;
  type: 'UNPAID' | 'ALERT' | 'LOW_SESSIONS' | 'EXPIRING' | 'NO_LINE' | string;
  severity: 'high' | 'medium' | 'low' | string;
  title: string;
  body: string;
  memberId?: number | null;
  memberName?: string | null;
  refId?: string | null;
  at: string;
  actionHint?: string | null;
}

export interface TrainerPtContract {
  id: number;
  memberId: number;
  memberName?: string | null;
  memberPhone?: string | null;
  memberNo?: string | null;
  hasLineBound?: boolean;
  isAlert?: boolean;
  cashWallet?: number;
  bonusWallet?: number;
  memberExpireDate?: string | null;
  trainerId?: number;
  /** 購買分店；私教上課僅限此店或 HP↔HR */
  branchId?: number | null;
  branchCode?: string | null;
  branchName?: string | null;
  coursePlanId?: number | null;
  coursePlanName?: string | null;
  /** PURCHASE＝付費｜COMPENSATION＝總部補償贈送 */
  source?: 'PURCHASE' | 'COMPENSATION' | string;
  totalSessions: number;
  usedSessions: number;
  remainingSessions: number;
  pricePaid: number;
  expiresAt?: string | null;
  isActive?: boolean;
  createdAt?: string;
}

export interface TrainerDashboardClass {
  id: number;
  title: string;
  type: string;
  startAt: string;
  endAt: string;
  capacity: number;
  booked: number;
  remaining: number;
  trainerId: number;
  trainerName?: string | null;
  venueId: number;
  venueName?: string | null;
  branchId?: number | null;
  branchName?: string | null;
  stationId?: number | null;
  stationName?: string | null;
  reservations?: {
    id: number;
    status: string;
    bookedAt: string;
    source?: string | null;
    memberId?: number | null;
    memberName?: string | null;
    memberPhone?: string | null;
    consultGuestId?: number | null;
    isConsultGuest?: boolean;
  }[];
}

export interface ConsultGuest {
  id: number;
  name: string;
  phone: string;
  note?: string | null;
  trainerId: number;
  memberId?: number | null;
  memberName?: string | null;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemberBookableClass {
  id: number;
  title: string;
  type: string;
  startAt: string;
  endAt: string;
  capacity: number;
  booked: number;
  remaining: number;
  trainerId: number;
  trainerName?: string | null;
  venueName?: string | null;
  branchName?: string | null;
  stationName?: string | null;
  myReservationId?: number | null;
  canBook?: boolean;
}

export interface MemberReservation {
  id: number;
  status: string;
  source?: string | null;
  bookedAt: string;
  canCancel?: boolean;
  class: {
    id: number;
    title: string;
    type: string;
    startAt: string;
    endAt: string;
    trainerName?: string | null;
    venueName?: string | null;
    branchName?: string | null;
    stationName?: string | null;
  } | null;
}

// ── 團課（付費期班）：金額／名額／可否請假一律由後端計算 ──
export type GroupEnrollKind = 'TERM' | 'DROP_IN';

export interface GroupTermQuote {
  price: number;
  sessions: number;
  unitPrice: number;
  prorated: boolean;
}

export interface GroupWaitlistMine {
  id: number;
  status: 'WAITING' | 'OFFERED' | string;
  offerExpiresAt?: string | null;
}

export interface GroupSeriesBase {
  id: number;
  title: string;
  coursePlanId: number | null;
  coursePlanName?: string | null;
  requiresMemberContract?: boolean;
  startDate: string;
  endDate: string;
  weekdays: number[];
  weekdaysLabel: string;
  startTime: string;
  endTime: string;
  capacity: number;
  termPrice: number | null;
  dropInPrice: number | null;
  sessionCount: number | null;
  minEnrollment: number;
  enrollDeadline: string | null;
  status: 'OPEN' | 'CANCELLED' | string;
  sellable: boolean;
  branchId: number | null;
  branchName?: string | null;
  venueName?: string | null;
  stationName?: string | null;
  trainerId: number;
  trainerName?: string | null;
}

export interface GroupSellableSeries extends GroupSeriesBase {
  remainingSessions: number;
  nextClassAt: string | null;
  termQuote: GroupTermQuote | null;
  seatsLeft: number;
  waitingCount: number;
  enrolledCount: number;
  myEnrollment: { id: number; status: string } | null;
  myWaitlist: GroupWaitlistMine | null;
}

export interface GroupSeriesClass {
  id: number;
  startAt: string;
  endAt: string;
  capacity: number;
  booked: number;
  upcoming: boolean;
  dropInSeats: number;
  mine: boolean;
}

export interface GroupSeriesDetail extends GroupSeriesBase {
  remainingSessions: number;
  termQuote: GroupTermQuote | null;
  seatsLeft: number;
  waitingCount: number;
  myWaitlist: GroupWaitlistMine | null;
  classes: GroupSeriesClass[];
}

export interface GroupEnrollmentReservation {
  id: number;
  status: string;
  classId: number;
  startAt: string;
  endAt: string;
  canLeave: boolean;
}

export interface GroupMyEnrollment {
  id: number;
  kind: GroupEnrollKind;
  status: 'PENDING' | 'ACTIVE' | 'REFUNDED' | string;
  price: number;
  sessionsTotal: number;
  source: 'POS' | 'ONLINE' | string;
  paidAt: string | null;
  holdExpiresAt: string | null;
  refundAmount: number | null;
  refundedAt: string | null;
  series: GroupSeriesBase;
  reservations: GroupEnrollmentReservation[];
}

export interface GroupMyWaitlist {
  id: number;
  status: 'WAITING' | 'OFFERED' | string;
  seriesId: number;
  seriesTitle: string;
  startDate: string;
  position: number | null;
  offerExpiresAt: string | null;
}

export interface GroupMakeupCredit {
  id: number;
  status: 'AVAILABLE' | 'USED' | string;
  expiresAt: string;
  sourceSeriesTitle: string | null;
  usedReservation: {
    id: number;
    status: string;
    title: string;
    startAt: string;
    canLeave: boolean;
  } | null;
}

export interface GroupMemberOverview {
  enrollments: GroupMyEnrollment[];
  waitlist: GroupMyWaitlist[];
  makeupCredits: GroupMakeupCredit[];
}

export interface GroupMakeupOption {
  classId: number;
  seriesId: number;
  seriesTitle: string;
  startAt: string;
  endAt: string;
  seats: number;
  branchName?: string | null;
  venueName?: string | null;
  trainerName?: string | null;
}

export interface GroupEnrollResult {
  payMethod: 'CARD' | 'LINEPAY';
  actionUrl?: string;
  payload?: Record<string, string>;
  paymentUrl?: string;
  orderId: string;
  enrollmentId: number;
  amount: number;
  sessions: number;
  prorated: boolean;
  holdExpiresAt: string | null;
}

export interface GroupRefundPreview {
  enrollmentId: number;
  kind: GroupEnrollKind;
  seriesId: number;
  seriesTitle: string;
  seriesCancelled: boolean;
  memberId: number;
  memberName: string | null;
  orderId: string;
  price: number;
  unitPrice: number;
  sessionsTotal: number;
  consumedSessions: number;
  paidAt: string | null;
  refundable: boolean;
  refundKind: 'COOLING_OFF' | 'STANDARD' | 'SERIES_CANCELLED' | 'DROP_IN' | string | null;
  refundAmount: number;
  fee: number;
  consumedValue: number;
  unfulfilled: number;
  blockCode: string | null;
  blockMessage: string | null;
  channels: { WALLET_CASH: number; LINEPAY: number; MANUAL: number };
  invoice: { plan: string; invoiceNumber: string | null };
}

export interface GroupAdminSeries extends GroupSeriesBase {
  classCount: number;
  termActive: number;
  termPending: number;
  dropInActive: number;
  refunded: number;
  waiting: number;
  offered: number;
  belowMinimum: boolean;
  deadlinePassed: boolean;
  needsDecision: boolean;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface GroupSeriesRoster {
  series: GroupSeriesBase;
  seatsLeft: number;
  classes: { id: number; startAt: string; endAt: string; capacity: number; booked: number; attended: number }[];
  enrollments: {
    id: number;
    kind: GroupEnrollKind;
    status: string;
    classId: number | null;
    price: number;
    sessionsTotal: number;
    source: string;
    paidAt: string | null;
    holdExpiresAt: string | null;
    refundAmount: number | null;
    refundKind: string | null;
    memberId: number;
    memberName: string | null;
    memberNo: string | null;
  }[];
  waitlist: {
    id: number;
    status: string;
    memberId: number;
    memberName: string | null;
    memberNo: string | null;
    createdAt: string;
    offerExpiresAt: string | null;
  }[];
}

export interface GroupCoursePlanOption {
  id: number;
  name: string;
  branchId: number;
  branchName?: string | null;
  price: number;
  dropInPrice: number | null;
  sessions: number | null;
  capacity: number | null;
  minEnrollment: number | null;
}

export interface TrainerTimeOff {
  id: number;
  trainerId: number;
  startAt: string;
  endAt: string;
  reason: string;
  note?: string | null;
  createdByStaffId?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface TrainerDashboardData {
  isAdmin: boolean;
  canSwitch: boolean;
  needsTrainerPick: boolean;
  profile: {
    id: number;
    name: string;
    displayName?: string | null;
    phone: string;
    role: string;
    branches: { branchId: number; branch: { id: number; name: string; code?: string | null } }[];
  } | null;
  trainers: Trainer[];
  venues: Venue[];
  upcomingClasses: TrainerDashboardClass[];
  recentClasses: TrainerDashboardClass[];
  ptContracts: TrainerPtContract[];
  inbox?: TrainerInboxItem[];
  timeOffs?: TrainerTimeOff[];
  timeOffReasons?: string[];
  /** 已綁定在職員工（僱傭關係）才可排課 */
  employed?: boolean;
  /** 未來 14 日已生效出勤時段（可預約時段＝出勤 − 請假 − 不開放預約） */
  workSlots?: { id: number; startAt: string; endAt: string; branchId: number | null }[];
  stats: {
    todayClasses: number;
    upcomingClasses: number;
    openSeats: number;
    activePtContracts: number;
    remainingPtSessions: number;
    inboxCount?: number;
    unpaidCount?: number;
    upcomingTimeOffs?: number;
  };
}

export interface GateLogEntry {
  time: string;
  msg: string;
  isError: boolean;
}

/** 櫃檯維運：目前在場進場紀錄 */
export interface OpsActiveCheckIn {
  logId: number;
  gateAccessNo?: string | null;
  memberId: number;
  memberNo: string;
  name: string;
  phone?: string | null;
  plan?: string | null;
  billingMode?: string | null;
  checkInAt: string;
  branchId?: number | null;
  branchLabel?: string | null;
}

/** POS 可售商品（`GET /ops/products`：分店上架中＋分店庫存／售價） */
export interface Product {
  id: number;
  branchId: number;
  sku: string;
  barcode?: string | null;
  name: string;
  /** PHYSICAL=實體控庫存 | SERVICE=服務類不控庫存 */
  productKind?: ProductKind | string;
  taxType?: TaxType | string;
  price: number;
  stockQty: number;
  safetyStock?: number | null;
  isActive?: boolean;
}

export type ProductKind = 'PHYSICAL' | 'SERVICE';
/** 課稅別：應稅 5%／零稅率／免稅 */
export type TaxType = 'TAXABLE' | 'ZERO' | 'FREE';

export interface LegalEntityRef {
  id: number;
  code: string;
  name: string;
  ubn?: string;
  isActive?: boolean;
}

/** 營業人（獨立統編＝獨立 ezPay 商店）；HashKey／IV 僅存後端 env，API 不回傳 */
export interface LegalEntity extends LegalEntityRef {
  ubn: string;
  address: string | null;
  phone: string | null;
  ezpayMerchantId: string | null;
  isActive: boolean;
  /** 後端檢查 env 金鑰是否齊備（只回缺漏的變數名稱） */
  ezpay: { configured: boolean; missing: string[]; merchantId: string | null };
  branches?: { id: number; name: string; code: string | null; type: BranchType; isActive: boolean }[];
}

/** 商品主檔（全公司共用 SKU；庫存／成本在分店層） */
export interface ProductMaster {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  invoiceName: string | null;
  unit: string;
  productKind: ProductKind;
  taxType: TaxType;
  listPrice: number;
  isActive: boolean;
  totalOnHand: number;
  listedBranchIds: number[];
}

/** 分店庫存列（avgCost 為驗收移動平均，後端計算） */
export interface BranchStockRow {
  id: number;
  branchId: number;
  branch: { id: number; name: string; code: string | null } | null;
  productId: number;
  sku: string;
  barcode: string | null;
  name: string;
  unit: string;
  productKind: ProductKind;
  taxType: TaxType;
  listPrice: number;
  salePrice: number | null;
  price: number;
  onHand: number;
  avgCost: number;
  stockValue: number;
  safetyStock: number | null;
  lowStock: boolean;
  isListed: boolean;
  productActive: boolean;
  updatedAt: string;
}

export interface StockMovement {
  id: number;
  branchId: number;
  productId: number;
  qtyDelta: number;
  balanceAfter: number;
  unitCost: number | null;
  /** OPENING／RECEIPT／SALE／SALE_CANCEL／LOSS／GAIN／STOCKTAKE／TRANSFER_IN／TRANSFER_OUT… */
  refType: string;
  refId: string | null;
  reason: string | null;
  staffId: number | null;
  createdAt: string;
  product?: { id: number; sku: string; name: string };
  branch?: { id: number; name: string; code: string | null };
}

export type SupplierPaymentTerm = 'NET' | 'EOM' | 'COD';

export interface Supplier {
  id: number;
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
}

export type PurchaseOrderStatus = 'DRAFT' | 'ORDERED' | 'PARTIAL' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';

export interface PurchaseOrderItem {
  id: number;
  productId: number;
  qtyOrdered: number;
  qtyReceived: number;
  unitCost: number;
  taxType: TaxType;
  product?: { id: number; sku: string; name: string; unit: string };
}

export interface PurchaseOrder {
  id: string;
  legalEntityId: number;
  branchId: number;
  supplierId: number;
  status: PurchaseOrderStatus;
  expectedAt: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  note: string | null;
  orderedAt: string | null;
  closedAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  items: PurchaseOrderItem[];
  supplier?: { id: number; name: string; ubn: string | null };
  branch?: { id: number; name: string; code: string | null };
  legalEntity?: LegalEntityRef;
  receipts?: { id: string; receivedAt: string; total: number; supplierInvoiceNo: string | null }[];
}

export interface PurchaseReceipt {
  id: string;
  purchaseOrderId: string | null;
  branchId: number;
  supplierId: number;
  supplierInvoiceNo: string | null;
  supplierInvoiceDate: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  receivedAt: string;
  note: string | null;
  items: { id: number; productId: number; qty: number; unitCost: number; product?: { id: number; sku: string; name: string; unit?: string } }[];
  supplier?: { id: number; name: string };
  branch?: { id: number; name: string; code: string | null };
  legalEntity?: LegalEntityRef;
  payable?: { id: string; status: string; amount: number; paidAmount: number; dueDate: string } | null;
}

/** 門市驗收紀錄（不含金額） */
export interface OpsReceiptRow {
  id: string;
  purchaseOrderId: string | null;
  branch: { id: number; name: string; code: string | null };
  supplier: { id: number; name: string };
  supplierInvoiceNo: string | null;
  receivedAt: string;
  note: string | null;
  items: { productId: number; product: { id: number; sku: string; name: string }; qty: number }[];
}

export type PayableStatus = 'OPEN' | 'PARTIAL' | 'PAID' | 'VOID';

export interface SupplierPayable {
  id: string;
  legalEntityId: number;
  supplierId: number;
  receiptId: string | null;
  type: string;
  supplierInvoiceNo: string | null;
  amount: number;
  paidAmount: number;
  dueDate: string;
  status: PayableStatus;
  note: string | null;
  voidReason: string | null;
  createdAt: string;
  openAmount: number;
  overdueDays: number;
  supplier?: { id: number; name: string };
  legalEntity?: LegalEntityRef;
  receipt?: { id: string; receivedAt: string; purchaseOrderId: string | null; branchId: number } | null;
}

export interface PayableAgingRow {
  legalEntity: LegalEntityRef;
  supplier: { id: number; name: string };
  notDue: number;
  d30: number;
  d60: number;
  d90: number;
  over90: number;
  total: number;
}

export type SupplierPaymentMethod = 'TRANSFER' | 'CASH' | 'CHECK';

export interface SupplierPayment {
  id: string;
  legalEntityId: number;
  supplierId: number;
  amount: number;
  method: SupplierPaymentMethod;
  paidAt: string;
  reference: string | null;
  note: string | null;
  supplier?: { id: number; name: string };
  legalEntity?: LegalEntityRef;
  allocations: { payableId: string; amount: number }[];
}

export type EInvoiceStatus = 'PENDING' | 'ISSUING' | 'ISSUED' | 'FAILED' | 'VOIDED' | 'CANCELLED';

/** 電子發票（HQ 監控；B2B＝打統編、B2C＝載具／捐贈／紙本） */
export interface EInvoiceRow {
  id: string;
  refType: string;
  refId: string;
  leg: string | null;
  amount: number;
  itemDesc: string | null;
  category: 'B2B' | 'B2C';
  /** 佇列相容狀態：SUCCESS／PENDING／FAILED… */
  status: string;
  einvoiceStatus: EInvoiceStatus;
  retryCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
  invoiceNumber: string | null;
  checkoutId: string | null;
  branchId: number | null;
  legalEntity: LegalEntityRef | null;
  createdAt: string;
  updatedAt: string;
  merchantOrderNo: string;
  buyerUbn: string | null;
  buyerName: string | null;
  carrierType: string | null;
  printFlag: string | null;
  taxType: string | null;
  salesAmount: number;
  taxAmount: number;
  allowanceTotal: number;
  issuedAt: string | null;
  periodKey: string | null;
  voidReason: string | null;
}

/** ezPay 呼叫紀錄（後端 EInvoiceLog，唯讀） */
export interface EInvoiceLogRow {
  id: number;
  einvoiceId: string | null;
  refId: string | null;
  leg: string | null;
  merchantOrderNo: string | null;
  totalAmount: number | null;
  einvoiceStatus: EInvoiceStatus | null;
  legalEntityId: number | null;
  merchantId: string | null;
  action: 'ISSUE' | 'RECOVER' | 'VOID' | 'ALLOWANCE';
  result: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  attempt: number | null;
  manual: boolean;
  staffId: number | null;
  errorCode: string | null;
  ezpayStatus: string | null;
  message: string | null;
  invoiceNumber: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** 門市銷貨對帳（後端計算；前端只組 Excel／CSV） */
export interface ReconColumn {
  key: string;
  label: string;
  type: 'text' | 'int' | 'money';
}

export type ReconCell = string | number | boolean | null;

export interface ReconTotals {
  salesAmount: number;
  taxAmount: number;
  totalAmount: number;
  qty: number;
  lines: number;
}

export interface ReconAmounts {
  count: number;
  salesAmount: number;
  taxAmount: number;
  totalAmount: number;
}

export interface SalesReconciliation {
  range: { from: string; to: string; days: number };
  branch: { id: number; name: string; code: string | null } | null;
  legalEntities: Array<{ id: number; code: string; name: string; ubn: string }>;
  generatedAt: string;
  /** 商品銷貨明細（依銷貨日期） */
  columns: ReconColumn[];
  rows: Array<Record<string, ReconCell>>;
  /** 門市全部發票（所有來源，依開立日期；含本期作廢與待開立） */
  invoiceColumns: ReconColumn[];
  invoices: Array<Record<string, ReconCell>>;
  invoiceItemColumns: ReconColumn[];
  invoiceItems: Array<Record<string, ReconCell>>;
  allowanceColumns: ReconColumn[];
  allowances: Array<Record<string, ReconCell>>;
  summary: {
    orderCount: number;
    cancelledOrderCount: number;
    valid: ReconTotals;
    cancelled: ReconTotals;
    byTaxType: { TAXABLE: ReconTotals; TAX_FREE: ReconTotals };
    uninvoiced: { count: number; totalAmount: number; saleIds: string[] };
    orderAmountMismatch: number;
    invoices: {
      /** 本期開立（含後續作廢） */
      issuedAll: ReconAmounts;
      /** 本期開立且有效 */
      effective: ReconAmounts;
      /** 本期作廢（含前期開立） */
      voided: ReconAmounts;
      /** 開立失敗／待開立 */
      pending: ReconAmounts;
      allowance: ReconAmounts;
      net: { salesAmount: number; taxAmount: number; totalAmount: number };
      byTaxType: { TAXABLE: ReconAmounts; TAX_FREE: ReconAmounts };
      bySource: Array<ReconAmounts & { code: string; label: string }>;
    };
  };
}

export type PosPayMethod = 'CASH' | 'CARD' | 'YIPAY' | 'LINEPAY' | 'WALLET_CASH' | 'VOUCHER';

export interface PosCheckoutResult {
  saleId: string;
  amount: number;
  payMethod: string;
  payBreakdown?: Record<string, number>;
  cardAmount?: number;
  voucherCode?: string | null;
  invoiceNumber?: string | null;
  actionUrl?: string;
  payload?: Record<string, string>;
  items?: unknown[];
  member?: { id: number; name: string; cashWallet: number } | null;
}

export type { StaffPermission, StaffRole };

export interface StaffAvatar {
  dataUrl: string;
  photoUpdatedAt: string | null;
}

export interface StaffConsentTemplate {
  kind: 'BIOMETRICS';
  version: string;
  title: string;
  body: string;
  bodyHash: string;
}

export interface StaffFaceConsent {
  id: number;
  version: string;
  signerName: string;
  signedAt: string;
  witnessName: string | null;
  signatureData?: string;
  /** false＝條文已升版，須重簽才可註冊人臉 */
  current: boolean;
}

export interface StaffPhotoStatus {
  id: number;
  photoUpdatedAt: string | null;
  faceEnrolledAt: string | null;
  faceConsentAt: string | null;
  warning?: string | null;
}

export interface StaffAccount {
  id: number;
  account: string;
  name: string;
  displayName?: string | null;
  role: StaffRole;
  branchId: number | null;
  permissions: StaffPermission[];
  isActive: boolean;
  createdAt: string;
  /** 頭像版本（null＝無照片） */
  photoUpdatedAt?: string | null;
  /** 已註冊 Face8 員工人臉 */
  faceEnrolledAt?: string | null;
  /** 已記錄生物辨識書面同意 */
  faceConsentAt?: string | null;
  employmentType?: EmploymentType;
  /** 到職日 YYYY-MM-DD */
  hireDate?: string | null;
  /** 約定每週工時（兼職／實習） */
  weeklyHours?: number | null;
  /** 實習無勞雇關係者 false */
  laborActApplies?: boolean;
  leaveBalance?: StaffLeaveBalance | null;
  branch?: {
    id: number;
    name: string;
    code?: string | null;
    type?: BranchType;
    parentId?: number | null;
  } | null;
}

export interface MemberIdentifyResult {
  method: 'PHONE' | 'QR' | 'FACE';
  match?: string;
  member: OpsMember | null;
  candidates: OpsMember[];
}

// ── CMS / 探索 ──
export interface CmsAnnouncement {
  id: number;
  title: string;
  body: string;
  branchId?: number | null;
  category?: string;
  pushEnabled?: boolean;
  publishedAt?: string;
  expiresAt?: string | null;
  isActive?: boolean;
}

export interface CmsFaqItem {
  id: number;
  branchId?: number | null;
  category?: string;
  question: string;
  answer: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface CmsBranchIntro {
  id: number;
  name: string;
  code?: string;
  address?: string | null;
  introText?: string | null;
  introImages?: unknown;
  introVideos?: unknown;
  showOccupancy?: boolean;
}

export interface CmsTrainerPublic {
  id: number;
  displayName: string;
  bio?: string | null;
  photoUrl?: string | null;
  branches?: { branchId: number; name?: string | null; code?: string | null }[];
}

export interface MemberOrderHistoryItem {
  kind: 'ORDER' | 'CHECKIN';
  at: string;
  id: number | string;
  amount?: number;
  itemDesc?: string;
  status?: string;
  payMethod?: string;
  checkInAt?: string;
  checkOutAt?: string | null;
  fee?: number;
  billingMode?: string;
  branchId?: number;
}

export interface MemberClassRecords {
  reservations: MemberReservation[];
  attendances: {
    id: number;
    checkedInAt?: string;
    class?: {
      id: number;
      title: string;
      type?: string;
      startAt?: string;
      endAt?: string;
    };
  }[];
}

export interface MemberSubscription {
  id: string;
  status: string;
  nextChargeAt?: string | null;
  promotion?: { id: number; name: string; usageType?: string; branchId?: number };
}

export interface MemberGiftCards {
  purchased: { id: string; code: string; amount: number; status: string; createdAt?: string }[];
  redeemed: { id: string; code: string; amount: number; status: string; redeemedAt?: string }[];
}

export interface MemberPointsLedgerEntry {
  id: number;
  delta: number;
  balance: number;
  reason?: string;
  createdAt: string;
}

export interface MarketingCampaign {
  id: number;
  name: string;
  segment?: string;
  message?: string;
  status?: string;
  scheduledAt?: string | null;
  createdAt?: string;
  _count?: { pushLogs: number };
}

export interface LotteryPool {
  id: number;
  name: string;
  status?: string;
  drawAt?: string | null;
  _count?: { entries: number };
}

export interface StaffAttendanceRow {
  id: number;
  staffId: number;
  punchIn: string;
  punchOut?: string | null;
  note?: string | null;
  staff?: { id: number; name: string; displayName?: string | null; role?: string };
}

/** 後端 laborLaw.computeLeaveBalances 結果 */
export interface StaffLeaveBalance {
  employmentType: EmploymentType;
  hireDate: string | null;
  /** 工時比例（正職 1；兼職＝週工時／40；無勞雇關係實習 0） */
  ratio: number;
  laborActApplies: boolean;
  seniority: { years: number; months: number; days: number; totalMonths: number; started: boolean } | null;
  annualLeave: {
    eligible: boolean;
    periodStart: string | null;
    periodEnd: string | null;
    days: number;
    nextGrantDate: string;
    nextGrantDays: number;
    entitledHours: number;
    usedHours: number;
    unit: 'DAY' | 'HOUR';
  } | null;
  nationalHoliday: {
    year: number;
    /** null＝部分工時，依約定工作日 */
    entitledDays: number | null;
    usedDays: number;
    basis: 'CALENDAR' | 'SCHEDULED_WORKDAY';
  } | null;
}

export type RosterCellCode = 'MORNING' | 'EVENING' | 'REGULAR_OFF' | 'REST_DAY' | 'OFF';

export interface RosterIssue {
  level: 'ERROR' | 'WARNING' | 'INFO';
  code: string;
  message: string;
  date?: string;
}

export interface RosterStaffRow {
  id: number;
  name: string;
  displayName?: string | null;
  role: string;
  /** STORE 場務 | INTERN_TRAINER 實習教練 | FREE_TRAINER 已轉正（週班表提報、FM／店長核准） */
  rosterRole: 'STORE' | 'INTERN_TRAINER' | 'FREE_TRAINER' | null;
  rosterRoleLabel: string;
  employmentType: EmploymentType;
  weeklyHours: number | null;
  laborActApplies: boolean;
  /** 本期可排班數上限 */
  capacity: number;
  cells: Record<string, RosterCellCode>;
  leaveDays: string[];
  offRequest: RosterOffRequest | null;
  /** 已發布版本之確認回覆；null＝未回覆或未發布 */
  ack: {
    status: RosterAckStatus;
    message: string | null;
    respondedAt: string;
    late: boolean;
    /** 逾期未回覆由系統自動視為同意 */
    autoConfirmed: boolean;
  } | null;
  stats: {
    workDays: number;
    workHours: number;
    regularOff: [number, number];
    restDays: number;
    offDays: number;
    leaveDays: number;
    unassigned: number;
    holidaysWorked: number;
    requestedOff: number;
    requestedOffUnmet: number;
    maxConsecutive: number;
  };
  issues: RosterIssue[];
}

export interface RosterView {
  branch: { id: number; name: string; code?: string | null };
  config: { cycleAnchorDate: string; requirement: { MORNING: number; EVENING: number } } | null;
  cycle: {
    startDate: string;
    endDate: string;
    /** 排假截止日（每期開始前 14 日，含當日） */
    offRequestDeadline: string;
    prevStartDate: string;
    nextStartDate: string;
    days: { date: string; weekday: number; holiday: string | null }[];
  };
  period: { id: number; status: 'DRAFT' | 'PUBLISHED'; publishedAt: string | null; note: string | null } | null;
  requirement: { MORNING: number; EVENING: number };
  staff: RosterStaffRow[];
  coverage: { date: string; MORNING: number; EVENING: number }[];
  issues: RosterIssue[];
  summary: {
    errors: number;
    warnings: number;
    offRequests: { submitted: number; total: number };
    /** 發布後才有：員工 72 小時內確認回覆統計 */
    acks: {
      deadline: string;
      hours: number;
      total: number;
      confirmed: number;
      autoConfirmed: number;
      disputed: number;
      pending: number;
      overdue: boolean;
    } | null;
  };
}

export type RosterAckStatus = 'CONFIRMED' | 'DISPUTED';

export interface RosterOffRequest {
  dates: string[];
  note: string | null;
  submittedAt: string;
  updatedAt: string;
}

export interface MyRosterCycle {
  startDate: string;
  endDate: string;
  days: RosterView['cycle']['days'];
  period: { status: 'DRAFT' | 'PUBLISHED'; publishedAt: string | null } | null;
  offRequestDeadline: string;
  /** 排假不可再改（已過截止日或已發布） */
  locked: boolean;
  ack: {
    deadline: string;
    status: RosterAckStatus | 'PENDING';
    message: string | null;
    respondedAt: string | null;
    overdue: boolean;
    late: boolean;
    autoConfirmed: boolean;
  } | null;
  request: RosterOffRequest | null;
  cells: Record<string, RosterCellCode>;
  leaveDays: string[];
}

export interface MyRosterOverview {
  rosterRole: RosterStaffRow['rosterRole'];
  rosterRoleLabel: string | null;
  /** 週班表對象（轉正教練／店長・GM・FM）；null＝四週排班或免排班 */
  weekPlanRole: WeekPlanRole | null;
  eligible: boolean;
  maxOffDays: number;
  offRequestDeadlineDays: number;
  ackHours: number;
  branch: { id: number; name: string; code?: string | null } | null;
  configured: boolean;
  cycles: MyRosterCycle[];
}

export interface RosterBranchConfig {
  branchId: number;
  name: string;
  code?: string | null;
  config: RosterView['config'];
}

export interface PublicHoliday {
  id: number;
  date: string;
  name: string;
  /** 0＝週日 */
  weekday: number;
  past: boolean;
}

export interface HolidayCalendar {
  year: number;
  holidays: PublicHoliday[];
  /** 內建預設中該年尚未建立之筆數 */
  missingDefaults: number;
  defaultYears: number[];
}

type HrStaffRef = { id: number; name: string; displayName?: string | null; role?: StaffRole; branchId?: number | null };

/** 考勤／請假比對用之班次摘要 */
export interface ScheduleBrief {
  id: number;
  branchId: number | null;
  startAt: string;
  endAt: string;
  label: string;
  source: ScheduleSource;
}

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface StaffLeaveRow {
  id: number;
  staffId: number;
  staff: HrStaffRef | null;
  leaveType: LeaveType;
  leaveTypeLabel: string;
  startAt: string;
  endAt: string;
  hours: number | null;
  reason: string | null;
  status: LeaveStatus;
  statusLabel: string;
  createdAt: string;
  requestedBySelf: boolean;
  review: { at: string; byStaffId: number | null; note: string | null } | null;
  /** 與請假重疊之已生效出勤班次 */
  conflicts: ScheduleBrief[];
}

export interface LeaveOverview {
  counts: Record<LeaveStatus, number>;
  truncated: boolean;
  rows: StaffLeaveRow[];
}

export interface MyLeaves {
  balance: StaffLeaveBalance | null;
  leaveTypes: { value: LeaveType; label: string }[];
  rows: StaffLeaveRow[];
}

export type AttendanceFlag =
  | 'LATE'
  | 'EARLY_LEAVE'
  | 'MISSED_PUNCH_OUT'
  | 'OPEN'
  | 'UNSCHEDULED'
  | 'CORRECTED'
  | 'BACKFILLED';

export interface AttendanceRecord {
  id: number;
  staffId: number;
  staff: HrStaffRef | null;
  branchId: number | null;
  dateKey: string;
  punchIn: string;
  punchOut: string | null;
  workedMinutes: number | null;
  source: 'SELF' | 'HQ';
  note: string | null;
  missedPunchOut: boolean;
  correction: { at: string; byStaffId: number | null; reason: string | null } | null;
  schedule: ScheduleBrief | null;
  /** 打卡時已綁定該班次（否則為舊紀錄就近配對） */
  scheduleBound?: boolean;
  flags: AttendanceFlag[];
  lateMinutes: number;
  earlyMinutes: number;
}

/** 班表值勤判定狀態（後端計算）：EXEMPT 管理員免判定／CLOCKED_IN 上班中／IN_WINDOW 值勤窗內未打卡／ON_LEAVE 請假中／BRANCH_SCOPE 班次分店不在登入權限／OFF_SHIFT 非值勤時段 */
export type StaffDutyState = 'EXEMPT' | 'CLOCKED_IN' | 'IN_WINDOW' | 'ON_LEAVE' | 'BRANCH_SCOPE' | 'OFF_SHIFT';

export interface StaffDutyShift extends ScheduleBrief {
  branchName: string | null;
  /** 可打上班卡起點（班次開始前 earlyMinutes 分） */
  punchInOpensAt: string;
}

export interface StaffDutyStatus {
  checkedAt: string;
  earlyMinutes: number;
  exempt: boolean;
  onDuty: boolean;
  state: StaffDutyState;
  message: string;
  shift: StaffDutyShift | null;
  nextShift: StaffDutyShift | null;
  open: { id: number; punchIn: string; branchId: number | null; scheduleId: number | null } | null;
  staleOpen: boolean;
  canPunchIn: boolean;
  canPunchOut: boolean;
  leave: { startAt: string; endAt: string } | null;
}

export interface AttendanceTally {
  records: number;
  workedMinutes: number;
  late: number;
  earlyLeave: number;
  missedPunchOut: number;
  open: number;
  unscheduled: number;
  absent: number;
  scheduled: number;
  lateMinutes: number;
  earlyMinutes: number;
  unscheduledMinutes: number;
  absentMinutes: number;
  scheduledMinutes: number;
}

export type AttendanceAbsence = ScheduleBrief & { staffId: number; staff: HrStaffRef | null; dateKey: string };

export interface AttendanceOverview {
  from: string;
  to: string;
  graceMinutes: number;
  truncated: boolean;
  summary: AttendanceTally;
  rows: AttendanceRecord[];
  absences: AttendanceAbsence[];
  byStaff: (AttendanceTally & { staffId: number; staff: HrStaffRef | null })[];
}

export interface MyAttendance {
  now: string;
  todayKey: string;
  graceMinutes: number;
  maxShiftHours: number;
  open: { id: number; punchIn: string; branchId: number | null; stale: boolean } | null;
  todayShifts: ScheduleBrief[];
  nextShift: ScheduleBrief | null;
  summary: AttendanceTally;
  recent: AttendanceRecord[];
  absences: AttendanceAbsence[];
}

export type StaffNotificationStatus = 'PENDING' | 'SENT' | 'SKIPPED' | 'FAILED';

export interface StaffNotificationItem {
  id: number;
  type: string;
  title: string;
  body: string;
  link: string | null;
  status: StaffNotificationStatus;
  createdAt: string;
  sentAt: string | null;
  readAt: string | null;
}

export interface StaffNotificationInbox {
  items: StaffNotificationItem[];
  unread: number;
}

export interface StaffLineStatus {
  bound: boolean;
  displayName: string | null;
  boundAt: string | null;
  notifyEnabled: boolean;
  loginConfigured: boolean;
  pushConfigured: boolean;
}

export interface PayrollColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

export type PayrollCell = string | number | null;

export interface PayrollTable {
  columns: PayrollColumn[];
  rows: Record<string, PayrollCell>[];
}

export interface PayrollExport {
  month: string;
  from: string;
  to: string;
  branchId: number | null;
  branchName: string | null;
  graceMinutes: number;
  generatedAt: string;
  warnings: string[];
  totals: Record<string, number>;
  summary: PayrollTable;
  detail: PayrollTable;
}

// ── 薪資系統（金額一律後端計算） ──
export type PayType = 'MONTHLY' | 'HOURLY';
export type OvertimeKind = 'WEEKDAY' | 'REST_DAY' | 'HOLIDAY' | 'REGULAR_OFF';
export type PayrollAdjustmentType = 'BONUS' | 'ALLOWANCE' | 'OTHER_EARNING' | 'INCOME_TAX' | 'OTHER_DEDUCTION';

export interface PayrollRateMeta {
  label: string;
  min: number;
  max: number;
}

export interface PayrollConfigData {
  rates: Record<string, number>;
  defaults: Record<string, number>;
  meta: Record<string, PayrollRateMeta>;
  updatedAt: string | null;
  updatedByStaffId: number | null;
}

export interface PayAllowance {
  label: string;
  amount: number;
}

export interface StaffPayProfileData {
  payType: PayType;
  monthlySalary: number | null;
  hourlyWage: number | null;
  allowances: PayAllowance[] | null;
  laborInsuredSalary: number | null;
  healthInsuredSalary: number | null;
  healthDependents: number;
  pensionWage: number | null;
  pensionSelfRate: number;
  note?: string | null;
  updatedAt?: string;
}

export interface PayProfileRow {
  staffId: number;
  account: string;
  name: string;
  role: string;
  position: string;
  branchId: number | null;
  branchName: string | null;
  employmentType: string;
  employmentLabel: string;
  weeklyHours: number | null;
  hireDate: string | null;
  laborActApplies: boolean;
  isActive: boolean;
  profile: StaffPayProfileData | null;
}

export interface PayProfileList {
  payTypes: Record<PayType, string>;
  items: PayProfileRow[];
}

export interface PayrollWarning {
  code: string;
  message: string;
  blocking?: boolean;
  staffIds?: number[];
}

export interface PayrollLine {
  kind: 'EARNING' | 'DEDUCTION' | 'EMPLOYER';
  code: string;
  label: string;
  amount: number;
}

export interface PayrollOvertime {
  key: string;
  attendanceId: number;
  date: string;
  kind: OvertimeKind;
  suggestedMinutes: number;
  approvedMinutes: number | null;
  decidedByStaffId: number | null;
  decidedAt: string | null;
}

export interface PayrollAdjustment {
  id: string;
  type: PayrollAdjustmentType;
  label: string;
  amount: number;
  note: string | null;
  byStaffId: number | null;
  at: string;
}

export interface PayrollItemFacts {
  employedDays: number;
  daysInMonth: number;
  workedMinutes: number;
  regularMinutes: number;
  scheduledShifts: number;
  lateCount: number;
  lateMinutes: number;
  earlyCount: number;
  earlyMinutes: number;
  absentShifts: number;
  absentMinutes: number;
  missedPunchOut: number;
  open: number;
  leaveHours: Record<string, number>;
  performance: (CoachPerformance & { trainerId: number }) | null;
}

export interface PayrollItemData {
  id: number;
  staffId: number;
  name: string;
  account: string;
  position: string;
  branchName: string | null;
  profile: StaffPayProfileData;
  facts: PayrollItemFacts;
  overtime: PayrollOvertime[];
  adjustments: PayrollAdjustment[];
  lines: PayrollLine[];
  grossPay: number;
  deductionTotal: number;
  netPay: number;
  employerCost: number;
  warnings: PayrollWarning[];
}

export interface PayrollRunSummary {
  id: number;
  month: string;
  status: 'DRAFT' | 'FINALIZED';
  calculatedAt: string;
  finalizedAt: string | null;
  finalizedByStaffId: number | null;
  itemCount: number;
  grossPay: number;
  deductionTotal: number;
  netPay: number;
  employerCost: number;
}

export interface PayrollRunDetail {
  run: PayrollRunSummary & {
    config: Record<string, number>;
    warnings: PayrollWarning[];
    history: { action: string; at: string; byStaffId: number | null; reason?: string }[];
  };
  items: PayrollItemData[];
  table: PayrollTable;
  meta: {
    overtimeKinds: Record<OvertimeKind, string>;
    adjustmentTypes: Record<PayrollAdjustmentType, { label: string; kind: 'EARNING' | 'DEDUCTION' }>;
    leaveTypes: Record<string, string>;
    payTypes: Record<PayType, string>;
  };
}

export interface MyPayslipSummary {
  month: string;
  finalizedAt: string;
  grossPay: number;
  deductionTotal: number;
  netPay: number;
}

export interface MyPayslipDetail {
  month: string;
  finalizedAt: string;
  payType: PayType;
  payTypeLabel: string;
  lines: PayrollLine[];
  grossPay: number;
  deductionTotal: number;
  netPay: number;
  attendance: {
    employedDays: number;
    daysInMonth: number;
    workedMinutes: number;
    scheduledShifts: number;
    lateCount: number;
    lateMinutes: number;
    earlyCount: number;
    earlyMinutes: number;
    absentShifts: number;
    absentMinutes: number;
    leaveHours: Record<string, number>;
  };
  overtime: { date: string; kind: OvertimeKind; kindLabel: string; approvedMinutes: number }[];
}

export interface StaffScheduleRow {
  id: number;
  staffId: number;
  startAt: string;
  endAt: string;
  slotType?: string;
  note?: string | null;
  staff?: { id: number; name: string; displayName?: string | null };
}

/** ROSTER＝四週排班；FREE＝週班表（教練／店長・GM・FM，核准後生效）；MANUAL＝總部臨時排班 */
export type ScheduleSource = 'ROSTER' | 'FREE' | 'MANUAL';

export interface ScheduleOverviewRow {
  id: number;
  staffId: number;
  staff: {
    id: number;
    name: string;
    displayName?: string | null;
    role: StaffRole;
    employmentType?: EmploymentType;
    rosterRoleLabel: string | null;
  } | null;
  branchId: number | null;
  dateKey: string;
  startAt: string;
  endAt: string;
  slotType: string;
  shiftCode: string | null;
  isOff: boolean;
  label: string;
  note: string | null;
  source: ScheduleSource;
  sourceLabel: string;
  rosterPeriodId: number | null;
  rosterStatus: 'DRAFT' | 'PUBLISHED' | null;
  coachPlanId?: number | null;
  coachPlanStatus?: CoachPlanStatus | null;
  coachPlanStatusLabel?: string | null;
  editable: boolean;
  deletable: boolean;
}

export interface ScheduleOverview {
  from: string;
  to: string;
  truncated: boolean;
  rows: ScheduleOverviewRow[];
}

export type CoachCourseKind = 'PRIVATE' | 'GROUP';

export interface CoachTierRate {
  minRevenue: number;
  rate: number;
}

/** 教練業績獎金規則（底薪一律於薪資設定；此處僅獎金） */
export interface CoachCommissionRule {
  id: number;
  trainerId: number | null;
  trainer: { id: number; name: string } | null;
  scope: 'DEFAULT' | 'TRAINER';
  courseKind: CoachCourseKind;
  courseKindLabel: string;
  tierRates: CoachTierRate[] | null;
  sessionBonus: number | null;
  perHeadRate: number | null;
  createdAt: string;
}

/** 後端試算之業績獎金（實發以結算薪資單為準） */
export interface CoachPerformance {
  ptSessions: number;
  ptRevenue: number;
  tierRate: number;
  ptCommission: number;
  ptSessionBonus: number;
  groupClasses: number;
  groupHeads: number;
  groupHeadBonus: number;
  groupSessionBonus: number;
  total: number;
}

export interface CoachPerformanceFlag {
  code: 'NOT_EMPLOYED' | 'NO_PAY_PROFILE' | 'COACH_BASE_PAY' | 'NO_LABOR_INS';
  message: string;
}

export interface HqCoachPerformanceItem {
  trainerId: number;
  name: string;
  level: string | null;
  staff: { id: number; name: string; employmentType: EmploymentType; isActive: boolean } | null;
  basePay: { payType: PayType; monthlySalary: number | null; hourlyWage: number | null } | null;
  performance: CoachPerformance;
  flags: CoachPerformanceFlag[];
}

export interface TrainerMyPerformance {
  month: string;
  trainerId: number;
  performance: CoachPerformance;
  rules: { PRIVATE: CoachCommissionRule | null; GROUP: CoachCommissionRule | null };
}

// ── 週班表（教練＋管理職；勞基法 §30／§35／§36／§34；檢查結果一律由後端計算） ──
export type CoachPlanStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface CoachWeekRules {
  maxDailyNormalMinutes: number;
  maxWeeklyNormalMinutes: number;
  continuousLimitMinutes: number;
  breakMinutes: number;
  minRestBetweenDaysHours: number;
  maxConsecutiveWorkDays: number;
  minSlotMinutes: number;
  maxSlotsPerDay: number;
  planAheadWeeks: number;
}

export interface CoachPlanSlot {
  date: string;
  start: string;
  end: string;
  branchId?: number | null;
}

export interface CoachPlanIssue {
  level: 'ERROR' | 'WARNING';
  code: string;
  message: string;
  date?: string;
}

export interface CoachPlanDayStat {
  date: string;
  weekday: number;
  kind: 'WORK' | 'REGULAR_OFF' | 'REST_DAY' | 'NONE';
  kindLabel: string;
  holiday: string | null;
  slots: { start: string; end: string }[];
  workMinutes: number;
  breakMinutes: number;
  leaveMinutes: number;
}

export interface CoachPlanEvaluation {
  issues: CoachPlanIssue[];
  hasError: boolean;
  stats: {
    days: CoachPlanDayStat[];
    weekWorkMinutes: number;
    leaveMinutes: number;
    agreedMinutes: number | null;
    targetMinutes: number | null;
    maxConsecutiveDays: number;
  };
}

export type WeekPlanRole = 'COACH' | 'MANAGER';

export interface CoachWeekPlan {
  id: number | null;
  staffId: number | null;
  staff: { id: number; name: string; displayName?: string | null } | null;
  staffRole?: string | null;
  planRole?: WeekPlanRole | null;
  planRoleLabel?: string | null;
  /** 審核列表：目前登入者可否審核（後端判定） */
  canReview?: boolean;
  branchId: number | null;
  weekStart: string;
  weekEnd: string;
  status: CoachPlanStatus | null;
  statusLabel: string;
  regularOffDate: string | null;
  restDayDate: string | null;
  slots: CoachPlanSlot[];
  note: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: { id: number; name: string | null } | null;
  reviewNote: string | null;
  history: { at: string; action: string; byStaffId?: number | null; reason?: string }[];
  editable: boolean;
  classes: { id: number; title: string; type: string; date: string; start: string; end: string }[];
  evaluation: CoachPlanEvaluation | null;
  holidays?: { date: string; name: string }[];
  branchName?: string | null;
  employmentType?: EmploymentType;
}

export interface MyCoachPlans {
  rules: CoachWeekRules;
  statuses: Record<CoachPlanStatus, string>;
  today: string;
  planRole: WeekPlanRole;
  planRoleLabel: string;
  approverLabel: string;
  staff: { id: number; name: string; role: string; employmentType: EmploymentType; weeklyHours: number | null };
  branches: { id: number; name: string }[];
  defaultBranchId: number | null;
  /** GM／FM 可不指定出勤分店（總部） */
  allowNoBranch: boolean;
  weeks: CoachWeekPlan[];
}

export interface CoachPlanReviewList {
  rules: CoachWeekRules;
  statuses: Record<CoachPlanStatus, string>;
  from: string;
  /** 登入者可審核之類別 */
  kinds: WeekPlanRole[];
  items: CoachWeekPlan[];
}

export interface ClassCheckInTokenResult {
  token: string;
  expiresAt: string;
}


// ── 退費／折讓（後端 lib/refundService.js；金額一律後端計算） ─────────────

export type RefundStatus =
  | 'PAYMENT_PENDING'
  | 'AWAITING_TERMINAL'
  | 'PAYMENT_FAILED'
  | 'INVOICE_PENDING'
  | 'INVOICE_FAILED'
  | 'SIGNATURE_PENDING'
  | 'GATEWAY_RETRYING'
  | 'COMPLETED'
  | 'ABORTED';

export type RefundMethod = 'CASH' | 'WALLET_CASH' | 'VOUCHER' | 'LINEPAY' | 'PAYUNI' | 'YIPAY';

export type RefundPaymentStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'AWAITING_TERMINAL'
  | 'REFUNDED'
  | 'FAILED'
  | 'FORFEITED'
  | 'REVERSED'
  | 'CANCELLED';

export type RefundScope = 'FULL' | 'ITEMS' | 'UNUSED';

export type RefundOrderKind = 'SALE' | 'TOPUP' | 'MEMBERSHIP' | 'PT' | 'GROUP' | 'COURSE_SUB' | 'OTHER';

export type RefundAction = 'TOPUP_CANCEL' | 'SUB_ORDER_REFUND' | 'GROUP_REFUND' | 'SUBSCRIPTION_CANCEL';

export interface RefundLine {
  orderItemId: number;
  name: string;
  qty: number;
  unitPrice: number;
  gross: number;
  taxType?: string;
}

export interface RefundLegPreview {
  method: RefundMethod;
  amount: number;
  forfeited: boolean;
  ready: boolean;
  needsTerminal: boolean;
}

export interface RefundInvoicePlan {
  action: 'NONE' | 'CANCEL_UNISSUED' | 'VOID' | 'ALLOWANCE';
  sharedInvoice: boolean;
  invoices: {
    id: string;
    invoiceNumber: string | null;
    status: string;
    category: string | null;
    taxType: string | null;
    periodKey: string | null;
    totalAmount: number;
    allowanceTotal: number;
    action: 'VOID' | 'ALLOWANCE' | 'CANCEL' | null;
  }[];
}

export interface RefundPreview {
  /** 後端報價鎖：送出時原樣帶回，後端重算不符回 409 QUOTE_STALE */
  quoteToken: string;
  quoteExpiresAt: string;
  kind: string;
  subOrderId: string;
  refType: 'ORDER' | 'SALE';
  orderKind: RefundOrderKind;
  checkoutSessionId: string | null;
  memberId: number | null;
  memberName: string | null;
  branchId: number | null;
  scope: RefundScope;
  lines: RefundLine[] | null;
  calc: { note?: string; [k: string]: unknown };
  grossAmount: number;
  feeAmount: number;
  consumedValue: number;
  payoutAmount: number;
  fullRefund: boolean;
  legs: RefundLegPreview[];
  invoicePlan: RefundInvoicePlan;
  signatureRequired: boolean;
  warnings: string[];
}

export interface RefundInvoiceResult {
  einvoiceId: string | null;
  invoiceNumber: string | null;
  action: 'VOID' | 'ALLOWANCE' | 'CANCEL' | 'NONE' | null;
  allowanceId?: string | null;
  allowanceNo?: string | null;
  amount?: number;
  category?: string | null;
  done: boolean;
  ambiguous?: boolean;
  /** 失敗時之實際呼叫（作廢失敗改折讓者為 ALLOWANCE） */
  op?: 'VOID' | 'ALLOWANCE' | null;
  /** 折讓結果不明時保留之預占含稅金額 */
  heldAmount?: number;
  /** 經「核對藍新結果」人工補登 */
  resolvedManually?: boolean;
  /** 重試前查得 ezPay 已作廢，只同步本地 */
  remoteAlreadyVoided?: boolean;
  error?: string;
}

/** ezPay 折讓結果不明、預占保留中：待 DUTY+ 核對藍新後台（僅回比對所需欄位） */
export interface RefundInvoiceResolve {
  einvoiceId: string;
  invoiceNumber: string;
  /** 本次折讓含稅金額 */
  amount: number;
  untaxed: number;
  tax: number;
  category: string | null;
}

export type RefundInvoiceResolveBody =
  | { einvoiceId: string; outcome: 'ISSUED'; ezPayAllowanceNo: string; reason: string }
  | { einvoiceId: string; outcome: 'NOT_ISSUED'; confirmEzPayNotIssued: true; reason: string };

export interface RefundPaymentRecord {
  id: string;
  method: RefundMethod;
  amount: number;
  status: RefundPaymentStatus;
  providerRef: string | null;
  rrn: string | null;
  authCode: string | null;
  cardLast4: string | null;
  attempts: number;
  lastError: string | null;
  refundedAt: string | null;
  /** 乙禾原刷卡憑證（僅 YIPAY 且有端末暫存時） */
  original?: {
    rrn: string | null;
    authCode: string | null;
    cardLast4: string | null;
    amount: number;
    capturedAt: string | null;
  } | null;
}

/** POST /ops/refunds/:id/retry-gateway 回傳；金額與狀態只以後端 refundOrder 為準 */
export interface RefundGatewayRetryData {
  reconciledAction: 'ALREADY_COMPLETED' | 'RETRIED_AND_COMPLETED' | 'RETRIED';
  stepSummary: {
    paymentGatewayStep: string;
    ezPayInvoiceStep: string;
  } | null;
  refundOrder: RefundRecord;
}

export interface RefundRecord {
  id: string;
  /** 同 Idempotency-Key 重送時為 true（回傳原退費單） */
  replayed?: boolean;
  kind: string;
  refType: 'ORDER' | 'SALE';
  subOrderId: string;
  checkoutSessionId: string | null;
  branchId: number | null;
  memberId: number | null;
  scope: RefundScope;
  lines: RefundLine[] | null;
  calc: { note?: string; [k: string]: unknown };
  grossAmount: number;
  feeAmount: number;
  consumedValue: number;
  payoutAmount: number;
  fullRefund: boolean;
  invoiceAction: string | null;
  invoiceResults: RefundInvoiceResult[] | null;
  /** 非 null 時重試與中止皆被後端擋下（409 INVOICE_RESULT_UNKNOWN），須經 invoice-resolve 處置 */
  invoiceResolve: RefundInvoiceResolve | null;
  signatureRequired: boolean;
  signed: boolean;
  walletCashReversed: number;
  walletBonusReversed: number;
  walletCashCredited: number;
  reason: string;
  staffId: number | null;
  status: RefundStatus;
  lastError: string | null;
  needsCheck: boolean;
  completedAt: string | null;
  abortedAt: string | null;
  abortReason: string | null;
  createdAt: string;
  payments: RefundPaymentRecord[];
}

export interface RefundLookupSubOrder {
  id: string;
  refType: 'ORDER' | 'SALE';
  kind: RefundOrderKind;
  status: string;
  amount: number;
  refundedAmount: number;
  itemDesc: string;
  checkoutSessionId: string | null;
  createdAt: string;
  actions: RefundAction[];
  invoiceNumber?: string | null;
  invoiceStatus?: string | null;
  invoices?: RefundLookupInvoice[];
  items?: {
    orderItemId: number;
    name: string;
    qty: number;
    refundedQty: number;
    unitPrice: number;
    lineTotal: number;
    taxType: string;
  }[];
}

/** 子單綁定之 ezPay 發票（後端 serializeEInvoiceBrief） */
export interface RefundLookupInvoice {
  id: string;
  leg: string;
  status: string;
  invoiceNumber: string | null;
  category: string | null;
  totalAmount: number;
  allowanceTotal: number;
  issuedAt: string | null;
  lastError: string | null;
}

export interface RefundLookupResult {
  checkoutSessionId: string | null;
  subOrders: RefundLookupSubOrder[];
  sharedInvoices: RefundLookupInvoice[];
  member: { id: number; name: string; memberNo: string | null; phone: string | null } | null;
  allowances: AllowanceListItem[];
  openRefunds: { id: string; refId: string; status: RefundStatus; payoutAmount: number; createdAt: string }[];
}

export interface AllowanceListItem {
  id: string | null;
  allowanceNo: string;
  status: string;
  invoiceNumber: string;
  orderId: string | null;
  saleOrderId: string | null;
  subOrderId: string | null;
  refundId: string | null;
  memberId: number | null;
  memberName: string | null;
  itemDesc: string | null;
  untaxedAmt: number;
  taxAmt: number;
  totalAmt: number;
  remainAmt: number | null;
  source: string;
  branchId: number | null;
  branchName: string | null;
  issuedAt: string;
  sellerName: string;
  sellerUbn: string | null;
  category: string | null;
  buyerUbn: string | null;
  buyerName: string | null;
  invoiceIssuedAt: string | null;
  reason: string | null;
  signed: boolean;
  signatureRequired: boolean;
  printCount: number;
  lastPrintedAt: string | null;
  exportedToAcctAt: string | null;
}

export interface AllowanceListPayload {
  items: AllowanceListItem[];
  columns: ReconColumn[];
  rows: Record<string, ReconCell>[];
}

export interface AllowanceExportPayload extends AllowanceListPayload {
  exported: { total: number; firstTime: number; exportedAt: string | null; truncated: boolean; marked: boolean };
}

export interface AllowancePrintPayload {
  allowance: {
    id: string;
    allowanceNo: string;
    status: string;
    issuedAt: string;
    source: string;
    refundId: string | null;
    subOrderId: string | null;
    reason: string | null;
    staffId: number | null;
  };
  seller: {
    name: string;
    ubn: string | null;
    address: string | null;
    phone: string | null;
    branchName: string | null;
    branchCode: string | null;
    branchAddress: string | null;
  };
  buyer: {
    category: string;
    ubn: string | null;
    name: string | null;
    memberName: string | null;
    memberNo: string | null;
    email: string | null;
  };
  originalInvoice: {
    invoiceNumber: string;
    track: string;
    number: string;
    issuedAt: string | null;
    periodKey: string | null;
    taxType: string;
    taxTypeLabel: string;
    totalAmount: number | null;
  };
  items: {
    lineNo: number;
    name: string;
    qty: number;
    unit: string;
    unitPrice: number;
    amount: number;
    taxAmt: number;
    grossAmount: number;
    taxType: string;
  }[];
  amounts: { untaxed: number; tax: number; total: number; remainAmt: number | null };
  signature: {
    required: boolean;
    signed: boolean;
    signatureId: string | null;
    signedAt: string | null;
    intact: boolean | null;
    dataUrl: string | null;
  };
  /** 列印次數（含本次）；isReprint＝補印 */
  print: { count: number; isReprint: boolean; lastPrintedAt: string | null };
  formats: ('A4_FOUR_PART' | 'THERMAL_80MM')[];
}
