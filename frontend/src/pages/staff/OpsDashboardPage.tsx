import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageSection,
  Select,
} from '../../components/ui';
import { useToast } from '../../contexts/ToastContext';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import {
  bindOpsMemberDevice,
  bindOpsMemberLine,
  createOpsMember,
  fetchOpsBranches,
  fetchOpsMembers,
  fetchOpsCoursePlans,
  fetchOpsProducts,
  fetchOpsPromotions,
  fetchOpsTrainers,
  fetchMemberContracts,
  openMemberContract,
  getErrorMessage,
  fetchOpsCheckoutStatus,
  opsBindFace,
  opsCheckout,
  opsConfirmYipay,
  openPayuniCheckoutInNewTab,
  redirectToCheckOut,
  resignMemberContract,
  resetOpsMemberDevice,
  signMemberContract,
  unbindOpsMemberDevice,
  unbindOpsMemberLine,
  updateOpsMember,
} from '../../lib/api';
import BranchScopeBar from '../../components/staff/BranchScopeBar';
import MemberIdentifyPanel from '../../components/staff/MemberIdentifyPanel';
import OpsMemberAdminPanel from '../../components/staff/OpsMemberAdminPanel';
import OpsActiveCheckInsTab from '../../components/staff/OpsActiveCheckInsTab';
import OpsShiftHandoverTab from '../../components/staff/OpsShiftHandoverTab';
import OpsInvoiceFailBanner from '../../components/staff/OpsInvoiceFailBanner';
import SignaturePad from '../../components/staff/SignaturePad';
import { staffBranchLabel } from '../../lib/branchLabel';
import {
  summarizePosDisplayCart,
  type PosDisplayCartPayload,
} from '../../lib/posDisplayBus';
import { usePosDisplayHost } from '../../lib/usePosDisplayHost';
import OrdersQueryPage from './OrdersQueryPage';
import { validateInvoiceOptions } from '../../components/staff/InvoiceCarrierField';
import CompositePayFields, {
  buildCardPayPayload,
  buildPaymentsPayload,
  isPaymentsBalanced,
  DEFAULT_CARD_PAY_OPTIONS,
  type CardPayOptions,
  type PayMethodCode,
} from '../../components/staff/CompositePayFields';
import { formatPromotionOptionLabel } from '../../lib/promotionLabels';
import type {
  Branch,
  MemberContractBoardItem,
  MemberContractSignature,
  OpsMember,
  CoursePlan,
  Product,
  Promotion,
  Trainer,
} from '../../types/api';

function contractToneClass(tone?: string) {
  if (tone === 'signed') return 'contract-chip contract-chip--signed';
  if (tone === 'required' || tone === 'resign') return 'contract-chip contract-chip--required';
  return 'contract-chip contract-chip--unsigned';
}

function contractToneLabel(item: MemberContractBoardItem) {
  if (item.tone === 'signed') return '已簽';
  if (item.tone === 'resign' || item.needsResign) return '需重簽';
  if (item.tone === 'required') return '必簽未簽';
  return '未簽';
}

type MemberFormState = {
  name: string;
  phone: string;
  email: string;
  idNumber: string;
  isAlert: boolean;
  faceEnabled: boolean;
  emergencyContact: string;
  emergencyContactPhone: string;
  branchIds: number[];
};

const EMPTY_FORM: MemberFormState = {
  name: '',
  phone: '',
  email: '',
  idNumber: '',
  isAlert: false,
  faceEnabled: false,
  emergencyContact: '',
  emergencyContactPhone: '',
  branchIds: [],
};

function toDateInputValue(value?: string | null) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // 用本地日曆日，避免 toISOString（UTC）在台灣造成效期少顯示一天
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 未購方案＝分鐘計費；購案後顯示系統寫入的方案名 */
function formatPlanLabel(plan?: string | null) {
  if (!plan || plan === '計時會員' || plan === '未定') return '分鐘計費';
  return plan;
}

function formatExpireLabel(plan?: string | null, expireDate?: string | null) {
  if (!plan || plan === '計時會員' || plan === '未定' || !expireDate) return '無效期';
  return toDateInputValue(expireDate);
}

function isMinuteBilling(plan?: string | null) {
  return !plan || plan === '計時會員' || plan === '未定';
}

function isUnlimitedMember(plan?: string | null) {
  return plan === '無限會員' || plan === '月費會員';
}

type OpsTab = 'checkout' | 'members' | 'checkins' | 'orders' | 'shift';

type CartProductLine = {
  kind: 'PRODUCT';
  productId: number;
  qty: number;
  name: string;
  price: number;
};

type CartPromoLine = {
  kind: 'PROMO';
  promotionId: number;
  qty: number;
  name: string;
  price: number;
  usageType?: string;
  enableCardRecurring?: boolean;
  recurringAmount?: number | null;
  periodCount?: number | null;
  unitDays?: number | null;
  durationDays?: number | null;
  requiresMemberContract?: boolean;
};

type CartCourseLine = {
  kind: 'COURSE';
  coursePlanId: number;
  qty: number;
  name: string;
  price: number;
  sessions: number;
  branchName?: string;
  /** 方案有開放時可勾選；不計入應付 */
  secondPersonOnSite?: boolean;
  /** 方案加贈禮；入車金額 $0 */
  giftLabel?: string | null;
  giftQty?: number | null;
  enableCardRecurring?: boolean;
  /** bitmask：2／4／6 */
  recurringPeriods?: number | null;
  recurringAmount?: number | null;
  recurringAmount4?: number | null;
  recurringAmountFinal?: number | null;
};

type CartLine = CartProductLine | CartPromoLine | CartCourseLine;

function buildOpsPosDisplayCart(
  cart: CartLine[],
  promotions: Promotion[],
  opts: { payableTotal: number; memberName?: string | null },
): PosDisplayCartPayload {
  const lines = cart.map((c) => {
    let lineTotal: number;
    let bonusSc = 0;
    let qty = c.qty;
    if (c.kind === 'PROMO') {
      const unlimited = c.usageType === 'UNLIMITED';
      lineTotal = unlimited ? c.price : c.price * c.qty;
      qty = unlimited ? 1 : c.qty;
      const p = promotions.find((x) => x.id === c.promotionId);
      bonusSc = (p?.bonusGiven || 0) * (unlimited ? 1 : c.qty);
    } else {
      lineTotal = c.price * c.qty;
    }
    return {
      kind: c.kind,
      name: c.name,
      qty,
      unitPrice: c.price,
      lineTotal,
      ...(bonusSc > 0 ? { bonusSc } : {}),
    };
  });
  const summary = summarizePosDisplayCart({
    lines,
    payableTotal: opts.payableTotal,
    memberName: opts.memberName || undefined,
  });
  return {
    ...summary,
    currency: 'TWD',
    memberName: opts.memberName || undefined,
  };
}

const OPS_TABS: { key: OpsTab; label: string }[] = [
  { key: 'checkout', label: '臨櫃結帳' },
  { key: 'members', label: '會員管理' },
  { key: 'checkins', label: '進場會員' },
  { key: 'orders', label: '訂單查詢' },
  { key: 'shift', label: '交接班結算' },
];

export default function OpsDashboardPage() {
  const { toast } = useToast();
  const { staff, isAdmin } = useStaffAuth();
  const posDisplay = usePosDisplayHost();
  const branchLocked = !isAdmin && Boolean(staff?.branchId);
  const [tab, setTab] = useState<OpsTab>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('pay') === 'done') return 'checkout';
    const t = params.get('tab');
    if (t === 'members' || t === 'checkins' || t === 'orders' || t === 'shift' || t === 'checkout') {
      return t;
    }
    return 'checkout';
  });
  const deepLinkMemberId = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get('memberId');
    const n = raw ? Number(raw) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  }, []);
  const deepLinkConsumed = useRef(false);
  const [members, setMembers] = useState<OpsMember[]>([]);
  const [membersTotal, setMembersTotal] = useState(0);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersLoadingMore, setMembersLoadingMore] = useState(false);
  const membersFetchGen = useRef(0);
  const MEMBERS_PAGE_SIZE = 50;
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [posProducts, setPosProducts] = useState<Product[]>([]);
  const [posBranchId, setPosBranchId] = useState<number | ''>('');
  /** 全櫃檯共用：電話／QR／人臉選中的會員 */
  const [selectedMember, setSelectedMember] = useState<OpsMember | null>(null);
  const [paySelected, setPaySelected] = useState<PayMethodCode[]>(['CASH']);
  const [payAmounts, setPayAmounts] = useState<Partial<Record<PayMethodCode, number>>>({
    CASH: 0,
  });
  const [cardOptions, setCardOptions] = useState<CardPayOptions>(DEFAULT_CARD_PAY_OPTIONS);
  const [voucherCode, setVoucherCode] = useState('');
  const [linePayOneTimeKey, setLinePayOneTimeKey] = useState('');
  const [carrier, setCarrier] = useState('');
  const [buyerUbn, setBuyerUbn] = useState('');
  const [loveCode, setLoveCode] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [addQtyByProduct, setAddQtyByProduct] = useState<Record<number, number>>({});
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  /** 續期收款無 ReturnURL：另開分頁後在此輪詢 Notify 入帳 */
  const [pendingPeriodPay, setPendingPeriodPay] = useState<{
    ref: string;
    label: string;
    /** 乙禾已入帳後的 PayUNi 僅約定：等 hasCreditHash，而非 PAID */
    bindOnly?: boolean;
  } | null>(null);
  const [pendingPeriodStatus, setPendingPeriodStatus] = useState<string>('PENDING');
  const [pendingPeriodChecking, setPendingPeriodChecking] = useState(false);
  /** 乙禾現場刷卡：PENDING 後待櫃檯確認端末成功 */
  const [pendingYipay, setPendingYipay] = useState<{
    checkoutId: string;
    amount: number;
    hint?: string;
    needsPeriodBind?: boolean;
    recurringAmount?: number | null;
    periodTimes?: number | null;
  } | null>(null);
  const [yipayTerminalRef, setYipayTerminalRef] = useState('');
  const [yipayConfirmBusy, setYipayConfirmBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [promotionId, setPromotionId] = useState<number | ''>('');
  const [topupQty, setTopupQty] = useState(1);
  const [coursePlans, setCoursePlans] = useState<CoursePlan[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [coursePlanId, setCoursePlanId] = useState<number | ''>('');
  const [courseQty, setCourseQty] = useState(1);
  const [courseSecondPerson, setCourseSecondPerson] = useState(false);
  const [trainerId, setTrainerId] = useState<number | ''>('');
  const [faceMemberId, setFaceMemberId] = useState<number | null>(null);
  const [faceMemberName, setFaceMemberName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<OpsMember | null>(null);
  const [form, setForm] = useState<MemberFormState>(EMPTY_FORM);
  const [manualLineId, setManualLineId] = useState('');
  const [manualDeviceId, setManualDeviceId] = useState('');
  const [saving, setSaving] = useState(false);
  const [binding, setBinding] = useState(false);
  const [memberContractBoard, setMemberContractBoard] = useState<MemberContractBoardItem[]>([]);
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const [signBusy, setSignBusy] = useState(false);
  const [signMember, setSignMember] = useState<OpsMember | null>(null);
  const [signDetail, setSignDetail] = useState<MemberContractSignature | null>(null);
  const [signHistory, setSignHistory] = useState<MemberContractSignature[]>([]);
  /** 歷程預覽：null 表示顯示目前可簽署／重簽的那一筆（signDetail） */
  const [historyPreviewId, setHistoryPreviewId] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const checkoutInFlight = useRef(false);
  const pendingPeriodSettled = useRef(false);


  // 閘機／Cmd+K 續約深連結：?tab=checkout&memberId=
  useEffect(() => {
    if (!deepLinkMemberId || deepLinkConsumed.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchOpsMembers({ id: deepLinkMemberId, take: 1 });
        if (cancelled || deepLinkConsumed.current) return;
        deepLinkConsumed.current = true;
        const found = res.status === 'success' ? res.data?.items?.[0] : undefined;
        if (found) {
          setSelectedMember(found);
          setTab('checkout');
          toast(`已帶入會員 ${found.name}，可直接辦理續約／儲值`, 'info');
        } else {
          toast(`找不到會員 #${deepLinkMemberId}`, 'error');
        }
        const url = new URL(window.location.href);
        url.searchParams.delete('memberId');
        window.history.replaceState({}, '', `${url.pathname}${url.search}`);
      } catch (err) {
        if (!cancelled && !deepLinkConsumed.current) {
          deepLinkConsumed.current = true;
          toast(getErrorMessage(err, `找不到會員 #${deepLinkMemberId}`), 'error');
          const url = new URL(window.location.href);
          url.searchParams.delete('memberId');
          window.history.replaceState({}, '', `${url.pathname}${url.search}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deepLinkMemberId, toast]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const syncMemberSelections = useCallback((items: OpsMember[]) => {
    setSelectedMember((prev) => {
      if (!prev) return prev;
      return items.find((m) => m.id === prev.id) || prev;
    });
    setEditingMember((prev) => {
      if (!prev) return prev;
      return items.find((m) => m.id === prev.id) || prev;
    });
  }, []);

  const patchMember = useCallback((updated: OpsMember) => {
    setMembers((prev) => {
      const idx = prev.findIndex((m) => m.id === updated.id);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...prev[idx], ...updated };
      return next;
    });
    setSelectedMember((prev) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
    setEditingMember((prev) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
  }, []);

  const loadMembers = useCallback(
    async (opts?: { append?: boolean; skip?: number }) => {
      const append = Boolean(opts?.append);
      const skip = opts?.skip ?? 0;
      const gen = append ? membersFetchGen.current : ++membersFetchGen.current;
      if (append) setMembersLoadingMore(true);
      else setMembersLoading(true);
      try {
        const res = await fetchOpsMembers({
          q: debouncedSearch || undefined,
          take: MEMBERS_PAGE_SIZE,
          skip,
        });
        if (!append && gen !== membersFetchGen.current) return;
        if (res.status === 'success' && res.data) {
          const { items, total } = res.data;
          setMembers((prev) => (append ? [...prev, ...items] : items));
          setMembersTotal(total);
          if (!append) syncMemberSelections(items);
        }
      } catch (err) {
        if (!append && gen !== membersFetchGen.current) return;
        toast(getErrorMessage(err, '載入會員失敗'), 'error');
      } finally {
        if (append) setMembersLoadingMore(false);
        else if (gen === membersFetchGen.current) setMembersLoading(false);
      }
    },
    [debouncedSearch, syncMemberSelections, toast],
  );

  const loadCatalog = useCallback(async () => {
    try {
      const [promosRes, branchesRes, trainersRes] = await Promise.all([
        fetchOpsPromotions(),
        fetchOpsBranches(),
        fetchOpsTrainers(),
      ]);
      if (promosRes.status === 'success' && promosRes.data) {
        setPromotions(promosRes.data);
        if (promosRes.data[0]) setPromotionId(promosRes.data[0].id);
      }
      if (branchesRes.status === 'success' && branchesRes.data) {
        setBranches(branchesRes.data);
        if (branchLocked && staff?.branchId) {
          setPosBranchId(staff.branchId);
        } else if (branchesRes.data[0] && !posBranchId) {
          setPosBranchId(branchesRes.data[0].id);
        }
      }
      if (trainersRes.status === 'success' && trainersRes.data) {
        setTrainers(trainersRes.data);
        setTrainerId((prev) => prev || trainersRes.data?.[0]?.id || '');
      }
    } catch (err) {
      toast(getErrorMessage(err, '載入資料失敗'), 'error');
    }
  }, [toast, posBranchId, branchLocked, staff]);

  const loadData = useCallback(async () => {
    await Promise.all([loadMembers({ skip: 0 }), loadCatalog()]);
  }, [loadMembers, loadCatalog]);

  useEffect(() => {
    void loadCatalog();
    // 僅初次掛載目錄；會員列表由 debouncedSearch effect 載入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadMembers({ skip: 0 });
  }, [loadMembers]);

  useEffect(() => {
    if (!posBranchId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [prodRes, courseRes] = await Promise.all([
          fetchOpsProducts(Number(posBranchId)),
          fetchOpsCoursePlans(Number(posBranchId)),
        ]);
        if (cancelled) return;
        if (prodRes.status === 'success' && prodRes.data) setPosProducts(prodRes.data);
        if (courseRes.status === 'success' && courseRes.data) {
          setCoursePlans(courseRes.data);
          setCoursePlanId((prev) => prev || courseRes.data?.[0]?.id || '');
        }
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入可售商品／課程失敗'), 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [posBranchId, toast]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('pay') !== 'done') return;
    const saleId = params.get('saleId');
    const orderId = params.get('orderId');
    const checkoutId = params.get('checkoutId');
    if (!saleId && !orderId && !checkoutId) return;

    window.history.replaceState({}, '', '/staff/ops');
    queueMicrotask(() => {
      if (checkoutId) {
        toast(`刷卡回流：合併結帳 ${checkoutId}（入帳與發票以 Webhook 為準）`, 'success');
      } else if (saleId) {
        toast(`刷卡回流：銷貨單 ${saleId}（入帳以 Webhook 為準）`, 'success');
      } else if (orderId) {
        toast(`刷卡回流：購案訂單 ${orderId}（入帳與發票以 Webhook 為準）`, 'success');
      }
    });

    let cancelled = false;
    void (async () => {
      try {
        await loadData();
        if (cancelled || !posBranchId) return;
        const res = await fetchOpsProducts(Number(posBranchId));
        if (!cancelled && res.status === 'success' && res.data) setPosProducts(res.data);
      } catch {
        /* loadData 已 toast */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 僅處理一次刷卡回流
  }, []);

  async function finalizeAfterPeriodPaid(
    ref: string,
    invoiceNumber?: string | null,
    opts?: { bindOnly?: boolean },
  ) {
    toast(
      opts?.bindOnly
        ? `定期定額約定完成 · ${ref}${invoiceNumber ? ` · 發票 ${invoiceNumber}` : ''}`
        : `續期收款入帳完成 · ${ref}${invoiceNumber ? ` · 發票 ${invoiceNumber}` : ''}`,
      'success',
    );
    setPendingPeriodPay(null);
    setPendingPeriodStatus(opts?.bindOnly ? 'BOUND' : 'PAID');
    clearCart();
    setTopupQty(1);
    resetSharedCheckoutPay();
    void loadMembers({ skip: 0 });
    if (posBranchId) {
      try {
        const prodRes = await fetchOpsProducts(Number(posBranchId));
        if (prodRes.status === 'success' && prodRes.data) setPosProducts(prodRes.data);
      } catch {
        /* ignore */
      }
    }
  }

  const pollPendingPeriodPay = useCallback(
    async (opts?: { manual?: boolean }) => {
      if (!pendingPeriodPay?.ref || pendingPeriodSettled.current) return;
      if (opts?.manual) setPendingPeriodChecking(true);
      try {
        const res = await fetchOpsCheckoutStatus(pendingPeriodPay.ref);
        if (res.status !== 'success' || !res.data) return;
        const st = String(res.data.payStatus || '').toUpperCase();
        const bindOnly = Boolean(pendingPeriodPay.bindOnly);
        const done = bindOnly
          ? Boolean(res.data.hasCreditHash)
          : st === 'PAID';
        setPendingPeriodStatus(
          done ? (bindOnly ? 'BOUND' : 'PAID') : bindOnly ? 'WAITING_BIND' : st || 'PENDING',
        );
        if (done && !pendingPeriodSettled.current) {
          pendingPeriodSettled.current = true;
          await finalizeAfterPeriodPaid(
            pendingPeriodPay.ref,
            res.data.invoiceNumber || null,
            { bindOnly },
          );
        } else if (opts?.manual && !done) {
          toast(
            bindOnly
              ? '尚未收到 PayUNi 約定回報，請於續期頁完成卡號輸入後稍候再試（約定成功後會自動關閉）'
              : '尚未收到金流 Notify 入帳，請稍候再試（或確認 ngrok／NotifyURL）',
            'info',
          );
        }
      } catch (err) {
        if (opts?.manual) toast(getErrorMessage(err, '查詢付款狀態失敗'), 'error');
      } finally {
        if (opts?.manual) setPendingPeriodChecking(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll keyed by pending ref + mode
    [pendingPeriodPay?.ref, pendingPeriodPay?.bindOnly],
  );

  useEffect(() => {
    if (!pendingPeriodPay?.ref) return;
    pendingPeriodSettled.current = false;
    setPendingPeriodStatus('PENDING');
    void pollPendingPeriodPay();
    const timer = window.setInterval(() => {
      void pollPendingPeriodPay();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [pendingPeriodPay?.ref, pollPendingPeriodPay]);

  async function loadMemberContracts(memberId: number) {
    try {
      const res = await fetchMemberContracts(memberId);
      if (res.status === 'success' && res.data) {
        setMemberContractBoard(res.data.board || []);
      }
    } catch (err) {
      toast(getErrorMessage(err, '載入會員合約失敗'), 'error');
    }
  }

  function openCreateModal() {
    const defaultBranch =
      branchLocked && staff?.branchId
        ? [staff.branchId]
        : posBranchId
          ? [Number(posBranchId)]
          : [];
    setForm({ ...EMPTY_FORM, branchIds: defaultBranch });
    setCreateOpen(true);
  }

  function openEditModal(member: OpsMember) {
    setSelectedMember(member);
    setEditingMember(member);
    const bound =
      member.branchIds?.length
        ? member.branchIds
        : (member.branches || []).map((b) => b.branchId).filter(Boolean);
    setForm({
      name: member.name,
      phone: member.phone,
      email: member.email || '',
      idNumber: member.idNumber || '',
      isAlert: Boolean(member.isAlert),
      faceEnabled: Boolean(member.faceEnabled),
      emergencyContact: member.emergencyContact || '',
      emergencyContactPhone: member.emergencyContactPhone || '',
      branchIds: bound,
    });
    setManualLineId('');
    setManualDeviceId('');
    setSignatureData(null);
    setMemberContractBoard(member.contracts || []);
    void loadMemberContracts(member.id);
  }

  function closeMemberModals() {
    setCreateOpen(false);
    setEditingMember(null);
    setForm(EMPTY_FORM);
    setManualLineId('');
    setManualDeviceId('');
    setSaving(false);
    setBinding(false);
    setMemberContractBoard([]);
    setSignatureData(null);
  }

  function closeSignModal() {
    setSignMember(null);
    setSignDetail(null);
    setSignHistory([]);
    setHistoryPreviewId(null);
    setSignatureData(null);
    setSignBusy(false);
  }

  async function openContractFromList(member: OpsMember, item: MemberContractBoardItem) {
    setSignMember(member);
    setSignatureData(null);
    setSignDetail(null);
    setSignHistory([]);
    setHistoryPreviewId(null);
    try {
      const res = await openMemberContract(member.id, item.contractId);
      if (res.status === 'success' && res.data?.signature) {
        setSignDetail(res.data.signature);
        setSignHistory(res.data.history || []);
        setHistoryPreviewId(null);
      } else {
        toast(res.message || '無法開啟合約', 'error');
        closeSignModal();
      }
    } catch (err) {
      toast(getErrorMessage(err, '開啟合約失敗'), 'error');
      closeSignModal();
    }
  }

  async function handleResignContract() {
    if (!signMember || !signDetail || signDetail.status !== 'SIGNED') return;
    setSignBusy(true);
    try {
      const res = await resignMemberContract(signMember.id, signDetail.id);
      toast(res.message || '已改為待重簽', 'success');
      if (res.data?.signature) {
        setSignDetail(res.data.signature);
        setSignHistory(res.data.history || []);
        setHistoryPreviewId(null);
        setSignatureData(null);
      }
      void loadMembers({ skip: 0 });
      if (editingMember?.id === signMember.id) await loadMemberContracts(signMember.id);
    } catch (err) {
      toast(getErrorMessage(err, '合約重簽失敗'), 'error');
    } finally {
      setSignBusy(false);
    }
  }

  async function handleSignContract(memberId: number, signId: number) {
    if (!signatureData) {
      toast('請先完成電子簽名', 'error');
      return;
    }
    setSignBusy(true);
    try {
      const res = await signMemberContract(memberId, signId, signatureData);
      toast(res.message || '合約已簽署存檔', 'success');
      setSignatureData(null);
      if (res.data?.signature) {
        setSignDetail(res.data.signature);
        setSignHistory(res.data.history || []);
        setHistoryPreviewId(null);
      } else {
        closeSignModal();
      }
      if (editingMember?.id === memberId) await loadMemberContracts(memberId);
      void loadMembers({ skip: 0 });
    } catch (err) {
      toast(getErrorMessage(err, '簽署失敗'), 'error');
    } finally {
      setSignBusy(false);
    }
  }

  async function handleCreateMember() {
    if (!form.name.trim() || !form.phone.trim() || !form.idNumber.trim()) {
      toast('姓名、手機號碼與證件號為必填', 'error');
      return;
    }
    if (form.branchIds.length === 0) {
      toast('請至少綁定一間分店', 'error');
      return;
    }
    setSaving(true);
    const wantFace = form.faceEnabled;
    try {
      const result = await createOpsMember({
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim() || undefined,
        idNumber: form.idNumber.trim(),
        branchIds: form.branchIds,
        faceEnabled: wantFace,
      });
      toast(result.message || '開卡成功', 'success');
      const created = result.data;
      closeMemberModals();
      if (created?.id) {
        setMembers((prev) => [created, ...prev.filter((m) => m.id !== created.id)]);
        setMembersTotal((t) => t + 1);
        setSelectedMember(created);
      } else {
        void loadMembers({ skip: 0 });
      }
      if (wantFace && created?.id) {
        try {
          const contractsRes = await fetchMemberContracts(created.id);
          const board = contractsRes.data?.board || [];
          const bio = board.find(
            (c) =>
              c.purpose === 'BIOMETRICS_CONSENT' ||
              /生物辨識/.test(`${c.title || ''}${c.shortName || ''}${c.displayName || ''}`),
          );
          if (bio) {
            await openContractFromList(created, bio);
          } else {
            openEditModal(created);
          }
        } catch {
          openEditModal(created);
        }
      }
    } catch (err) {
      toast(getErrorMessage(err, '開卡失敗'), 'error');
      setSaving(false);
    }
  }

  async function handleUpdateMember() {
    if (!editingMember) return;
    if (!form.name.trim() || !form.phone.trim() || !form.idNumber.trim()) {
      toast('姓名、手機號碼與證件號為必填', 'error');
      return;
    }
    if (form.branchIds.length === 0) {
      toast('請至少綁定一間分店', 'error');
      return;
    }
    setSaving(true);
    try {
      const result = await updateOpsMember(editingMember.id, {
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim() || null,
        idNumber: form.idNumber.trim(),
        // 櫃檯只能「標示」警示；解除須走總部合規補償。勿傳 false（後端會拒）
        ...(form.isAlert ? { isAlert: true } : {}),
        faceEnabled: form.faceEnabled,
        emergencyContact: form.emergencyContact.trim() || null,
        emergencyContactPhone: form.emergencyContactPhone.trim() || null,
        branchIds: form.branchIds,
      });
      toast(result.message || '會員資料已更新', 'success');
      if (result.data) patchMember(result.data);
      else void loadMembers({ skip: 0 });
      closeMemberModals();
    } catch (err) {
      toast(getErrorMessage(err, '更新失敗'), 'error');
      setSaving(false);
    }
  }

  async function handleBindLine() {
    if (!editingMember || !manualLineId.trim()) {
      toast('請輸入 LINE ID', 'error');
      return;
    }
    setBinding(true);
    try {
      const result = await bindOpsMemberLine(editingMember.id, manualLineId.trim());
      toast(result.message || 'LINE 已綁定', 'success');
      setManualLineId('');
      if (result.data) {
        setEditingMember(result.data);
        patchMember(result.data);
      } else {
        void loadMembers({ skip: 0 });
      }
    } catch (err) {
      toast(getErrorMessage(err, '綁定 LINE 失敗'), 'error');
    } finally {
      setBinding(false);
    }
  }

  async function handleUnbindLine() {
    if (!editingMember) return;
    if (!window.confirm('確定解除此會員的 LINE 綁定？')) return;
    setBinding(true);
    try {
      const result = await unbindOpsMemberLine(editingMember.id);
      toast(result.message || '已解除 LINE', 'success');
      if (result.data) {
        setEditingMember(result.data);
        patchMember(result.data);
      } else {
        void loadMembers({ skip: 0 });
      }
    } catch (err) {
      toast(getErrorMessage(err, '解除 LINE 失敗'), 'error');
    } finally {
      setBinding(false);
    }
  }

  async function handleBindDevice() {
    if (!editingMember || !manualDeviceId.trim()) {
      toast('請輸入裝置 ID', 'error');
      return;
    }
    setBinding(true);
    try {
      const result = await bindOpsMemberDevice(editingMember.id, manualDeviceId.trim());
      toast(result.message || '裝置已綁定', 'success');
      setManualDeviceId('');
      if (result.data) {
        setEditingMember(result.data);
        patchMember(result.data);
      } else {
        void loadMembers({ skip: 0 });
      }
    } catch (err) {
      toast(getErrorMessage(err, '綁定裝置失敗'), 'error');
    } finally {
      setBinding(false);
    }
  }

  async function handleUnbindDevice() {
    if (!editingMember) return;
    if (!window.confirm(`確定解除會員 [${editingMember.name}] 的裝置綁定？`)) return;
    setBinding(true);
    try {
      const result = await unbindOpsMemberDevice(editingMember.id);
      toast(result.message || '已解除裝置', 'success');
      if (result.data) {
        setEditingMember(result.data);
        patchMember(result.data);
      } else {
        void loadMembers({ skip: 0 });
      }
    } catch (err) {
      toast(getErrorMessage(err, '解除裝置失敗'), 'error');
    } finally {
      setBinding(false);
    }
  }

  async function handleResetDevice() {
    if (!editingMember) return;
    if (
      !window.confirm(
        `臨櫃核身重置：解除會員 [${editingMember.name}] 裝置綁定，並使舊機登入立即失效？`,
      )
    ) {
      return;
    }
    setBinding(true);
    try {
      const result = await resetOpsMemberDevice(editingMember.id);
      toast(result.message || '已重置裝置', 'success');
      if (result.data) {
        setEditingMember(result.data);
        patchMember(result.data);
      } else {
        void loadMembers({ skip: 0 });
      }
    } catch (err) {
      toast(getErrorMessage(err, '重置裝置失敗'), 'error');
    } finally {
      setBinding(false);
    }
  }

  const branchPromotions = useMemo(
    () =>
      posBranchId === ''
        ? promotions
        : promotions.filter((p) => p.branchId === posBranchId),
    [promotions, posBranchId],
  );

  const selectedPromotion = useMemo(() => {
    if (promotionId !== '' && branchPromotions.some((p) => p.id === promotionId)) {
      return branchPromotions.find((p) => p.id === promotionId) || null;
    }
    return branchPromotions[0] || null;
  }, [branchPromotions, promotionId]);

  const selectedCoursePlan = useMemo(
    () => coursePlans.find((p) => p.id === coursePlanId),
    [coursePlans, coursePlanId],
  );

  const cartProductLines = useMemo(
    () => cart.filter((c): c is CartProductLine => c.kind === 'PRODUCT'),
    [cart],
  );
  const cartPromoLine = useMemo(
    () => cart.find((c): c is CartPromoLine => c.kind === 'PROMO') || null,
    [cart],
  );
  const cartCourseLines = useMemo(
    () => cart.filter((c): c is CartCourseLine => c.kind === 'COURSE'),
    [cart],
  );

  const cartTotal = useMemo(
    () =>
      cart.reduce((sum, c) => {
        if (c.kind === 'PROMO' && c.usageType === 'UNLIMITED') return sum + c.price;
        return sum + c.price * c.qty;
      }, 0),
    [cart],
  );

  const allowCardRecurring =
    Boolean(cartPromoLine?.enableCardRecurring) ||
    cartCourseLines.some((c) => c.enableCardRecurring);
  const recurringCourseLine = cartCourseLines.find((c) => c.enableCardRecurring);

  function decodeCourseRecurringMask(raw: number | null | undefined) {
    const n = Number(raw) || 0;
    return { allow2: (n & 2) !== 0, allow4: (n & 4) !== 0 };
  }

  const courseAllowedPeriodTimes = (() => {
    if (!recurringCourseLine || cartPromoLine?.enableCardRecurring) return undefined;
    const { allow2, allow4 } = decodeCourseRecurringMask(recurringCourseLine.recurringPeriods);
    const opts: number[] = [];
    if (allow2) opts.push(2);
    if (allow4) opts.push(4);
    return opts.length > 0 ? opts : undefined;
  })();

  const courseDefaultPeriodTimes =
    courseAllowedPeriodTimes && courseAllowedPeriodTimes.length === 1
      ? courseAllowedPeriodTimes[0]
      : courseAllowedPeriodTimes?.[0];

  const resolveCourseRecurringAmount = (periodTimes: number | null | undefined) => {
    if (!recurringCourseLine) return undefined;
    const { allow2, allow4 } = decodeCourseRecurringMask(recurringCourseLine.recurringPeriods);
    const pt = periodTimes ?? courseDefaultPeriodTimes;
    if (pt === 2 && allow2 && recurringCourseLine.recurringAmount != null) {
      return recurringCourseLine.recurringAmount;
    }
    if (pt === 4 && allow4) {
      const base =
        recurringCourseLine.recurringAmount4 != null
          ? recurringCourseLine.recurringAmount4
          : !allow2 && recurringCourseLine.recurringAmount != null
            ? recurringCourseLine.recurringAmount
            : null;
      return base ?? undefined;
    }
    if (allow2 && recurringCourseLine.recurringAmount != null) {
      return recurringCourseLine.recurringAmount;
    }
    if (allow4) {
      return (
        recurringCourseLine.recurringAmount4 ??
        recurringCourseLine.recurringAmount ??
        undefined
      );
    }
    return undefined;
  };

  /** 課程定期定額：首期應付＝第1期金額（2期＝price−第2期；4期＝第1~3期共用） */
  const resolveCourseFirstPeriodAmount = (periodTimes: number | null | undefined) => {
    if (!recurringCourseLine) return undefined;
    const { allow2, allow4 } = decodeCourseRecurringMask(recurringCourseLine.recurringPeriods);
    const pt = periodTimes ?? courseDefaultPeriodTimes;
    if (pt === 2 && allow2 && recurringCourseLine.recurringAmount != null) {
      return Math.round((recurringCourseLine.price - recurringCourseLine.recurringAmount) * 100) / 100;
    }
    if (pt === 4 && allow4) {
      const base =
        recurringCourseLine.recurringAmount4 != null
          ? recurringCourseLine.recurringAmount4
          : !allow2 && recurringCourseLine.recurringAmount != null
            ? recurringCourseLine.recurringAmount
            : null;
      return base ?? undefined;
    }
    return undefined;
  };

  const defaultRecurringAmount = cartPromoLine?.enableCardRecurring
    ? (cartPromoLine.recurringAmount != null && cartPromoLine.recurringAmount > 0
        ? cartPromoLine.recurringAmount
        : cartPromoLine.price)
    : resolveCourseRecurringAmount(cardOptions.periodTimes) ??
      (recurringCourseLine
        ? cartCourseLines.reduce(
            (s, c) => s + (c.enableCardRecurring ? c.price * c.qty : 0),
            0,
          )
        : undefined);

  const promoAllowedPeriodTimes =
    cartPromoLine?.enableCardRecurring &&
    cartPromoLine.periodCount != null &&
    cartPromoLine.periodCount > 0
      ? [cartPromoLine.periodCount]
      : undefined;

  /** 月卡／課程定期定額臨櫃：乙禾首期＋PayUNi 約定 */
  const yipayPayuniRecurring = allowCardRecurring;

  /** 選定期定額時，課程首期只收第1期；其餘列維持原價 */
  const payableTotal = useMemo(() => {
    if (
      cardOptions.cardMode !== 'RECURRING' ||
      !recurringCourseLine ||
      cartPromoLine?.enableCardRecurring
    ) {
      return cartTotal;
    }
    const first = resolveCourseFirstPeriodAmount(cardOptions.periodTimes);
    if (first == null || !(first > 0)) return cartTotal;
    const withoutRecurringCourse = cart.reduce((sum, c) => {
      if (c.kind === 'COURSE' && c.coursePlanId === recurringCourseLine.coursePlanId) {
        return sum;
      }
      if (c.kind === 'PROMO' && c.usageType === 'UNLIMITED') return sum + c.price;
      return sum + c.price * c.qty;
    }, 0);
    return Math.round((withoutRecurringCourse + first * recurringCourseLine.qty) * 100) / 100;
  }, [cart, cartTotal, cardOptions.cardMode, cardOptions.periodTimes, recurringCourseLine, cartPromoLine]);

  /** 選定期定額時自動帶入乙禾＋PayUNi 標記與期付選項 */
  useEffect(() => {
    if (!yipayPayuniRecurring) return;
    const periodAmt =
      cartPromoLine?.enableCardRecurring
        ? cartPromoLine.recurringAmount != null && cartPromoLine.recurringAmount > 0
          ? cartPromoLine.recurringAmount
          : cartPromoLine.price
        : resolveCourseRecurringAmount(cardOptions.periodTimes) ?? defaultRecurringAmount;
    const times =
      cartPromoLine?.periodCount ??
      courseDefaultPeriodTimes ??
      cardOptions.periodTimes ??
      12;
    setCardOptions((prev) => ({
      ...prev,
      cardMode: 'RECURRING',
      periodType: 'M',
      periodTimes: times,
      recurringAmount: periodAmt != null && periodAmt > 0 ? periodAmt : prev.recurringAmount,
    }));
    setPaySelected((prev) => {
      const next = new Set(prev.filter((m) => m !== 'LINEPAY'));
      next.add('YIPAY');
      next.add('CARD');
      next.delete('CASH');
      return Array.from(next);
    });
    setPayAmounts((prev) => ({
      ...prev,
      YIPAY: payableTotal,
      CARD: 0,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yipayPayuniRecurring, cartPromoLine?.promotionId, recurringCourseLine?.coursePlanId, payableTotal]);

  // 客顯鏡像購物車（CONSENT 進行中不覆寫）
  useEffect(() => {
    if (tab !== 'checkout') return;
    if (posDisplay.pendingConsentId) return;
    if (!cart.length) {
      posDisplay.postIdle();
      return;
    }
    posDisplay.postCart(
      buildOpsPosDisplayCart(cart, promotions, {
        payableTotal,
        memberName: selectedMember?.name,
      }),
    );
  }, [
    tab,
    cart,
    promotions,
    payableTotal,
    selectedMember?.name,
    posDisplay.pendingConsentId,
    posDisplay.postCart,
    posDisplay.postIdle,
  ]);

  // 契約：客顯 SIGNATURE_COMPLETED → 填入本機 SignaturePad 狀態
  useEffect(() => {
    const sig = posDisplay.lastSignature;
    if (!sig || sig.purpose !== 'CONTRACT') return;
    if (!signDetail || signDetail.status === 'SIGNED') return;
    setSignatureData(sig.signatureDataUrl);
    toast('客顯契約簽名已回傳，請確認後存檔', 'success');
    posDisplay.clearSignature();
  }, [posDisplay.lastSignature, signDetail, toast, posDisplay.clearSignature]);

  function resetSharedCheckoutPay() {
    setCarrier('');
    setBuyerUbn('');
    setLoveCode('');
    setVoucherCode('');
    setLinePayOneTimeKey('');
    setPaySelected(['CASH']);
    setPayAmounts({ CASH: 0 });
    setCardOptions(DEFAULT_CARD_PAY_OPTIONS);
  }

  function getAddQty(product: Product) {
    const qty = addQtyByProduct[product.id];
    return qty === undefined ? 1 : qty;
  }

  function setAddQty(productId: number, raw: string) {
    const n = parseInt(raw, 10);
    setAddQtyByProduct((prev) => ({
      ...prev,
      [productId]: Number.isInteger(n) && n > 0 ? n : 0,
    }));
  }

  function addProductToCart(product: Product) {
    const service = String(product.productKind || 'PHYSICAL').toUpperCase() === 'SERVICE';
    if (!service && product.stockQty <= 0) {
      toast('庫存不足', 'error');
      return;
    }
    const qty = getAddQty(product);
    if (!Number.isInteger(qty) || qty <= 0) {
      toast('購買數量必須為正整數', 'error');
      return;
    }
    if (!service && qty > product.stockQty) {
      toast(`超過庫存（剩 ${product.stockQty}）`, 'error');
      return;
    }
    setCart((prev) => {
      const existing = prev.find(
        (c): c is CartProductLine => c.kind === 'PRODUCT' && c.productId === product.id,
      );
      if (existing) {
        const nextQty = existing.qty + qty;
        if (!service && nextQty > product.stockQty) {
          toast(`超過庫存（剩 ${product.stockQty}）`, 'error');
          return prev;
        }
        return prev.map((c) =>
          c.kind === 'PRODUCT' && c.productId === product.id ? { ...c, qty: nextQty } : c,
        );
      }
      return [
        ...prev,
        {
          kind: 'PRODUCT' as const,
          productId: product.id,
          qty,
          name: product.name,
          price: product.price,
        },
      ];
    });
    setAddQtyByProduct((prev) => ({ ...prev, [product.id]: 1 }));
  }

  function addPromoToCart() {
    if (!selectedPromotion) {
      toast('請先選擇促銷方案', 'error');
      return;
    }
    const isTimed = selectedPromotion.usageType !== 'UNLIMITED';
    if (isTimed && (!Number.isInteger(topupQty) || topupQty <= 0)) {
      toast('數量必須為正整數', 'error');
      return;
    }
    const line: CartPromoLine = {
      kind: 'PROMO',
      promotionId: selectedPromotion.id,
      qty: isTimed ? topupQty : 1,
      name: selectedPromotion.name,
      price: selectedPromotion.price,
      usageType: selectedPromotion.usageType,
      enableCardRecurring: selectedPromotion.enableCardRecurring,
      recurringAmount: selectedPromotion.recurringAmount || null,
      periodCount: selectedPromotion.periodCount,
      unitDays: selectedPromotion.unitDays,
      durationDays: selectedPromotion.durationDays,
      requiresMemberContract: selectedPromotion.requiresMemberContract,
    };
    setCart((prev) => [...prev.filter((c) => c.kind !== 'PROMO'), line]);
    toast(`已加入購案：${selectedPromotion.name}`, 'success');
  }

  function addCourseToCart() {
    if (!selectedCoursePlan) {
      toast('請先選擇課程方案', 'error');
      return;
    }
    if (!Number.isInteger(selectedCoursePlan.sessions) || (selectedCoursePlan.sessions || 0) <= 0) {
      toast('此方案未設定堂數', 'error');
      return;
    }
    if (!Number.isInteger(courseQty) || courseQty <= 0) {
      toast('數量必須為正整數', 'error');
      return;
    }
    if (!trainerId) {
      toast('請選擇負責教練', 'error');
      return;
    }
    const secondPersonOnSite =
      Boolean(selectedCoursePlan.enableSecondPerson) && courseSecondPerson;
    const gift = selectedCoursePlan.giftLabel?.trim() || null;
    setCart((prev) => {
      const existing = prev.find(
        (c): c is CartCourseLine => c.kind === 'COURSE' && c.coursePlanId === selectedCoursePlan.id,
      );
      if (existing) {
        return prev.map((c) =>
          c.kind === 'COURSE' && c.coursePlanId === selectedCoursePlan.id
            ? {
                ...c,
                qty: c.qty + courseQty,
                secondPersonOnSite: Boolean(c.secondPersonOnSite) || secondPersonOnSite,
                giftLabel: gift || c.giftLabel || null,
                enableCardRecurring: Boolean(selectedCoursePlan.enableCardRecurring),
                recurringPeriods: selectedCoursePlan.recurringPeriods || null,
                recurringAmount: selectedCoursePlan.recurringAmount || null,
                recurringAmount4: selectedCoursePlan.recurringAmount4 || null,
                recurringAmountFinal: selectedCoursePlan.recurringAmountFinal || null,
              }
            : c,
        );
      }
      return [
        ...prev,
        {
          kind: 'COURSE' as const,
          coursePlanId: selectedCoursePlan.id,
          qty: courseQty,
          name: selectedCoursePlan.name,
          price: selectedCoursePlan.price,
          sessions: selectedCoursePlan.sessions || 0,
          branchName: selectedCoursePlan.branchName || staffBranchLabel(selectedCoursePlan.branch),
          secondPersonOnSite,
          giftLabel: gift,
          giftQty: selectedCoursePlan.giftQty || null,
          enableCardRecurring: Boolean(selectedCoursePlan.enableCardRecurring),
          recurringPeriods: selectedCoursePlan.recurringPeriods || null,
          recurringAmount: selectedCoursePlan.recurringAmount || null,
          recurringAmount4: selectedCoursePlan.recurringAmount4 || null,
          recurringAmountFinal: selectedCoursePlan.recurringAmountFinal || null,
        },
      ];
    });
    setCourseQty(1);
    setCourseSecondPerson(false);
    toast(`已加入課程：${selectedCoursePlan.name}`, 'success');
  }

  function updateCartCourseQty(coursePlanId: number, raw: string) {
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) {
      setCart((prev) => prev.filter((c) => !(c.kind === 'COURSE' && c.coursePlanId === coursePlanId)));
      return;
    }
    setCart((prev) =>
      prev.map((c) =>
        c.kind === 'COURSE' && c.coursePlanId === coursePlanId ? { ...c, qty: n } : c,
      ),
    );
  }

  function updateCartPromoQty(promotionId: number, raw: string) {
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) {
      setCart((prev) => prev.filter((c) => !(c.kind === 'PROMO' && c.promotionId === promotionId)));
      return;
    }
    setCart((prev) =>
      prev.map((c) => {
        if (c.kind !== 'PROMO' || c.promotionId !== promotionId) return c;
        if (c.usageType === 'UNLIMITED') return c;
        return { ...c, qty: n };
      }),
    );
  }

  function updateCartProductQty(productId: number, raw: string) {
    const product = posProducts.find((p) => p.id === productId);
    const service = String(product?.productKind || 'PHYSICAL').toUpperCase() === 'SERVICE';
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0) {
      setCart((prev) => prev.filter((c) => !(c.kind === 'PRODUCT' && c.productId === productId)));
      return;
    }
    if (!service) {
      const max = product?.stockQty ?? n;
      if (n > max) {
        toast(`超過庫存（剩 ${max}）`, 'error');
        setCart((prev) =>
          prev.map((c) =>
            c.kind === 'PRODUCT' && c.productId === productId ? { ...c, qty: max } : c,
          ),
        );
        return;
      }
    }
    setCart((prev) =>
      prev.map((c) =>
        c.kind === 'PRODUCT' && c.productId === productId ? { ...c, qty: n } : c,
      ),
    );
  }

  function removeCartLine(line: CartLine) {
    setCart((prev) =>
      prev.filter((c) => {
        if (line.kind === 'PRODUCT') {
          return !(c.kind === 'PRODUCT' && c.productId === line.productId);
        }
        if (line.kind === 'COURSE') {
          return !(c.kind === 'COURSE' && c.coursePlanId === line.coursePlanId);
        }
        return c.kind !== 'PROMO';
      }),
    );
  }

  function clearCart() {
    setCart([]);
    if (!posDisplay.pendingConsentId) posDisplay.postIdle();
  }

  function sendContractConsentToDisplay() {
    if (!signMember || !signDetail?.body) {
      toast('契約內容不完整，無法派送客顯', 'error');
      return;
    }
    const branch =
      posBranchId !== ''
        ? staffBranchLabel(branches.find((b) => b.id === posBranchId)) || String(posBranchId)
        : staff?.branchName || '—';
    posDisplay.openDisplayWindow();
    posDisplay.requestConsent({
      purpose: 'CONTRACT',
      title:
        signDetail.contractDisplayName ||
        signDetail.contractShortName ||
        signDetail.contractTitle ||
        '定型化契約',
      body: signDetail.body,
      memberName: signMember.name,
      branchLabel: branch,
    });
    toast('已派送客顯契約簽署', 'info');
  }

  async function handleUnifiedCheckout() {
    if (checkoutInFlight.current || checkoutBusy) return;
    if (!cart.length) {
      toast('購物車是空的', 'error');
      return;
    }
    if (cartProductLines.length > 0 && !posBranchId) {
      toast('請選擇分店', 'error');
      return;
    }
    if (cartPromoLine && !selectedMember) {
      toast('購案必須選擇會員', 'error');
      return;
    }
    if (cartCourseLines.length > 0 && !selectedMember) {
      toast('課程必須選擇會員', 'error');
      return;
    }
    if (cartCourseLines.length > 0 && !trainerId) {
      toast('購買課程必須選擇教練', 'error');
      return;
    }
    if (paySelected.includes('WALLET_CASH') && !selectedMember) {
      toast('零錢包付款必須選擇會員', 'error');
      return;
    }
    if (!isPaymentsBalanced(paySelected, payAmounts, payableTotal, {
      ignoreCardAmount: yipayPayuniRecurring,
    })) {
      toast('請至少選一種付款方式，且分攤合計須等於應付金額', 'error');
      return;
    }
    if (paySelected.includes('VOUCHER') && !voucherCode.trim()) {
      toast('請掃描或輸入抵用券條碼', 'error');
      return;
    }
    if (paySelected.includes('LINEPAY') && !linePayOneTimeKey.trim()) {
      toast('請掃描會員 LinePay 付款碼（My Code）', 'error');
      return;
    }
    if (yipayPayuniRecurring && !paySelected.includes('YIPAY')) {
      toast('月卡／課程定期定額：首期請使用乙禾現場刷卡', 'error');
      return;
    }
    if (
      (paySelected.includes('CARD') || yipayPayuniRecurring) &&
      cardOptions.cardMode === 'RECURRING' &&
      (cardOptions.recurringAmount == null || cardOptions.recurringAmount <= 0)
    ) {
      toast('請輸入定期定額期付金額', 'error');
      return;
    }
    const invoiceErr = validateInvoiceOptions({
      carrierNum: carrier,
      buyerUbn,
      loveCode,
    });
    if (invoiceErr) {
      toast(invoiceErr, 'error');
      return;
    }

    checkoutInFlight.current = true;
    setCheckoutBusy(true);
    try {
      const result = await opsCheckout({
        ...(posBranchId ? { branchId: Number(posBranchId) } : {}),
        ...(selectedMember ? { memberId: selectedMember.id } : {}),
        ...(cartProductLines.length
          ? {
              items: cartProductLines.map((c) => ({
                productId: c.productId,
                qty: c.qty,
              })),
            }
          : {}),
        ...(cartPromoLine
          ? {
              promotionId: cartPromoLine.promotionId,
              qty: cartPromoLine.qty,
            }
          : {}),
        ...(cartCourseLines.length
          ? {
              courseItems: cartCourseLines.map((c) => ({
                coursePlanId: c.coursePlanId,
                qty: c.qty,
                ...(c.secondPersonOnSite ? { secondPersonOnSite: true } : {}),
              })),
              trainerId: Number(trainerId),
            }
          : {}),
        payments: buildPaymentsPayload(paySelected, payAmounts, voucherCode, {
          omitZeroCard: yipayPayuniRecurring,
        }),
        ...buildCardPayPayload(
          cardOptions,
          paySelected.includes('CARD') && !yipayPayuniRecurring,
          yipayPayuniRecurring && paySelected.includes('YIPAY'),
        ),
        ...(paySelected.includes('LINEPAY')
          ? { linePayOneTimeKey: linePayOneTimeKey.trim() }
          : {}),
        carrierNum: carrier.trim() || undefined,
        buyerUbn: buyerUbn.trim() || undefined,
        loveCode: loveCode.trim() || undefined,
      });
      if (result.status !== 'success') {
        toast(result.message || '結帳失敗', 'error');
        return;
      }
      if (result.data?.actionUrl && result.data?.payload) {
        const payRef =
          result.data.checkoutId || result.data.orderId || result.data.saleId || '';
        if (cardOptions.cardMode === 'RECURRING' && payRef) {
          toast('已另開 PayUNi 續期收款分頁（該頁不會自動跳回）', 'info');
          openPayuniCheckoutInNewTab(result.data.actionUrl, result.data.payload);
          pendingPeriodSettled.current = false;
          setPendingPeriodStatus('PENDING');
          setPendingPeriodPay({
            ref: payRef,
            label: result.data.checkoutId
              ? `合併結帳 ${payRef}`
              : result.data.orderId
                ? `購案 ${payRef}`
                : `單號 ${payRef}`,
          });
          return;
        }
        toast('導向 PayUNi 刷卡…', 'info');
        redirectToCheckOut(result.data.actionUrl, result.data.payload);
        return;
      }
      if (result.data?.channel === 'YIPAY' && result.data.checkoutId) {
        setYipayTerminalRef('');
        setPendingYipay({
          checkoutId: result.data.checkoutId,
          amount: Number(result.data.yipayAmount || result.data.amount || 0),
          hint: result.data.terminalHint,
          needsPeriodBind: Boolean(result.data.needsPeriodBind),
          recurringAmount: result.data.recurringAmount ?? null,
          periodTimes: result.data.periodTimes ?? null,
        });
        toast(result.message || '請至乙禾刷卡機收款後確認', 'info');
        return;
      }
      toast(
        `${result.message || '結帳成功'}${result.data?.checkoutId ? ` · ${result.data.checkoutId}` : ''}${
          Array.isArray(result.data?.invoices) && result.data.invoices.some((i) => i.invoiceNumber)
            ? ` · 發票 ${result.data.invoices
                .filter((i) => i.invoiceNumber)
                .map((i) => i.invoiceNumber)
                .join('、')}`
            : result.data?.invoiceNumber
              ? ` · 發票 ${result.data.invoiceNumber}`
              : ''
        }`,
        'success',
      );
      clearCart();
      setTopupQty(1);
      resetSharedCheckoutPay();
      void loadMembers({ skip: 0 });
      if (posBranchId) {
        const prodRes = await fetchOpsProducts(Number(posBranchId));
        if (prodRes.status === 'success' && prodRes.data) setPosProducts(prodRes.data);
      }
    } catch (err) {
      toast(getErrorMessage(err, '結帳失敗'), 'error');
    } finally {
      checkoutInFlight.current = false;
      setCheckoutBusy(false);
    }
  }

  async function handleConfirmYipay() {
    if (!pendingYipay?.checkoutId || yipayConfirmBusy) return;
    setYipayConfirmBusy(true);
    try {
      const result = await opsConfirmYipay({
        checkoutId: pendingYipay.checkoutId,
        terminalRef: yipayTerminalRef.trim() || undefined,
      });
      if (result.status !== 'success') {
        toast(result.message || '乙禾確認入帳失敗', 'error');
        return;
      }
      const inv =
        Array.isArray(result.data?.invoices) && result.data.invoices.some((i) => i.invoiceNumber)
          ? result.data.invoices
              .filter((i) => i.invoiceNumber)
              .map((i) => i.invoiceNumber)
              .join('、')
          : result.data?.invoiceNumber || null;
      const payRef = result.data?.checkoutId || pendingYipay.checkoutId;
      setPendingYipay(null);
      setYipayTerminalRef('');

      if (result.data?.actionUrl && result.data?.payload) {
        toast(
          `${result.message || '乙禾首期已入帳'}${inv ? ` · 發票 ${inv}` : ''} · 請於 PayUNi 頁輸入卡號（$1 驗證授權，隨後取消不請款）`,
          'success',
        );
        openPayuniCheckoutInNewTab(result.data.actionUrl, result.data.payload);
        pendingPeriodSettled.current = false;
        setPendingPeriodStatus('PENDING');
        setPendingPeriodPay({
          ref: payRef,
          label: `合併結帳 ${payRef}（定期定額約定）`,
          bindOnly: true,
        });
        // 購物車暫不清空，等約定／Notify；仍可手動清空
        clearCart();
        setTopupQty(1);
        resetSharedCheckoutPay();
        void loadMembers({ skip: 0 });
        if (posBranchId) {
          const prodRes = await fetchOpsProducts(Number(posBranchId));
          if (prodRes.status === 'success' && prodRes.data) setPosProducts(prodRes.data);
        }
        return;
      }

      if (result.data?.bindError) {
        toast(
          `乙禾已入帳${inv ? ` · 發票 ${inv}` : ''}，但 PayUNi 約定頁建立失敗：${result.data.bindError}`,
          'error',
        );
      } else {
        toast(
          `${result.message || '乙禾刷卡已入帳'}${inv ? ` · 發票 ${inv}` : ''}`,
          'success',
        );
      }
      clearCart();
      setTopupQty(1);
      resetSharedCheckoutPay();
      void loadMembers({ skip: 0 });
      if (posBranchId) {
        const prodRes = await fetchOpsProducts(Number(posBranchId));
        if (prodRes.status === 'success' && prodRes.data) setPosProducts(prodRes.data);
      }
    } catch (err) {
      toast(getErrorMessage(err, '乙禾確認入帳失敗'), 'error');
    } finally {
      setYipayConfirmBusy(false);
    }
  }

  async function openFaceModal(member: OpsMember) {
    if (!member.faceEnabled) {
      toast('請先於編輯勾選「啟用人臉辨識」，並完成生物辨識同意書簽署', 'error');
      return;
    }
    if (!member.allowBiometrics) {
      toast('請先完成「生物辨識同意書」電子簽名，始可辦理人臉綁定', 'error');
      return;
    }
    setFaceMemberId(member.id);
    setFaceMemberName(member.name);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch {
      toast('無法開啟鏡頭，請確認 HTTPS 權限', 'error');
      setFaceMemberId(null);
    }
  }

  function closeFaceModal() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setFaceMemberId(null);
  }

  async function captureAndBind() {
    if (!faceMemberId || !videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const faceImage = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];

    try {
      const result = await opsBindFace(faceMemberId, faceImage);
      toast(result.message || '人臉綁定成功', 'success');
      closeFaceModal();
      void loadMembers({ skip: 0 });
    } catch (err) {
      toast(getErrorMessage(err, '人臉綁定失敗'), 'error');
    }
  }

  const planReadonly = editingMember
    ? formatPlanLabel(editingMember.plan)
    : '分鐘計費';
  const expireReadonly = editingMember
    ? formatExpireLabel(editingMember.plan, editingMember.expireDate)
    : '無效期';

  const memberFormFields = (
    <div className="form-stack">
      <Field label="姓名">
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          autoComplete="name"
        />
      </Field>
      <Field label="手機號碼" hint="必填">
        <Input
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          required
          inputMode="tel"
          placeholder="0912345678"
          autoComplete="tel"
        />
      </Field>
      <Field label="Email" hint="換機 Email OTP 必填；請填可收信信箱">
        <Input
          type="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          autoComplete="email"
          placeholder="member@example.com"
        />
      </Field>
      <Field
        label="身分證／居留證／護照"
        hint="必填；身分證／居留證／護照號碼"
      >
        <Input
          value={form.idNumber}
          onChange={(e) => setForm((f) => ({ ...f, idNumber: e.target.value.toUpperCase() }))}
          autoComplete="off"
          placeholder="A123456789 或護照號"
          required
        />
      </Field>

      <Field
        label="綁定分店"
        hint={
          branchLocked
            ? '櫃檯帳號固定綁定本店（進出場僅限綁定場館；AC↔HP 可互進）'
            : '至少一間；進出場掃碼須符合綁定場館（AC↔HP 可互進）'
        }
      >
        {branchLocked && staff?.branchId ? (
          <Input
            value={
              staff.branchName ||
              staffBranchLabel(branches.find((b) => b.id === staff.branchId)) ||
              `分店 #${staff.branchId}`
            }
            readOnly
          />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {branches
              .filter((b) => b.isActive !== false)
              .map((b) => {
                const checked = form.branchIds.includes(b.id);
                return (
                  <label
                    key={b.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          branchIds: checked
                            ? f.branchIds.filter((id) => id !== b.id)
                            : [...f.branchIds, b.id],
                        }))
                      }
                    />
                    <span>{staffBranchLabel(b) || b.name}</span>
                  </label>
                );
              })}
            {branches.length === 0 ? (
              <span className="text-muted text-sm">尚無分店資料</span>
            ) : null}
          </div>
        )}
      </Field>

      {editingMember && (
        <>
          <Field label="緊急聯絡人" hint="選填">
            <Input
              value={form.emergencyContact}
              onChange={(e) => setForm((f) => ({ ...f, emergencyContact: e.target.value }))}
              placeholder="姓名"
              autoComplete="off"
            />
          </Field>
          <Field label="緊急聯絡人電話" hint="選填">
            <Input
              value={form.emergencyContactPhone}
              onChange={(e) =>
                setForm((f) => ({ ...f, emergencyContactPhone: e.target.value }))
              }
              inputMode="tel"
              placeholder="0912345678"
              autoComplete="tel"
            />
          </Field>

          <div className="form-stack" style={{ marginTop: '0.5rem' }}>
            <strong>電子合約</strong>
            <p className="text-muted text-sm" style={{ margin: 0 }}>
              綠色已簽 · 灰色未簽 · 紅色必簽未簽／版本異動需重簽。生物辨識同意書僅在勾選「啟用人臉辨識」後才標紅。點選展開內容並請會員電子簽名。
            </p>
            {(memberContractBoard.length ? memberContractBoard : editingMember.contracts || [])
              .length === 0 ? (
              <p className="text-muted text-sm">尚無啟用中電子合約範本（請至 HQ「電子合約」建立）</p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {(memberContractBoard.length
                  ? memberContractBoard
                  : editingMember.contracts || []
                ).map((c) => (
                  <button
                    key={c.contractId}
                    type="button"
                    className={contractToneClass(c.tone)}
                    title={`${c.displayName || c.shortName || c.title} · ${contractToneLabel(c)}`}
                    onClick={() => void openContractFromList(editingMember, c)}
                  >
                    {c.displayName || c.shortName || c.title}
                    {c.versionLabel
                      ? ` ${c.versionLabel}`
                      : c.version
                        ? ` v${c.version}`
                        : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <Field
        label="方案"
        hint="購買完成後由系統導入；未購前固定分鐘計費"
      >
        <Input value={planReadonly} readOnly disabled />
      </Field>
      <Field
        label="效期"
        hint={
          isMinuteBilling(editingMember?.plan) || !editingMember
            ? '分鐘計費無效期'
            : isUnlimitedMember(editingMember?.plan)
              ? '無限使用方案效期（購案後由系統寫入）'
              : '效期由購案流程寫入，不可手改'
        }
      >
        <Input value={expireReadonly} readOnly disabled />
      </Field>

      {editingMember && (
        <>
          <Field label="LINE ID（鎖定顯示）" hint="OAuth 綁定或下方手動綁定">
            <Input
              value={editingMember.lineId || '尚未綁定'}
              readOnly
              disabled
              className="mono"
            />
          </Field>
          <div className="bind-row">
            <Input
              value={manualLineId}
              onChange={(e) => setManualLineId(e.target.value)}
              placeholder="手動輸入 LINE userId"
            />
            <Button size="sm" onClick={handleBindLine} loading={binding} disabled={!manualLineId.trim()}>
              手動綁定
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleUnbindLine}
              disabled={!editingMember.lineId || binding}
            >
              解除
            </Button>
          </div>

          <Field label="裝置 ID（鎖定顯示）" hint="須於會員 App 登入綁定，或下方手動綁定；閘機掃碼不自動綁定">
            <Input
              value={editingMember.deviceId || '尚未綁定'}
              readOnly
              disabled
              className="mono"
            />
          </Field>
          <div className="bind-row">
            <Input
              value={manualDeviceId}
              onChange={(e) => setManualDeviceId(e.target.value)}
              placeholder="手動輸入 deviceId"
            />
            <Button
              size="sm"
              onClick={handleBindDevice}
              loading={binding}
              disabled={!manualDeviceId.trim()}
            >
              手動綁定
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleUnbindDevice}
              disabled={!editingMember.deviceId || binding}
            >
              解除
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleResetDevice()}
              disabled={!editingMember.deviceId || binding}
            >
              臨櫃重置
            </Button>
          </div>
        </>
      )}

      {createOpen && !editingMember && (
        <>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={form.faceEnabled}
              onChange={(e) => setForm((f) => ({ ...f, faceEnabled: e.target.checked }))}
            />
            <span className="field__label" style={{ margin: 0 }}>
              是否使用生物辨識功能（人臉進出場）
            </span>
          </label>
          <p className="text-muted text-sm" style={{ margin: '-0.35rem 0 0.5rem' }}>
            勾選後開卡將啟用人臉，並請會員當場簽署「生物辨識同意書」。
          </p>
        </>
      )}

      {editingMember && (
        <>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={form.faceEnabled}
              onChange={(e) => setForm((f) => ({ ...f, faceEnabled: e.target.checked }))}
            />
            <span className="field__label" style={{ margin: 0 }}>
              啟用人臉辨識
            </span>
          </label>
          <p className="text-muted text-sm" style={{ margin: '-0.35rem 0 0.5rem' }}>
            勾選後，「生物辨識同意書」才會標為必簽（紅）；完成簽署後才可綁定人臉。
          </p>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={form.isAlert}
              disabled={Boolean(editingMember?.isAlert)}
              onChange={(e) => {
                if (!e.target.checked && editingMember?.isAlert) return;
                setForm((f) => ({ ...f, isAlert: e.target.checked }));
              }}
            />
            <span className="field__label" style={{ margin: 0 }}>
              警示黑名單（isAlert）
            </span>
          </label>
          {editingMember?.isAlert ? (
            <p className="text-muted text-sm" style={{ margin: '-0.35rem 0 0.5rem' }}>
              解除警示請改由總部「合規補償 → 解鎖帳號」（須填原因並寫入日誌）。
            </p>
          ) : null}
        </>
      )}
      <Alert tone="info">
        方案／效期／錢包不可手改。方案於購買完成後導入；未購前一律分鐘計費且無效期。人臉：啟用→簽署同意書→綁定人臉。
      </Alert>
    </div>
  );

  const showMemberPicker = tab !== 'shift' && tab !== 'orders' && tab !== 'checkins';

  return (
    <div className="hq-dashboard">
      <div className="ops-context-sticky">
        <BranchScopeBar
          branches={branches}
          branchId={posBranchId}
          locked={branchLocked}
          lockedLabel={staff?.branchName || (staff?.branchId ? `分店 #${staff.branchId}` : undefined)}
          hint="臨櫃結帳商品／購案／私教皆以此分店為準"
          onChange={(id) => {
            setPosBranchId(id);
            setCart((prev) => prev.filter((c) => c.kind !== 'PRODUCT' && c.kind !== 'COURSE'));
            setAddQtyByProduct({});
            setCoursePlanId('');
          }}
        />
        {showMemberPicker && selectedMember ? (
          <div className="ops-context-sticky__member" aria-live="polite">
            <div className="ops-context-sticky__member-info">
              <span className="ops-context-sticky__member-label">已選會員</span>
              <strong>
                {selectedMember.memberNo || `#${selectedMember.id}`} {selectedMember.name}
              </strong>
              <span className="text-muted text-sm">{selectedMember.phone}</span>
              <span className="text-muted text-sm">
                零錢包 ${selectedMember.cashWallet} · 運動金 ${selectedMember.bonusWallet}
              </span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSelectedMember(null)}>
              清除
            </Button>
          </div>
        ) : null}
      </div>

      <OpsInvoiceFailBanner />

      {showMemberPicker && (
      <Card title="選擇會員" subtitle="全櫃檯共用 · 電話／QR／人臉辨識後，臨櫃結帳與會員管理皆沿用此會員">
        <MemberIdentifyPanel
          selectedMember={selectedMember}
          onSelect={setSelectedMember}
          label="當前會員"
          hint="切換分頁不會清除；可按清除改選其他人"
        />
      </Card>
      )}

      <nav className="hq-tabs" role="tablist" aria-label="櫃檯維運功能">
        {OPS_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`hq-tabs__btn ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="hq-tab-panel" role="tabpanel">
      {tab === 'shift' && (
        <OpsShiftHandoverTab
          branchId={posBranchId}
          branchName={
            posBranchId === ''
              ? null
              : staffBranchLabel(branches.find((b) => b.id === posBranchId)) ||
                staff?.branchName ||
                null
          }
          branches={branches}
        />
      )}
      {tab === 'checkins' && <OpsActiveCheckInsTab branchId={posBranchId} />}
      {tab === 'checkout' && (
      <PageSection
        title="臨櫃結帳"
        desc="商品／購案／私教課程加入同一購物車 · 一次付款／一張發票 · 金額以後端查價為準"
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              posDisplay.openDisplayWindow();
              if (cart.length) {
                posDisplay.postCart(
                  buildOpsPosDisplayCart(cart, promotions, {
                    payableTotal,
                    memberName: selectedMember?.name,
                  }),
                );
              }
            }}
          >
            開啟客顯{posDisplay.displayLinked ? ' · 已連線' : ''}
          </Button>
        }
      >
        <div className="staff-grid">
          <div className="form-stack">
            <Card
              title="選品"
              subtitle={
                posBranchId
                  ? `分店：${staffBranchLabel(branches.find((b) => b.id === posBranchId)) || `#${posBranchId}`}`
                  : '請先於上方選擇分店'
              }
            >
              <div className="form-stack">
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>商品</th>
                        <th>售價</th>
                        <th>庫存</th>
                        <th>數量</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {posProducts.map((p) => {
                        const service = String(p.productKind || 'PHYSICAL').toUpperCase() === 'SERVICE';
                        return (
                        <tr key={p.id}>
                          <td className="mono text-sm">{p.sku}</td>
                          <td>
                            {p.name}
                          </td>
                          <td>${p.price}</td>
                          <td>{service ? '—' : p.stockQty}</td>
                          <td style={{ width: 96 }}>
                            <Input
                              type="number"
                              min={1}
                              max={service ? undefined : p.stockQty}
                              value={getAddQty(p)}
                              onChange={(e) => setAddQty(p.id, e.target.value)}
                              disabled={!service && p.stockQty <= 0}
                              aria-label={`${p.name} 購買數量`}
                            />
                          </td>
                          <td>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => addProductToCart(p)}
                              disabled={!service && p.stockQty <= 0}
                            >
                              加入購物車
                            </Button>
                          </td>
                        </tr>
                        );
                      })}
                      {posProducts.length === 0 && (
                        <tr>
                          <td colSpan={6} className="text-muted text-center">此分店無可售商品</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>

            <Card title="購案">
              <div className="form-stack">
                {!selectedMember && (
                  <Alert tone="warning">購案需先於上方「選擇會員」</Alert>
                )}
                <Field label="促銷方案">
                  <Select
                    value={selectedPromotion?.id != null ? String(selectedPromotion.id) : ''}
                    onChange={(e) => {
                      setPromotionId(Number(e.target.value) || '');
                      setTopupQty(1);
                    }}
                  >
                    <option value="">— 請選擇促銷方案 —</option>
                    {branchPromotions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {formatPromotionOptionLabel(p)}
                      </option>
                    ))}
                  </Select>
                </Field>
                {branchPromotions.length === 0 && (
                  <Alert tone="info">此分店尚無可售購案</Alert>
                )}
                {selectedPromotion && selectedPromotion.usageType !== 'UNLIMITED' && (
                  <Field
                    label="數量"
                    hint={`單份 $${selectedPromotion.price} + SC $${selectedPromotion.bonusGiven}`}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={topupQty}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setTopupQty(Number.isInteger(n) && n > 0 ? n : 0);
                      }}
                      style={{ maxWidth: 120 }}
                    />
                  </Field>
                )}
                {selectedPromotion?.usageType === 'UNLIMITED' && (
                  <Alert tone="info">
                    {selectedPromotion.enableCardRecurring ? (
                      <>
                        無限使用（定期定額）：每次入帳延長{' '}
                        <strong>{selectedPromotion.unitDays || selectedPromotion.durationDays} 天</strong>
                        （首期＝購案當下；續期於每次扣款成功後再展延）。方案共{' '}
                        {selectedPromotion.periodCount || '—'} 期
                        {selectedPromotion.unitDays && selectedPromotion.periodCount
                          ? `（合計參考 ${selectedPromotion.durationDays} 天）`
                          : ''}
                        。
                      </>
                    ) : (
                      <>
                        無限使用：方案費 ${selectedPromotion.price} 不入錢包，購買後延長{' '}
                        {selectedPromotion.unitDays && selectedPromotion.periodCount
                          ? `${selectedPromotion.unitDays} 天 × ${selectedPromotion.periodCount} 期＝${selectedPromotion.durationDays} 天`
                          : `${selectedPromotion.durationDays} 天`}{' '}
                        有效期限（起始日算第 1 天）。
                      </>
                    )}
                  </Alert>
                )}
                {selectedPromotion?.requiresMemberContract && (
                  <Alert tone="warning">
                    此方案需簽署會員合約後方可購買
                    {selectedPromotion.contracts?.length
                      ? `（${selectedPromotion.contracts.map((c) => c.displayName || c.shortName || c.title).join('、')}）`
                      : ''}
                    。
                  </Alert>
                )}
                {selectedPromotion?.enableCardRecurring && (
                  <Alert tone="info">
                    此方案已啟用定期定額：首期 $
                    {selectedPromotion.price.toLocaleString('zh-TW')}
                    · 續期 $
                    {(
                      selectedPromotion.recurringAmount != null &&
                      selectedPromotion.recurringAmount > 0
                        ? selectedPromotion.recurringAmount
                        : selectedPromotion.price
                    ).toLocaleString('zh-TW')}
                    {selectedPromotion.periodCount
                      ? ` · 共 ${selectedPromotion.periodCount} 期（同有效期期數）`
                      : ''}
                    。結帳選刷卡→定期定額後自動帶入。
                  </Alert>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!selectedPromotion || (selectedPromotion.usageType !== 'UNLIMITED' && topupQty <= 0)}
                  onClick={addPromoToCart}
                >
                  加入購物車
                </Button>
              </div>
            </Card>

            <Card title="私教課程">
              <div className="form-stack">
                {!selectedMember && (
                  <Alert tone="warning">購買課程需先於上方「選擇會員」</Alert>
                )}
                <Field label="負責教練">
                  <Select
                    value={trainerId === '' ? '' : String(trainerId)}
                    onChange={(e) => setTrainerId(Number(e.target.value) || '')}
                  >
                    <option value="">— 請選擇教練 —</option>
                    {trainers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}{t.role === 'MANAGER' ? '（主管）' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="課程方案">
                  <Select
                    value={coursePlanId === '' ? '' : String(coursePlanId)}
                    onChange={(e) => {
                      setCoursePlanId(Number(e.target.value) || '');
                      setCourseQty(1);
                      setCourseSecondPerson(false);
                    }}
                  >
                    <option value="">— 請選擇課程方案 —</option>
                    {coursePlans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · ${p.price} · {p.sessions} 堂
                        {p.branchName || staffBranchLabel(p.branch)
                          ? ` · ${p.branchName || staffBranchLabel(p.branch)}`
                          : ''}
                        {p.giftLabel ? ` · 贈${p.giftLabel}${p.giftQty && p.giftQty > 1 ? ` ×${p.giftQty}` : ''}` : ''}
                        {p.enableCardRecurring ? ' · 定期定額' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                {selectedCoursePlan && (
                  <Field
                    label="數量"
                    hint={`單份 ${selectedCoursePlan.sessions} 堂 · $${selectedCoursePlan.price}`}
                  >
                    <Input
                      type="number"
                      min={1}
                      value={courseQty}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setCourseQty(Number.isInteger(n) && n > 0 ? n : 0);
                      }}
                      style={{ maxWidth: 120 }}
                    />
                  </Field>
                )}
                {selectedCoursePlan?.enableSecondPerson && (
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={courseSecondPerson}
                      onChange={(e) => setCourseSecondPerson(e.target.checked)}
                    />
                    課程第二人+$500（課程當日現場支付）
                  </label>
                )}
                {selectedCoursePlan?.enableSecondPerson && (
                  <p className="text-muted text-sm" style={{ marginTop: '-0.35rem' }}>
                    勾選後僅註記，不計入本次結帳；請於上課日現場另收 $500
                  </p>
                )}
                {selectedCoursePlan?.enableCardRecurring && (
                  <Alert tone="info">
                    此課程方案已啟用定期定額
                    {(() => {
                      const n = Number(selectedCoursePlan.recurringPeriods) || 0;
                      const allow2 = (n & 2) !== 0;
                      const allow4 = (n & 4) !== 0;
                      const bits: string[] = [];
                      if (allow2) {
                        bits.push(
                          selectedCoursePlan.recurringAmount != null
                            ? `2期：第1期 $${(
                                selectedCoursePlan.price - selectedCoursePlan.recurringAmount
                              ).toLocaleString('zh-TW')} · 第2期 $${selectedCoursePlan.recurringAmount.toLocaleString(
                                'zh-TW',
                              )}`
                            : '2期',
                        );
                      }
                      if (allow4) {
                        const base =
                          selectedCoursePlan.recurringAmount4 != null
                            ? selectedCoursePlan.recurringAmount4
                            : !allow2
                              ? selectedCoursePlan.recurringAmount
                              : null;
                        bits.push(
                          selectedCoursePlan.recurringAmountFinal != null && base != null
                            ? `4期：第1-3期 $${Number(base).toLocaleString(
                                'zh-TW',
                              )} · 第4期 $${selectedCoursePlan.recurringAmountFinal.toLocaleString(
                                'zh-TW',
                              )}`
                            : '4期',
                        );
                      }
                      return bits.length ? `（可選 ${bits.join(' ／ ')}）` : '';
                    })()}
                    ：結帳選刷卡→定期定額後自動帶入。
                  </Alert>
                )}
                {selectedCoursePlan?.giftLabel && (
                  <Alert tone="info">
                    加贈禮：{selectedCoursePlan.giftLabel}
                    {selectedCoursePlan.giftQty && selectedCoursePlan.giftQty > 1
                      ? ` ×${selectedCoursePlan.giftQty}`
                      : ''}
                    （入購物車 · $0 不收款）
                  </Alert>
                )}
                {selectedCoursePlan?.requiresMemberContract && (
                  <Alert tone="warning">此課程方案需簽署會員合約後方可購買。</Alert>
                )}
                {coursePlans.length === 0 && (
                  <Alert tone="info">此分店尚無可售私教方案</Alert>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!selectedCoursePlan || !trainerId || courseQty <= 0}
                  onClick={addCourseToCart}
                >
                  加入購物車
                </Button>
              </div>
            </Card>
          </div>

          <Card title="購物車與結帳" subtitle={`應付約 $${payableTotal}（以後端為準）`}>
            <div className="form-stack">
              <ul className="cart-lines">
                {cart.map((c) => {
                  const kindLabel =
                    c.kind === 'PRODUCT' ? '商品' : c.kind === 'COURSE' ? '課程' : '購案';
                  const lineKey =
                    c.kind === 'PRODUCT'
                      ? `p-${c.productId}`
                      : c.kind === 'COURSE'
                        ? `c-${c.coursePlanId}`
                        : `promo-${c.promotionId}`;
                  const lineTotal =
                    c.kind === 'PROMO' && c.usageType === 'UNLIMITED'
                      ? c.price
                      : c.price * c.qty;
                  const metaParts: string[] = [];
                  if (c.kind === 'COURSE') {
                    metaParts.push(`${c.sessions} 堂`);
                    if (c.secondPersonOnSite) metaParts.push('第二人 +$500（當日現場）');
                    if (c.giftLabel) {
                      const qtyStr = c.giftQty && c.giftQty > 1 ? ` ×${c.giftQty}` : '';
                      metaParts.push(`贈 ${c.giftLabel}${qtyStr}（$0）`);
                    }
                    if (c.enableCardRecurring) metaParts.push('定期定額');
                  }
                  if (c.kind === 'PROMO' && c.usageType === 'UNLIMITED') {
                    metaParts.push('無限方案');
                  }

                  return (
                    <li key={lineKey} className="cart-line">
                      <div className="cart-line__info">
                        <div className="cart-line__title">
                          <span className="cart-line__kind">{kindLabel}</span>
                          <span className="cart-line__name">{c.name}</span>
                        </div>
                        {metaParts.length > 0 ? (
                          <p className="cart-line__meta">{metaParts.join(' · ')}</p>
                        ) : null}
                      </div>
                      <span className="cart-line__unit">${c.price}</span>
                      {c.kind === 'PRODUCT' ? (
                        <Input
                          className="cart-line__qty"
                          type="number"
                          min={1}
                          value={c.qty}
                          onChange={(e) => updateCartProductQty(c.productId, e.target.value)}
                          aria-label={`${c.name} 結帳數量`}
                        />
                      ) : c.kind === 'COURSE' ? (
                        <Input
                          className="cart-line__qty"
                          type="number"
                          min={1}
                          value={c.qty}
                          onChange={(e) => updateCartCourseQty(c.coursePlanId, e.target.value)}
                          aria-label={`${c.name} 結帳數量`}
                        />
                      ) : c.kind === 'PROMO' && c.usageType !== 'UNLIMITED' ? (
                        <Input
                          className="cart-line__qty"
                          type="number"
                          min={1}
                          value={c.qty}
                          onChange={(e) => updateCartPromoQty(c.promotionId, e.target.value)}
                          aria-label={`${c.name} 結帳數量`}
                        />
                      ) : (
                        <span className="cart-line__qty-fixed" aria-label={`${c.name} 數量`}>
                          × {c.qty}
                        </span>
                      )}
                      <span className="cart-line__total">= ${lineTotal}</span>
                      <div className="cart-line__actions">
                        <Button size="sm" variant="ghost" onClick={() => removeCartLine(c)}>
                          移除
                        </Button>
                      </div>
                    </li>
                  );
                })}
                {cart.length === 0 && (
                  <li className="text-muted">購物車是空的 · 請加入商品、購案或課程</li>
                )}
              </ul>

              {cartPromoLine && !selectedMember && (
                <Alert tone="warning">購物車含購案，請先選擇會員</Alert>
              )}
              {cartCourseLines.length > 0 && !selectedMember && (
                <Alert tone="warning">購物車含課程，請先選擇會員</Alert>
              )}
              {cartCourseLines.length > 0 && !trainerId && (
                <Alert tone="warning">購買課程請選擇負責教練</Alert>
              )}
              {paySelected.includes('WALLET_CASH') && !selectedMember && (
                <Alert tone="warning">使用零錢包時請先於上方「選擇會員」</Alert>
              )}

              <CompositePayFields
                totalAmount={payableTotal}
                allowedMethods={
                  allowCardRecurring
                    ? ['CASH', 'YIPAY', 'CARD', 'LINEPAY', 'WALLET_CASH', 'VOUCHER']
                    : ['CASH', 'YIPAY', 'LINEPAY', 'WALLET_CASH', 'VOUCHER']
                }
                selected={paySelected}
                onSelectedChange={setPaySelected}
                amounts={payAmounts}
                onAmountsChange={setPayAmounts}
                voucherCode={voucherCode}
                onVoucherCodeChange={setVoucherCode}
                linePayOneTimeKey={linePayOneTimeKey}
                onLinePayOneTimeKeyChange={setLinePayOneTimeKey}
                carrierValue={carrier}
                onCarrierChange={setCarrier}
                buyerUbn={buyerUbn}
                onBuyerUbnChange={setBuyerUbn}
                loveCode={loveCode}
                onLoveCodeChange={setLoveCode}
                cardOptions={cardOptions}
                onCardOptionsChange={(opts) => {
                  if (opts.cardMode === 'RECURRING' && cartPromoLine?.enableCardRecurring) {
                    const periodAmt =
                      cartPromoLine.recurringAmount != null && cartPromoLine.recurringAmount > 0
                        ? cartPromoLine.recurringAmount
                        : cartPromoLine.price;
                    setCardOptions({
                      ...opts,
                      periodTimes: cartPromoLine.periodCount || opts.periodTimes,
                      recurringAmount: periodAmt,
                    });
                    return;
                  }
                  if (
                    opts.cardMode === 'RECURRING' &&
                    recurringCourseLine &&
                    !cartPromoLine?.enableCardRecurring
                  ) {
                    const amt = resolveCourseRecurringAmount(opts.periodTimes);
                    if (amt != null && amt > 0) {
                      setCardOptions({ ...opts, recurringAmount: amt });
                      return;
                    }
                  }
                  setCardOptions(opts);
                }}
                allowCardRecurring={allowCardRecurring}
                allowYipayPayuniRecurring={yipayPayuniRecurring}
                payuniCardModes={['RECURRING']}
                allowedPeriodTimes={promoAllowedPeriodTimes ?? courseAllowedPeriodTimes}
                defaultPeriodTimes={
                  cartPromoLine?.periodCount ?? courseDefaultPeriodTimes ?? undefined
                }
                defaultRecurringAmount={defaultRecurringAmount}
                lockRecurringAmount={
                  Boolean(cartPromoLine?.enableCardRecurring) ||
                  Boolean(recurringCourseLine && !cartPromoLine?.enableCardRecurring)
                }
                hint={
                  selectedMember
                    ? yipayPayuniRecurring
                      ? `會員 ${selectedMember.memberNo || `#${selectedMember.id}`} ${selectedMember.name} · 定期定額＝乙禾首期＋PayUNi 約定`
                      : `會員 ${selectedMember.memberNo || `#${selectedMember.id}`} ${selectedMember.name} · 零錢包 $${selectedMember.cashWallet} · 現場刷卡＝乙禾；定期定額＝PayUNi`
                    : yipayPayuniRecurring
                      ? '定期定額：乙禾收首期，確認後開 PayUNi 約定續期'
                      : '現場刷卡＝乙禾固定式；PayUNi 僅定期定額；零錢包只扣本金'
                }
              />

              <div className="checkout-actions">
                <Button variant="ghost" onClick={clearCart} disabled={!cart.length}>
                  清空
                </Button>
                <Button
                  onClick={() => void handleUnifiedCheckout()}
                  loading={checkoutBusy}
                  disabled={
                    checkoutBusy ||
                    Boolean(pendingYipay) ||
                    !cart.length ||
                    (cartProductLines.length > 0 && !posBranchId) ||
                    (Boolean(cartPromoLine) && !selectedMember) ||
                    (cartCourseLines.length > 0 && (!selectedMember || !trainerId)) ||
                    (paySelected.includes('WALLET_CASH') && !selectedMember) ||
                    (paySelected.includes('LINEPAY') && !linePayOneTimeKey.trim()) ||
                    !isPaymentsBalanced(paySelected, payAmounts, payableTotal, {
                      ignoreCardAmount: yipayPayuniRecurring,
                    })
                  }
                >
                  {yipayPayuniRecurring && paySelected.includes('YIPAY')
                    ? '確認：乙禾首期 → PayUNi 約定'
                    : paySelected.includes('YIPAY')
                      ? '確認並現場刷卡'
                      : paySelected.includes('CARD')
                        ? '確認並開 PayUNi 定期'
                        : paySelected.includes('LINEPAY')
                          ? '確認並 LinePay POS'
                          : '確認結帳'}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </PageSection>
      )}

      {tab === 'members' && (
      <PageSection title="會員管理" desc={`共 ${members.length} 位會員`}>
        {selectedMember ? (
          <Alert tone="info">
            已選會員 {selectedMember.memberNo || `#${selectedMember.id}`} {selectedMember.name}
            <span style={{ marginLeft: '0.75rem', display: 'inline-flex', gap: '0.4rem' }}>
              <Button size="sm" onClick={() => openEditModal(selectedMember)}>
                編輯此會員
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void openFaceModal(selectedMember)}
                disabled={!selectedMember.faceEnabled || !selectedMember.allowBiometrics}
                title={
                  !selectedMember.faceEnabled
                    ? '請先勾選啟用人臉辨識'
                    : selectedMember.allowBiometrics
                      ? '綁定人臉'
                      : '需先簽署生物辨識同意書'
                }
              >
                綁定人臉
              </Button>
            </span>
          </Alert>
        ) : (
          <Alert tone="warning">請先於上方以電話／QR／人臉選擇會員，或從下方列表點「編輯」</Alert>
        )}
        <OpsMemberAdminPanel
          member={selectedMember}
          onMemberUpdated={(updated) => patchMember(updated)}
          posDisplay={posDisplay}
          staffId={staff?.id ?? null}
          branchCode={
            posBranchId !== ''
              ? String(
                  staffBranchLabel(branches.find((b) => b.id === posBranchId)) ||
                    posBranchId,
                )
              : staff?.branchName || String(staff?.branchId || '—')
          }
        />
        <div className="table-toolbar">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋姓名、電話、ID、LINE、會員編號…"
            style={{ maxWidth: 320 }}
          />
          <span className="text-muted text-sm" style={{ marginLeft: '0.75rem' }}>
            {membersLoading ? '載入中…' : `共 ${membersTotal} 位`}
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto' }}>
            <Button variant="ghost" size="sm" onClick={() => void loadData()}>
              重新整理
            </Button>
            <Button size="sm" onClick={openCreateModal}>
              手動新增會員
            </Button>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>會員編號</th>
                <th>姓名</th>
                <th>電話</th>
                <th>綁定分店</th>
                <th>方案</th>
                <th>效期</th>
                <th>零錢包</th>
                <th>運動金</th>
                <th>合約</th>
                <th>警示</th>
                <th>LINE</th>
                <th>裝置</th>
                <th>人臉</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td colSpan={14} className="text-center text-muted" style={{ padding: '2rem' }}>
                    {membersLoading ? '載入中…' : '找不到符合的會員'}
                  </td>
                </tr>
              ) : (
                members.map((m) => (
                  <tr
                    key={m.id}
                    className={`${m.isAlert ? 'row-alert' : ''}${selectedMember?.id === m.id ? ' row-selected' : ''}`}
                  >
                    <td className="mono text-sm">{m.memberNo || `#${m.id}`}</td>
                    <td>
                      <strong>{m.name}</strong>
                    </td>
                    <td>
                      <span className="mono">{m.phone || '—'}</span>
                    </td>
                    <td className="text-sm">
                      {(m.branches || []).length === 0 ? (
                        <Badge tone="warning">未綁</Badge>
                      ) : (
                        (m.branches || [])
                          .map((b) => staffBranchLabel(b.branch) || b.branch?.name || `#${b.branchId}`)
                          .join('、')
                      )}
                    </td>
                    <td>{m.planName || formatPlanLabel(m.plan)}</td>
                    <td className="text-sm">{formatExpireLabel(m.plan, m.expireDate)}</td>
                    <td style={{ color: 'var(--success)' }}>${m.cashWallet}</td>
                    <td style={{ color: 'var(--accent-gold)' }}>${m.bonusWallet}</td>
                    <td>
                      {(m.contracts || []).length === 0 ? (
                        <span className="text-muted text-sm">—</span>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                          {(m.contracts || []).map((c) => (
                            <button
                              key={c.contractId}
                              type="button"
                              className={contractToneClass(c.tone)}
                              title={`${c.displayName || c.shortName || c.title} · ${contractToneLabel(c)}`}
                              onClick={() => void openContractFromList(m, c)}
                            >
                              {c.displayName || c.shortName || c.title}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>{m.isAlert ? <Badge tone="danger" dot>警示</Badge> : '—'}</td>
                    <td>
                      <Badge tone={m.lineId || m.hasLineBound ? 'success' : 'neutral'}>
                        {m.lineId || m.hasLineBound ? '已綁' : '未綁'}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={m.deviceId || m.hasDeviceBound ? 'success' : 'neutral'}>
                        {m.deviceId || m.hasDeviceBound ? '已綁' : '未綁'}
                      </Badge>
                    </td>
                    <td>
                      <Badge
                        tone={
                          m.papagoFaceId || m.hasFaceBound
                            ? 'success'
                            : m.faceEnabled
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {m.papagoFaceId || m.hasFaceBound
                          ? 'OK'
                          : m.faceEnabled
                            ? '啟用未綁'
                            : '未啟用'}
                      </Badge>
                    </td>
                    <td className="table-actions">
                      <Button variant="secondary" size="sm" onClick={() => openEditModal(m)}>
                        編輯
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openFaceModal(m)}
                        disabled={!m.faceEnabled || !m.allowBiometrics}
                        title={
                          !m.faceEnabled
                            ? '請先勾選啟用人臉辨識'
                            : m.allowBiometrics
                              ? '人臉註冊'
                              : '需先簽署生物辨識同意書'
                        }
                      >
                        人臉
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {members.length < membersTotal ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
            <Button
              variant="secondary"
              size="sm"
              disabled={membersLoadingMore}
              onClick={() => void loadMembers({ append: true, skip: members.length })}
            >
              {membersLoadingMore ? '載入中…' : '載入更多'}
            </Button>
          </div>
        ) : null}
      </PageSection>
      )}

      {tab === 'orders' && <OrdersQueryPage />}
      </div>

      <Modal
        open={pendingPeriodPay !== null}
        title={pendingPeriodPay?.bindOnly ? '等待定期定額約定' : '等待續期收款入帳'}
        onClose={() => {
          if (pendingPeriodStatus === 'PAID' || pendingPeriodStatus === 'BOUND') {
            setPendingPeriodPay(null);
            return;
          }
          setPendingPeriodPay(null);
          toast(
            pendingPeriodPay?.bindOnly
              ? '已關閉等待視窗；若稍後 Notify 回寫約定，可至定期定額一覽確認'
              : '已關閉等待視窗；若稍後 Notify 入帳，可至訂單查詢確認',
            'info',
          );
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setPendingPeriodPay(null)}
              disabled={pendingPeriodChecking}
            >
              稍後再查
            </Button>
            <Button
              loading={pendingPeriodChecking}
              onClick={() => void pollPendingPeriodPay({ manual: true })}
            >
              {pendingPeriodPay?.bindOnly ? '我已完成約定' : '我已完成付款'}
            </Button>
          </>
        }
      >
        <Alert tone="info">
          {pendingPeriodPay?.bindOnly ? (
            <>
              PayUNi「續期收款」頁將做<strong>$1 驗證授權</strong>確認卡片（乙禾已收方案首期）；授權隨後取消、<strong>不實際扣款</strong>；第 2 期起依 PeriodAmt 原價。成功頁<strong>不會</strong>
              回流本系統。請保持此櫃檯頁開啟；約定完成後金流以 Notify 回寫（CreditHash 或 PeriodTradeNo），本頁每 2.5 秒自動查詢。
            </>
          ) : (
            <>
              PayUNi「續期收款」成功頁<strong>不會</strong>回流本系統（僅有買家專區連結）。請保持此櫃檯頁開啟；金流會以
              Notify 背景通知入帳，本頁每 2.5 秒自動查詢狀態。
            </>
          )}
        </Alert>
        <p style={{ marginTop: '0.75rem' }}>
          單號：<strong>{pendingPeriodPay?.label || pendingPeriodPay?.ref}</strong>
        </p>
        <p>
          狀態：{' '}
          <Badge
            tone={
              pendingPeriodStatus === 'PAID' || pendingPeriodStatus === 'BOUND'
                ? 'success'
                : 'warning'
            }
          >
            {pendingPeriodStatus === 'BOUND'
              ? '已約定'
              : pendingPeriodStatus === 'PAID'
                ? '已入帳'
                : pendingPeriodStatus === 'WAITING_BIND'
                  ? '等待約定 Notify…'
                  : '等待 Notify…'}
          </Badge>
        </p>
      </Modal>

      <Modal
        open={pendingYipay !== null}
        title="乙禾現場刷卡確認"
        onClose={() => {
          if (yipayConfirmBusy) return;
          setPendingYipay(null);
          toast('已取消確認；結帳單仍為待付款，可稍後以單號補確認或作廢', 'info');
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setPendingYipay(null)}
              disabled={yipayConfirmBusy}
            >
              稍後處理
            </Button>
            <Button loading={yipayConfirmBusy} onClick={() => void handleConfirmYipay()}>
              確認刷卡成功
            </Button>
          </>
        }
      >
        <Alert tone="info">
          請於{pendingYipay?.hint || '乙禾／凱基固定式刷卡機'}完成首期收款後，再按「確認刷卡成功」。系統將履約並開立
          ezPay 發票；開票失敗＝整筆取消。
          {pendingYipay?.needsPeriodBind
            ? ` 確認後將另開 PayUNi 續期頁（$1 驗證授權後取消、不請款；第 2 期起 PeriodAmt $${Math.round(pendingYipay.recurringAmount || 0).toLocaleString('zh-TW')} × ${pendingYipay.periodTimes || '?'} 期）。`
            : ''}
        </Alert>
        <p style={{ marginTop: '0.75rem' }}>
          結帳單：<strong>{pendingYipay?.checkoutId}</strong>
        </p>
        <p>
          刷卡金額：<strong>${Math.round(pendingYipay?.amount || 0).toLocaleString('zh-TW')}</strong>
        </p>
        <Field label="端末序號／授權碼（選填）">
          <Input
            value={yipayTerminalRef}
            onChange={(e) => setYipayTerminalRef(e.target.value)}
            placeholder="可留空"
            disabled={yipayConfirmBusy}
          />
        </Field>
      </Modal>

      <Modal
        open={createOpen}
        title="手動新增會員"
        onClose={closeMemberModals}
        footer={
          <>
            <Button variant="ghost" onClick={closeMemberModals} disabled={saving}>
              取消
            </Button>
            <Button onClick={handleCreateMember} loading={saving}>
              確認開卡
            </Button>
          </>
        }
      >
        {memberFormFields}
      </Modal>

      <Modal
        open={editingMember !== null}
        title={editingMember ? `編輯會員 · #${editingMember.id}` : '編輯會員'}
        onClose={closeMemberModals}
        footer={
          <>
            <Button variant="ghost" onClick={closeMemberModals} disabled={saving || binding}>
              取消
            </Button>
            <Button onClick={handleUpdateMember} loading={saving}>
              儲存變更
            </Button>
          </>
        }
      >
        {memberFormFields}
      </Modal>

      <Modal
        open={faceMemberId !== null}
        title={`PAPAGO 人臉註冊 · ${faceMemberName}`}
        onClose={closeFaceModal}
        footer={
          <>
            <Button variant="ghost" onClick={closeFaceModal}>
              取消
            </Button>
            <Button onClick={captureAndBind}>拍攝並綁定</Button>
          </>
        }
      >
        <Alert tone="info">
          流程：編輯勾選「啟用人臉辨識」→簽署「生物辨識同意書」→再於此綁定人臉
        </Alert>
        <video ref={videoRef} autoPlay playsInline muted className="face-video" />
        <canvas ref={canvasRef} hidden />
      </Modal>

      <Modal
        open={signMember !== null && signDetail !== null}
        title={
          signDetail
            ? `合約簽署 · ${signDetail.contractDisplayName || signDetail.contractShortName || signDetail.contractTitle || ''} ${
                (historyPreviewId != null
                  ? signHistory.find((h) => h.id === historyPreviewId)?.versionLabel ||
                    (signHistory.find((h) => h.id === historyPreviewId)?.version != null
                      ? `v${signHistory.find((h) => h.id === historyPreviewId)?.version}`
                      : '')
                  : signDetail.versionLabel ||
                    (signDetail.version != null ? `v${signDetail.version}` : '')) || ''
              }`
            : '合約簽署'
        }
        onClose={closeSignModal}
        footer={
          <>
            <Button variant="ghost" onClick={closeSignModal} disabled={signBusy}>
              關閉
            </Button>
            {signDetail?.status === 'SIGNED' && historyPreviewId == null && (
              <Button
                variant="secondary"
                loading={signBusy}
                disabled={signBusy}
                onClick={() => void handleResignContract()}
              >
                合約重簽
              </Button>
            )}
            {signDetail?.status !== 'SIGNED' && historyPreviewId == null && (
              <>
                <Button
                  variant="secondary"
                  disabled={signBusy || !signDetail?.body}
                  onClick={sendContractConsentToDisplay}
                >
                  派送客顯簽署
                </Button>
                <Button
                  loading={signBusy}
                  disabled={!signatureData || signBusy || !signMember || !signDetail}
                  onClick={() => {
                    if (!signMember || !signDetail) return;
                    void handleSignContract(signMember.id, signDetail.id);
                  }}
                >
                  完成簽署並存檔
                </Button>
              </>
            )}
          </>
        }
      >
        {signDetail && (() => {
          const preview =
            historyPreviewId != null
              ? signHistory.find((h) => h.id === historyPreviewId) || signDetail
              : signDetail;
          const viewingCurrent = historyPreviewId == null || historyPreviewId === signDetail.id;
          const canSignNow = viewingCurrent && preview.status !== 'SIGNED';
          const needsResign =
            canSignNow &&
            signHistory.some(
              (h) => h.status === 'SIGNED' && h.contractVersionId !== signDetail.contractVersionId,
            );

          return (
            <div className="form-stack">
              {needsResign ? (
                <Alert tone="warning">
                  合約版本已更新，此會員須重新簽署目前版本後方可繼續使用相關權益。
                </Alert>
              ) : null}
              <p className="text-muted text-sm" style={{ margin: 0 }}>
                會員 {signMember?.memberNo || `#${signMember?.id}`} {signMember?.name}
                {!viewingCurrent
                  ? preview.status === 'SIGNED'
                    ? ' · 版本過期'
                    : ' · 歷程預覽'
                  : preview.status === 'SIGNED'
                    ? ' · 已簽署'
                    : needsResign
                      ? ' · 需重新簽署'
                      : ' · 請會員閱讀後簽名'}
              </p>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  margin: 0,
                  fontFamily: 'inherit',
                  fontSize: '0.85rem',
                  maxHeight: 260,
                  overflow: 'auto',
                  background: 'var(--surface-2, #f8fafc)',
                  padding: '0.75rem',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                {preview.body || '（無內容）'}
              </pre>
              {preview.status === 'SIGNED' && preview.signatureData ? (
                <div>
                  <p className="text-muted text-sm">
                    簽署於{' '}
                    {preview.signedAt
                      ? new Date(preview.signedAt).toLocaleString('zh-TW')
                      : '—'}
                  </p>
                  <img
                    src={preview.signatureData}
                    alt="會員簽名"
                    style={{
                      maxWidth: '100%',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      background: '#fff',
                    }}
                  />
                </div>
              ) : canSignNow ? (
                <div className="field">
                  <span className="field__label">會員電子簽名（本機或客顯回傳）</span>
                  {posDisplay.pendingConsentId && (
                    <Alert tone="warning">等待客顯簽署中…</Alert>
                  )}
                  <SignaturePad key={signDetail.id} onChange={setSignatureData} />
                </div>
              ) : (
                <p className="text-muted text-sm">此版本尚無簽名存檔</p>
              )}

              <div className="form-stack" style={{ gap: '0.35rem' }}>
                <strong style={{ fontSize: '0.9rem' }}>簽約版本歷程</strong>
                {signHistory.length === 0 ? (
                  <p className="text-muted text-sm" style={{ margin: 0 }}>
                    尚無簽署紀錄
                  </p>
                ) : (
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: 0,
                      padding: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.35rem',
                    }}
                  >
                    {signHistory.map((h) => {
                      const active =
                        (historyPreviewId == null && h.id === signDetail.id) ||
                        historyPreviewId === h.id;
                      const isCurrentVersion =
                        h.id === signDetail.id ||
                        h.contractVersionId === signDetail.contractVersionId;
                      const statusLabel = isCurrentVersion
                        ? h.status === 'SIGNED'
                          ? '已簽署'
                          : '待簽署'
                        : '版本過期';
                      return (
                        <li key={h.id}>
                          <button
                            type="button"
                            onClick={() =>
                              setHistoryPreviewId(h.id === signDetail.id ? null : h.id)
                            }
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              padding: '0.5rem 0.65rem',
                              border: `1px solid ${active ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
                              borderRadius: 'var(--radius-sm)',
                              background: active
                                ? 'var(--surface-2, #f8fafc)'
                                : 'transparent',
                              cursor: 'pointer',
                              font: 'inherit',
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>
                              {h.versionLabel ||
                                (h.version != null ? `v${h.version}` : '—')}
                            </span>
                            {' · '}
                            <span
                              style={
                                statusLabel === '版本過期'
                                  ? { color: 'var(--text-muted)' }
                                  : statusLabel === '已簽署'
                                    ? { color: '#166534' }
                                    : undefined
                              }
                            >
                              {statusLabel}
                            </span>
                            {h.signedAt
                              ? ` · ${new Date(h.signedAt).toLocaleString('zh-TW')}`
                              : ''}
                            {h.changeNote ? (
                              <span className="text-muted text-sm">
                                {' '}
                                · {h.changeNote}
                              </span>
                            ) : null}
                            {isCurrentVersion ? (
                              <span className="text-muted text-sm"> · 目前版本</span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
