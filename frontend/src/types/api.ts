export interface ApiResponse<T = unknown> {
  status: 'success' | 'error';
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
  /** 折讓單／發票列印營業人名稱；未設則回退環境變數 */
  invoiceSellerName?: string | null;
  /** 折讓單抬頭統編（8 碼） */
  invoiceSellerUbn?: string | null;
  isActive: boolean;
  _count?: { venues: number; promotions: number; trainers: number };
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
  branch?: { id: number; name: string; code?: string | null };
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

export interface Product {
  id: number;
  branchId: number;
  sku: string;
  name: string;
  /** PHYSICAL=實體控庫存 | SERVICE=服務類不控庫存 */
  productKind?: 'PHYSICAL' | 'SERVICE' | string;
  price: number;
  cost?: number;
  stockQty: number;
  /** 僅 PHYSICAL；null=關閉安全庫存預警 */
  safetyStock?: number | null;
  isActive?: boolean;
  branch?: { id: number; name: string; code?: string | null };
}

export interface StockMovement {
  id: number;
  productId: number;
  type: string;
  qty: number;
  unitCost?: number | null;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
  staffId?: number | null;
  createdAt: string;
  product?: { id: number; sku: string; name: string; branchId: number };
}

export interface PurchaseOrder {
  id: string;
  branchId: number;
  supplier: string | null;
  status: string;
  totalCost: number;
  createdAt: string;
  items?: {
    productId: number;
    qty: number;
    unitCost: number;
    lineCost: number;
    product?: { id: number; name: string; sku: string };
  }[];
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

export type StaffPermission = 'ops' | 'pt' | 'trainer';

export type StaffRole = 'STAFF' | 'DUTY' | 'MANAGER' | 'ADMIN';

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
  branch?: { id: number; name: string } | null;
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

export interface StaffLeaveRow {
  id: number;
  staffId: number;
  startAt: string;
  endAt: string;
  status: string;
  reason?: string | null;
  staff?: { id: number; name: string; displayName?: string | null };
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

export interface CoachCommissionRule {
  id: number;
  trainerId?: number | null;
  courseKind?: string;
  payModel?: string;
  baseSalary?: number;
  isActive?: boolean;
  trainer?: { id: number; name: string };
}

export interface CoachCommissionLedger {
  id: string;
  trainerId: number;
  periodStart: string;
  periodEnd: string;
  grossAmount: number;
  netAmount: number;
  trainer?: { id: number; name: string };
}

export interface ClassCheckInTokenResult {
  token: string;
  expiresAt: string;
}

