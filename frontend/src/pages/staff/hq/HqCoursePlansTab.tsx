import { type FormEvent, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createHqCoursePlan,
  deleteHqCoursePlan,
  fetchHqContracts,
  getErrorMessage,
  updateHqCoursePlan,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import {
  formatPromotionSchedule,
  getCampaignStatus,
  PLAN_MODE_LABELS,
  toDatetimeLocalValue,
  type PromotionPlanMode,
} from '../../../lib/promotionLabels';
import type { CoursePlan, MembershipContract, Product } from '../../../types/api';
import type { HqDataProps } from './types';

type CoursePlanType = 'CUSTOM_PT' | 'GROUP';

const COURSE_PLAN_TYPE_LABELS: Record<CoursePlanType, string> = {
  CUSTOM_PT: '私教',
  GROUP: '團課',
};

function toIsoOrNull(local: string) {
  if (!local.trim()) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 單堂售價 × 堂數 → 總售價（後端仍存總價） */
function calcSessionTotal(unitPriceRaw: string, sessionsRaw: string) {
  const unit = parseFloat(unitPriceRaw);
  const sessions = parseInt(sessionsRaw, 10);
  if (!Number.isFinite(unit) || unit < 0 || !Number.isInteger(sessions) || sessions <= 0) {
    return null;
  }
  return Math.round(unit * sessions * 100) / 100;
}

function formatMoney(n: number) {
  return `$${n.toLocaleString('zh-TW')}`;
}

/** recurringPeriods bitmask：2＝可選2期、4＝可選4期、6＝兩者 */
function decodeRecurringMask(raw: number | null | undefined) {
  const n = Number(raw) || 0;
  return { allow2: (n & 2) !== 0, allow4: (n & 4) !== 0 };
}

function encodeRecurringMask(allow2: boolean, allow4: boolean) {
  let mask = 0;
  if (allow2) mask |= 2;
  if (allow4) mask |= 4;
  return mask > 0 ? mask : null;
}

/** 4 期第1~3期金額：優先 recurringAmount4；舊資料僅4期時落在 recurringAmount */
function resolveAmount4Base(p: {
  recurringPeriods?: number | null;
  recurringAmount?: number | null;
  recurringAmount4?: number | null;
}) {
  if (p.recurringAmount4 != null && Number(p.recurringAmount4) > 0) {
    return Number(p.recurringAmount4);
  }
  const { allow2, allow4 } = decodeRecurringMask(p.recurringPeriods);
  if (allow4 && !allow2 && p.recurringAmount != null && Number(p.recurringAmount) > 0) {
    return Number(p.recurringAmount);
  }
  return null;
}

function formatRecurringLabel(p: {
  enableCardRecurring?: boolean;
  recurringPeriods?: number | null;
  price?: number;
  recurringAmount?: number | null;
  recurringAmount4?: number | null;
  recurringAmountFinal?: number | null;
}) {
  if (!p.enableCardRecurring) return '否';
  const { allow2, allow4 } = decodeRecurringMask(p.recurringPeriods);
  if (!allow2 && !allow4) return '—';
  const parts: string[] = [];
  if (allow2) {
    const second = p.recurringAmount != null ? Number(p.recurringAmount) : null;
    const first =
      second != null ? (Number(p.price) || 0) - second : null;
    parts.push(
      `2期 · 第1期 ${first != null ? formatMoney(first) : '—'} · 第2期 ${
        second != null ? formatMoney(second) : '—'
      }`,
    );
  }
  if (allow4) {
    const base = resolveAmount4Base(p);
    const final =
      p.recurringAmountFinal != null ? Number(p.recurringAmountFinal) : null;
    parts.push(
      `4期 · 第1-3期 ${base != null ? formatMoney(base) : '—'} · 第4期 ${
        final != null ? formatMoney(final) : '—'
      }`,
    );
  }
  return parts.join(' ／ ');
}

function toCents(v: number) {
  return Math.round(v * 100);
}

function unitPriceFromTotal(total: number, sessions: number | null | undefined) {
  if (!sessions || sessions <= 0) return String(total);
  const unit = Math.round((total / sessions) * 100) / 100;
  return String(unit);
}

/** 加贈禮選單：依分店啟用中商品去重品名 */
function giftOptionsFromProducts(products: Product[], branchIds: number[]) {
  const idSet = new Set(branchIds);
  const names = new Set<string>();
  for (const p of products) {
    if (!p.isActive) continue;
    if (idSet.size && !idSet.has(p.branchId)) continue;
    const name = String(p.name || '').trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

type Props = Pick<HqDataProps, 'branches' | 'coursePlans' | 'products' | 'onReload'>;

export default function HqCoursePlansTab({ branches, coursePlans, products, onReload }: Props) {
  const { toast } = useToast();
  const activeBranches = branches.filter((b) => b.isActive);
  const [branchIds, setBranchIds] = useState<number[]>(
    activeBranches[0] ? [activeBranches[0].id] : [],
  );
  const [name, setName] = useState('');
  const [planKind, setPlanKind] = useState<'SALE' | 'COMPENSATION'>('SALE');
  const [planType, setPlanType] = useState<CoursePlanType>('CUSTOM_PT');
  const [planMode, setPlanMode] = useState<PromotionPlanMode>('STANDING');
  const [saleStart, setSaleStart] = useState('');
  const [saleEnd, setSaleEnd] = useState('');
  /** 單堂售價（私教／團體皆：單堂 × 堂數 ＝ 總售價） */
  const [unitPrice, setUnitPrice] = useState('1000');
  const [sessions, setSessions] = useState('10');
  const [capacity, setCapacity] = useState('8');
  const [description, setDescription] = useState('');
  const [cardRecurring, setCardRecurring] = useState(false);
  const [allowRecurring2, setAllowRecurring2] = useState(false);
  const [allowRecurring4, setAllowRecurring4] = useState(false);
  const [recurring2FirstStr, setRecurring2FirstStr] = useState('');
  const [recurring2SecondStr, setRecurring2SecondStr] = useState('');
  const [recurring4BaseStr, setRecurring4BaseStr] = useState('');
  const [recurring4FinalStr, setRecurring4FinalStr] = useState('');
  const [requiresContract, setRequiresContract] = useState(false);
  const [contractIds, setContractIds] = useState<number[]>([]);
  const [enableSecondPerson, setEnableSecondPerson] = useState(false);
  const [giftLabel, setGiftLabel] = useState('');
  const [giftQty, setGiftQty] = useState('1');
  const [activeContracts, setActiveContracts] = useState<MembershipContract[]>([]);
  const [filterBranchId, setFilterBranchId] = useState<number | ''>('');

  const [editing, setEditing] = useState<CoursePlan | null>(null);
  const [editName, setEditName] = useState('');
  const [editPlanType, setEditPlanType] = useState<CoursePlanType>('CUSTOM_PT');
  const [editPlanMode, setEditPlanMode] = useState<PromotionPlanMode>('STANDING');
  const [editSaleStart, setEditSaleStart] = useState('');
  const [editSaleEnd, setEditSaleEnd] = useState('');
  const [editUnitPrice, setEditUnitPrice] = useState('');
  const [editSessions, setEditSessions] = useState('');
  const [editCapacity, setEditCapacity] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCardRecurring, setEditCardRecurring] = useState(false);
  const [editAllowRecurring2, setEditAllowRecurring2] = useState(false);
  const [editAllowRecurring4, setEditAllowRecurring4] = useState(false);
  const [editRecurring2FirstStr, setEditRecurring2FirstStr] = useState('');
  const [editRecurring2SecondStr, setEditRecurring2SecondStr] = useState('');
  const [editRecurring4BaseStr, setEditRecurring4BaseStr] = useState('');
  const [editRecurring4FinalStr, setEditRecurring4FinalStr] = useState('');
  const [editRequiresContract, setEditRequiresContract] = useState(false);
  const [editContractIds, setEditContractIds] = useState<number[]>([]);
  const [editEnableSecondPerson, setEditEnableSecondPerson] = useState(false);
  const [editGiftLabel, setEditGiftLabel] = useState('');
  const [editGiftQty, setEditGiftQty] = useState('1');
  const [editActive, setEditActive] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const createTotal = calcSessionTotal(unitPrice, sessions);
  const editTotal = calcSessionTotal(editUnitPrice, editSessions);
  const createGiftOptions = giftOptionsFromProducts(products, branchIds);
  const editGiftOptions = giftOptionsFromProducts(
    products,
    editing?.branchId ? [editing.branchId] : [],
  );
  /** 分店變更後若原加贈禮不在選單內，視為未選（不另用 effect 清 state） */
  const effectiveGiftLabel = createGiftOptions.includes(giftLabel) ? giftLabel : '';

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await fetchHqContracts('ACTIVE');
        if (!cancelled && res.status === 'success' && res.data) setActiveContracts(res.data);
      } catch {
        /* 方案頁可無合約時仍運作 */
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = filterBranchId
    ? coursePlans.filter((p) => p.branchId === filterBranchId)
    : coursePlans;

  function toggleBranch(id: number) {
    setBranchIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function toggleAllBranches() {
    if (branchIds.length === activeBranches.length) setBranchIds([]);
    else setBranchIds(activeBranches.map((b) => b.id));
  }

  function toggleContractId(
    id: number,
    current: number[],
    setter: (v: number[]) => void,
  ) {
    setter(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (branchIds.length === 0) {
      toast('請至少選擇一間分店', 'error');
      return;
    }
    const isCompensation = planKind === 'COMPENSATION';
    if (isCompensation && planType !== 'CUSTOM_PT') {
      toast('客訴補償課程僅限客製化私教', 'error');
      return;
    }
    if (planMode === 'CAMPAIGN' && saleStart && saleEnd && saleEnd <= saleStart) {
      toast('活動下架時間必須晚於上架時間', 'error');
      return;
    }
    if (!sessions || parseInt(sessions, 10) <= 0) {
      toast(planType === 'GROUP' ? '團體課程必須設定期班堂數' : '客製化私教必須設定堂數', 'error');
      return;
    }
    if (!isCompensation && createTotal == null) {
      toast('請填寫有效的單堂售價與堂數', 'error');
      return;
    }
    if (planType === 'GROUP' && (!capacity || parseInt(capacity, 10) <= 0)) {
      toast('團體課程必須設定人數上限', 'error');
      return;
    }
    if (requiresContract && contractIds.length === 0) {
      toast('需簽署會員合約時，請至少選擇一份合約', 'error');
      return;
    }
    const price = isCompensation ? 0 : Number(createTotal);

    if (!isCompensation && cardRecurring) {
      if (!allowRecurring2 && !allowRecurring4) {
        toast('請至少勾選 2 期或 4 期', 'error');
        return;
      }
      if (allowRecurring2) {
        const first = recurring2FirstStr ? parseFloat(recurring2FirstStr) : NaN;
        const second = recurring2SecondStr ? parseFloat(recurring2SecondStr) : NaN;
        if (!Number.isFinite(first) || first <= 0) {
          toast('請填寫 2 期方案的第1期扣款金額', 'error');
          return;
        }
        if (!Number.isFinite(second) || second <= 0) {
          toast('請填寫 2 期方案的第2期扣款金額', 'error');
          return;
        }
        if (toCents(first + second) !== toCents(price)) {
          toast('2 期：第1期 + 第2期金額加總必須等於總售價', 'error');
          return;
        }
      }
      if (allowRecurring4) {
        const base = recurring4BaseStr ? parseFloat(recurring4BaseStr) : NaN;
        const finalAmt = recurring4FinalStr ? parseFloat(recurring4FinalStr) : NaN;
        if (!Number.isFinite(base) || base <= 0) {
          toast('請填寫 4 期方案的第1~3期扣款金額', 'error');
          return;
        }
        if (!Number.isFinite(finalAmt) || finalAmt <= 0) {
          toast('請填寫 4 期方案的第4期扣款金額', 'error');
          return;
        }
        if (toCents(3 * base + finalAmt) !== toCents(price)) {
          toast('4 期：第1~3期共用 ×3 + 第4期金額加總必須等於總售價', 'error');
          return;
        }
      }
    }
    try {
      const result = await createHqCoursePlan({
        branchIds,
        name: name.trim(),
        kind: planKind,
        planType: isCompensation ? 'CUSTOM_PT' : planType,
        planMode,
        saleStartAt: planMode === 'CAMPAIGN' ? toIsoOrNull(saleStart) : null,
        saleEndAt: planMode === 'CAMPAIGN' ? toIsoOrNull(saleEnd) : null,
        price,
        sessions: parseInt(sessions, 10),
        capacity:
          isCompensation || planType !== 'GROUP'
            ? null
            : parseInt(capacity, 10),
        description: description.trim() || null,
        enableCardRecurring: isCompensation ? false : cardRecurring,
        recurringPeriods:
          !isCompensation && cardRecurring
            ? encodeRecurringMask(allowRecurring2, allowRecurring4)
            : null,
        recurringAmount:
          !isCompensation && cardRecurring && allowRecurring2
            ? parseFloat(recurring2SecondStr)
            : null,
        recurringAmount4:
          !isCompensation && cardRecurring && allowRecurring4
            ? parseFloat(recurring4BaseStr)
            : null,
        recurringAmountFinal:
          !isCompensation && cardRecurring && allowRecurring4
            ? parseFloat(recurring4FinalStr)
            : null,
        requiresMemberContract: isCompensation ? false : requiresContract,
        enableSecondPerson: isCompensation ? false : enableSecondPerson,
        giftLabel: isCompensation ? null : effectiveGiftLabel || null,
        giftQty:
          isCompensation || !effectiveGiftLabel
            ? null
            : Math.max(1, parseInt(giftQty, 10) || 1),
        contractIds: isCompensation || !requiresContract ? [] : contractIds,
      });
      toast(result.message || '課程方案已建立', 'success');
      setName('');
      setPlanKind('SALE');
      setUnitPrice('1000');
      setSessions('10');
      setDescription('');
      setCardRecurring(false);
      setRequiresContract(false);
      setContractIds([]);
      setEnableSecondPerson(false);
      setGiftLabel('');
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '建立課程方案失敗'), 'error');
    }
  }

  function openEdit(p: CoursePlan) {
    setEditing(p);
    setEditName(p.name);
    setEditPlanType(p.planType === 'GROUP' ? 'GROUP' : 'CUSTOM_PT');
    setEditPlanMode(p.planMode === 'CAMPAIGN' ? 'CAMPAIGN' : 'STANDING');
    setEditSaleStart(toDatetimeLocalValue(p.saleStartAt));
    setEditSaleEnd(toDatetimeLocalValue(p.saleEndAt));
    setEditSessions(p.sessions ? String(p.sessions) : '');
    setEditCapacity(p.capacity ? String(p.capacity) : '');
    setEditUnitPrice(unitPriceFromTotal(Number(p.price) || 0, p.sessions));
    setEditDescription(p.description || '');
    setEditCardRecurring(Boolean(p.enableCardRecurring));
    const { allow2, allow4 } = decodeRecurringMask(p.recurringPeriods);
    setEditAllowRecurring2(allow2);
    setEditAllowRecurring4(allow4);
    setEditRecurring2SecondStr(
      allow2 && p.recurringAmount != null ? String(p.recurringAmount) : '',
    );
    setEditRecurring2FirstStr(
      allow2 && p.recurringAmount != null
        ? String(Number(p.price || 0) - Number(p.recurringAmount || 0))
        : '',
    );
    const amount4Base = resolveAmount4Base(p);
    setEditRecurring4BaseStr(allow4 && amount4Base != null ? String(amount4Base) : '');
    setEditRecurring4FinalStr(
      allow4 && p.recurringAmountFinal != null ? String(p.recurringAmountFinal) : '',
    );
    setEditRequiresContract(Boolean(p.requiresMemberContract));
    setEditContractIds((p.contracts || []).map((c) => c.id));
    setEditEnableSecondPerson(Boolean(p.enableSecondPerson));
    setEditGiftLabel(p.giftLabel || '');
    setEditGiftQty(p.giftQty && p.giftQty > 0 ? String(p.giftQty) : '1');
    setEditActive(p.isActive !== false);
  }

  async function handleUpdate(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    if (editPlanMode === 'CAMPAIGN' && editSaleStart && editSaleEnd && editSaleEnd <= editSaleStart) {
      toast('活動下架時間必須晚於上架時間', 'error');
      return;
    }
    if (!editSessions || parseInt(editSessions, 10) <= 0) {
      toast(
        editPlanType === 'GROUP' ? '團體課程必須設定期班堂數' : '客製化私教必須設定堂數',
        'error',
      );
      return;
    }
    if (editTotal == null) {
      toast('請填寫有效的單堂售價與堂數', 'error');
      return;
    }
    if (editPlanType === 'GROUP' && (!editCapacity || parseInt(editCapacity, 10) <= 0)) {
      toast('團體課程必須設定人數上限', 'error');
      return;
    }
    if (editRequiresContract && editContractIds.length === 0) {
      toast('需簽署會員合約時，請至少選擇一份合約', 'error');
      return;
    }
    const price = Number(editTotal);

    if (editCardRecurring) {
      if (!editAllowRecurring2 && !editAllowRecurring4) {
        toast('請至少勾選 2 期或 4 期', 'error');
        return;
      }
      if (editAllowRecurring2) {
        const first = editRecurring2FirstStr ? parseFloat(editRecurring2FirstStr) : NaN;
        const second = editRecurring2SecondStr ? parseFloat(editRecurring2SecondStr) : NaN;
        if (!Number.isFinite(first) || first <= 0) {
          toast('請填寫 2 期方案的第1期扣款金額', 'error');
          return;
        }
        if (!Number.isFinite(second) || second <= 0) {
          toast('請填寫 2 期方案的第2期扣款金額', 'error');
          return;
        }
        if (toCents(first + second) !== toCents(price)) {
          toast('2 期：第1期 + 第2期金額加總必須等於總售價', 'error');
          return;
        }
      }
      if (editAllowRecurring4) {
        const base = editRecurring4BaseStr ? parseFloat(editRecurring4BaseStr) : NaN;
        const finalAmt = editRecurring4FinalStr ? parseFloat(editRecurring4FinalStr) : NaN;
        if (!Number.isFinite(base) || base <= 0) {
          toast('請填寫 4 期方案的第1~3期扣款金額', 'error');
          return;
        }
        if (!Number.isFinite(finalAmt) || finalAmt <= 0) {
          toast('請填寫 4 期方案的第4期扣款金額', 'error');
          return;
        }
        if (toCents(3 * base + finalAmt) !== toCents(price)) {
          toast('4 期：第1~3期共用 ×3 + 第4期金額加總必須等於總售價', 'error');
          return;
        }
      }
    }
    try {
      const result = await updateHqCoursePlan(editing.id, {
        name: editName.trim(),
        planType: editPlanType,
        planMode: editPlanMode,
        saleStartAt: editPlanMode === 'CAMPAIGN' ? toIsoOrNull(editSaleStart) : null,
        saleEndAt: editPlanMode === 'CAMPAIGN' ? toIsoOrNull(editSaleEnd) : null,
        price,
        sessions: parseInt(editSessions, 10),
        capacity:
          editPlanType === 'GROUP'
            ? parseInt(editCapacity, 10)
            : editCapacity
              ? parseInt(editCapacity, 10)
              : null,
        description: editDescription.trim() || null,
        enableCardRecurring: editCardRecurring,
        recurringPeriods: editCardRecurring
          ? encodeRecurringMask(editAllowRecurring2, editAllowRecurring4)
          : null,
        recurringAmount:
          editCardRecurring && editAllowRecurring2
            ? parseFloat(editRecurring2SecondStr)
            : null,
        recurringAmount4:
          editCardRecurring && editAllowRecurring4
            ? parseFloat(editRecurring4BaseStr)
            : null,
        recurringAmountFinal:
          editCardRecurring && editAllowRecurring4
            ? parseFloat(editRecurring4FinalStr)
            : null,
        requiresMemberContract: editRequiresContract,
        enableSecondPerson: editEnableSecondPerson,
        giftLabel: editGiftLabel.trim() || null,
        giftQty: editGiftLabel.trim() ? parseInt(editGiftQty, 10) || 1 : null,
        contractIds: editRequiresContract ? editContractIds : [],
        isActive: editActive,
      });
      toast(result.message || '課程方案已更新', 'success');
      setEditing(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '更新課程方案失敗'), 'error');
    }
  }

  async function handleDelete(p: CoursePlan) {
    const msg = p.isActive
      ? `確定刪除課程方案「${p.name}」？\n將先下架；已下架者再刪一次會永久移除。`
      : `課程方案「${p.name}」已下架，確定永久刪除？`;
    if (!window.confirm(msg)) return;
    setBusyId(p.id);
    try {
      const result = await deleteHqCoursePlan(p.id);
      toast(result.message || '課程方案已處理', 'success');
      if (editing?.id === p.id) setEditing(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '刪除課程方案失敗'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageSection
      title="課程方案"
      desc="客製化私教／團體課程商品化上架 · 客訴補償課程（price $0）僅經「合規補償」配發，不進 POS"
    >
      <div className="staff-grid">
        <Card title="新增課程">
          <form className="form-stack" onSubmit={handleCreate}>
            <Field label="適用分店" hint="可多選；每間分店會各建立一筆相同條件的方案">
              <div className="checkbox-group">
                {activeBranches.length > 1 && (
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={branchIds.length === activeBranches.length && activeBranches.length > 0}
                      onChange={toggleAllBranches}
                    />
                    全選
                  </label>
                )}
                {activeBranches.map((b) => (
                  <label key={b.id} className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={branchIds.includes(b.id)}
                      onChange={() => toggleBranch(b.id)}
                    />
                    {staffBranchLabel(b)}
                  </label>
                ))}
                {activeBranches.length === 0 && (
                  <span className="text-muted text-sm">尚無啟用中的分店</span>
                )}
              </div>
            </Field>
            <Field label="方案名稱">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field
              label="方案用途"
              hint="客訴補償課程不出現在櫃檯／POS；僅「合規補償」可贈送堂數"
            >
              <Select
                value={planKind}
                onChange={(e) => {
                  const next = e.target.value as 'SALE' | 'COMPENSATION';
                  setPlanKind(next);
                  if (next === 'COMPENSATION') {
                    setPlanType('CUSTOM_PT');
                    setUnitPrice('0');
                    setCardRecurring(false);
                    setRequiresContract(false);
                    setEnableSecondPerson(false);
                  } else if (unitPrice === '0') {
                    setUnitPrice('1000');
                  }
                }}
              >
                <option value="SALE">可售方案（SALE）</option>
                <option value="COMPENSATION">客訴補償課程（COMPENSATION）</option>
              </Select>
            </Field>
            <Field label="方案類型">
              <Select
                value={planType}
                disabled={planKind === 'COMPENSATION'}
                onChange={(e) => setPlanType(e.target.value as CoursePlanType)}
              >
                <option value="CUSTOM_PT">客製化私教</option>
                <option value="GROUP">團體課程</option>
              </Select>
            </Field>
            <Field label="方案模式">
              <Select
                value={planMode}
                onChange={(e) => setPlanMode(e.target.value as PromotionPlanMode)}
              >
                <option value="STANDING">長註</option>
                <option value="CAMPAIGN">活動</option>
              </Select>
            </Field>
            {planMode === 'CAMPAIGN' && (
              <>
                <Field label="活動上架時間">
                  <Input
                    type="datetime-local"
                    value={saleStart}
                    onChange={(e) => setSaleStart(e.target.value)}
                  />
                </Field>
                <Field label="活動下架時間">
                  <Input
                    type="datetime-local"
                    value={saleEnd}
                    onChange={(e) => setSaleEnd(e.target.value)}
                  />
                </Field>
              </>
            )}
            <Field label="單堂售價">
              <Input
                type="number"
                min={0}
                step="1"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                required
              />
            </Field>
            <Field
              label={planType === 'GROUP' ? '期班堂數' : '堂數'}
              hint={planType === 'GROUP' ? '本期班上課堂數' : '私教合約總堂數'}
            >
              <Input
                type="number"
                min={1}
                value={sessions}
                onChange={(e) => setSessions(e.target.value)}
                required
              />
            </Field>
            <Field label="總售價" hint="單堂售價 × 堂數（後端入帳金額）">
              <Input
                value={
                  createTotal != null
                    ? `${formatMoney(parseFloat(unitPrice) || 0)} × ${sessions || '—'} 堂 ＝ ${formatMoney(createTotal)}`
                    : '—'
                }
                readOnly
                disabled
              />
            </Field>
            {planType === 'GROUP' && (
              <Field label="課程人數上限" hint="團體課建議容納人數">
                <Input
                  type="number"
                  min={1}
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                  required
                />
              </Field>
            )}
            <Field label="說明" hint="選填">
              <textarea
                className="input"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
              />
            </Field>
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={enableSecondPerson}
                onChange={(e) => setEnableSecondPerson(e.target.checked)}
              />
              課程第二人+$500（課程當日現場支付）
            </label>
            <p className="text-muted text-sm" style={{ marginTop: '-0.35rem' }}>
              啟用後臨櫃可勾選；不計入本次結帳應付，僅註記現場另收 $500
            </p>
            <Field
              label="加贈禮"
              hint="選填；從進銷存商品選取，加入購物車時帶入且金額 $0"
            >
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <Select
                  value={effectiveGiftLabel}
                  onChange={(e) => setGiftLabel(e.target.value)}
                  disabled={branchIds.length === 0}
                  style={{ flex: 1 }}
                >
                  <option value="">無</option>
                  {createGiftOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
                {effectiveGiftLabel && (
                  <>
                    <span className="text-sm">×</span>
                    <Input
                      type="number"
                      min={1}
                      value={giftQty}
                      onChange={(e) => setGiftQty(e.target.value)}
                      style={{ width: 70 }}
                      aria-label="加贈禮數量"
                    />
                  </>
                )}
              </div>
              {branchIds.length > 0 && createGiftOptions.length === 0 && (
                <p className="text-muted text-sm">所選分店尚無啟用中商品，請先至「總部 HQ → 商品主檔」建立</p>
              )}
            </Field>
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={requiresContract}
                onChange={(e) => {
                  setRequiresContract(e.target.checked);
                  if (!e.target.checked) setContractIds([]);
                }}
              />
              需簽署會員合約
            </label>
            {requiresContract && (
              <Field label="綁定合約" hint="勾選後必選至少一份；請先至「合約」頁籤建立">
                {activeContracts.length === 0 ? (
                  <p className="text-muted text-sm">尚無啟用中合約</p>
                ) : (
                  <div className="form-stack">
                    {activeContracts.map((c) => (
                      <label key={c.id} className="checkbox-item">
                        <input
                          type="checkbox"
                          checked={contractIds.includes(c.id)}
                          onChange={() => toggleContractId(c.id, contractIds, setContractIds)}
                        />
                        {c.displayName || c.shortName || c.title}
                        <span className="text-muted text-sm">
                          （{c.currentVersion?.versionLabel ||
                            (c.currentVersion?.version != null
                              ? `v${c.currentVersion.version}`
                              : '—')}）
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </Field>
            )}
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={cardRecurring}
                onChange={(e) => setCardRecurring(e.target.checked)}
              />
              啟用信用卡定期定額
            </label>
            {cardRecurring && (
              <>
                <Field label="可選期數" hint="未勾選的期數不會出現在櫃檯選項；兩者皆勾則可選 2 或 4 期">
                  <div className="checkbox-group">
                    <label className="checkbox-item">
                      <input
                        type="checkbox"
                        checked={allowRecurring2}
                        onChange={(e) => {
                          setAllowRecurring2(e.target.checked);
                          if (!e.target.checked) {
                            setRecurring2FirstStr('');
                            setRecurring2SecondStr('');
                          }
                        }}
                      />
                      2 期
                    </label>
                    <label className="checkbox-item">
                      <input
                        type="checkbox"
                        checked={allowRecurring4}
                        onChange={(e) => {
                          setAllowRecurring4(e.target.checked);
                          if (!e.target.checked) {
                            setRecurring4BaseStr('');
                            setRecurring4FinalStr('');
                          }
                        }}
                      />
                      4 期
                    </label>
                  </div>
                </Field>
                {allowRecurring2 && (
                  <>
                    <Field
                      label="2期 · 第1期扣款金額"
                      hint="需滿足（第1期 + 第2期）= 總售價"
                    >
                      <Input
                        type="number"
                        min={1}
                        value={recurring2FirstStr}
                        onChange={(e) => setRecurring2FirstStr(e.target.value)}
                        placeholder="例：2500"
                      />
                    </Field>
                    <Field label="2期 · 第2期扣款金額" hint="續扣金額">
                      <Input
                        type="number"
                        min={1}
                        value={recurring2SecondStr}
                        onChange={(e) => setRecurring2SecondStr(e.target.value)}
                        placeholder="例：5000"
                      />
                    </Field>
                  </>
                )}
                {allowRecurring4 && (
                  <>
                    <Field
                      label="4期 · 第1~3期金額（相同）"
                      hint="需滿足（第1~3期共用 × 3）+ 第4期 = 總售價"
                    >
                      <Input
                        type="number"
                        min={1}
                        value={recurring4BaseStr}
                        onChange={(e) => setRecurring4BaseStr(e.target.value)}
                        placeholder="例：2000"
                      />
                    </Field>
                    <Field label="4期 · 第4期扣款金額" hint="最後一期續扣金額">
                      <Input
                        type="number"
                        min={1}
                        value={recurring4FinalStr}
                        onChange={(e) => setRecurring4FinalStr(e.target.value)}
                        placeholder="例：5000"
                      />
                    </Field>
                  </>
                )}
              </>
            )}
            <Button type="submit" disabled={branchIds.length === 0}>
              建立方案{branchIds.length > 1 ? `（${branchIds.length} 間分店）` : ''}
            </Button>
          </form>
        </Card>

        <Card title="方案一覽" subtitle={`顯示 ${filtered.length}／${coursePlans.length} 筆`}>
          <div className="list-toolbar">
            <span className="text-muted text-sm">分店篩選</span>
            <Select
              value={filterBranchId === '' ? '' : String(filterBranchId)}
              onChange={(e) => setFilterBranchId(e.target.value ? Number(e.target.value) : '')}
              aria-label="課程方案分店篩選"
            >
              <option value="">全部分店（{coursePlans.length}）</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {staffBranchLabel(b)}（{coursePlans.filter((p) => p.branchId === b.id).length}）
                </option>
              ))}
            </Select>
          </div>
          <div className="table-wrap mt-md hq-list-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>分店</th>
                  <th>用途</th>
                  <th>類型</th>
                  <th>名稱</th>
                  <th>單堂售價</th>
                  <th>堂數</th>
                  <th>總售價</th>
                  <th>人數上限</th>
                  <th>模式</th>
                  <th>檔期</th>
                  <th>合約</th>
                  <th>定期定額</th>
                  <th>二人／贈禮</th>
                  <th>狀態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={14} className="text-muted text-center">
                      {coursePlans.length === 0 ? '尚無課程方案' : '此分店尚無課程方案'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((p) => {
                    const status = getCampaignStatus(
                      p.planMode,
                      p.saleStartAt,
                      p.saleEndAt,
                      p.isActive,
                    );
                    const statusTone =
                      status === '進行中' || status === '長註'
                        ? 'success'
                        : status === '未開始'
                          ? 'info'
                          : 'neutral';
                    const unit =
                      p.sessions && p.sessions > 0
                        ? Math.round((Number(p.price) / p.sessions) * 100) / 100
                        : null;
                    return (
                      <tr key={p.id}>
                        <td>{staffBranchLabel(p.branch) || `#${p.branchId}`}</td>
                        <td>{p.kind === 'COMPENSATION' ? '補償' : '可售'}</td>
                        <td>
                          {COURSE_PLAN_TYPE_LABELS[
                            p.planType === 'GROUP' ? 'GROUP' : 'CUSTOM_PT'
                          ]}
                        </td>
                        <td>{p.name}</td>
                        <td>{unit != null ? formatMoney(unit) : '—'}</td>
                        <td>{p.sessions != null ? `${p.sessions} 堂` : '—'}</td>
                        <td>
                          {unit != null && p.sessions
                            ? `${formatMoney(unit)} × ${p.sessions} ＝ ${formatMoney(Number(p.price) || 0)}`
                            : formatMoney(Number(p.price) || 0)}
                        </td>
                        <td>
                          {p.planType === 'GROUP'
                            ? p.capacity != null
                              ? `${p.capacity} 人`
                              : '—'
                            : '—'}
                        </td>
                        <td className="text-sm">
                          {PLAN_MODE_LABELS[
                            p.planMode === 'CAMPAIGN' ? 'CAMPAIGN' : 'STANDING'
                          ]}
                        </td>
                        <td className="text-sm">
                          {formatPromotionSchedule(p.planMode, p.saleStartAt, p.saleEndAt)}
                        </td>
                        <td className="text-sm">
                          {p.requiresMemberContract
                            ? p.contracts?.length
                              ? `合約×${p.contracts.length}`
                              : '需合約'
                            : '—'}
                        </td>
                        <td className="text-sm">{formatRecurringLabel(p)}</td>
                        <td className="text-sm">
                          {[
                            p.enableSecondPerson ? '∨' : null,
                            p.giftLabel
                              ? `贈：${p.giftLabel}${p.giftQty && p.giftQty > 1 ? ` ×${p.giftQty}` : ''}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </td>
                        <td>
                          <Badge tone={statusTone}>{status}</Badge>
                        </td>
                        <td className="table-actions">
                          <Button size="sm" variant="secondary" onClick={() => openEdit(p)}>
                            編輯
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busyId === p.id}
                            disabled={busyId != null && busyId !== p.id}
                            onClick={() => void handleDelete(p)}
                          >
                            刪除
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="hq-list-cards" aria-label="課程方案卡片列表">
            {filtered.length === 0 ? (
              <p className="text-muted text-center">
                {coursePlans.length === 0 ? '尚無課程方案' : '此分店尚無課程方案'}
              </p>
            ) : (
              filtered.map((p) => {
                const status = getCampaignStatus(
                  p.planMode,
                  p.saleStartAt,
                  p.saleEndAt,
                  p.isActive,
                );
                const statusTone =
                  status === '進行中' || status === '長註'
                    ? 'success'
                    : status === '未開始'
                      ? 'info'
                      : 'neutral';
                const unit =
                  p.sessions && p.sessions > 0
                    ? Math.round((Number(p.price) / p.sessions) * 100) / 100
                    : null;
                const extras =
                  [
                    p.enableCardRecurring
                      ? `定期定額 ${formatRecurringLabel(p)}`
                      : null,
                    p.enableSecondPerson ? '第二人' : null,
                    p.giftLabel
                      ? `贈：${p.giftLabel}${p.giftQty && p.giftQty > 1 ? ` ×${p.giftQty}` : ''}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—';
                return (
                  <article key={p.id} className="hq-list-card">
                    <div className="hq-list-card__head">
                      <div>
                        <div className="hq-list-card__title">{p.name}</div>
                        <div className="hq-list-card__meta">
                          {staffBranchLabel(p.branch) || `#${p.branchId}`} ·{' '}
                          {
                            COURSE_PLAN_TYPE_LABELS[
                              p.planType === 'GROUP' ? 'GROUP' : 'CUSTOM_PT'
                            ]
                          }
                        </div>
                      </div>
                      <Badge tone={statusTone}>{status}</Badge>
                    </div>
                    <dl className="hq-list-card__grid">
                      <dt>單堂</dt>
                      <dd>{unit != null ? formatMoney(unit) : '—'}</dd>
                      <dt>堂數</dt>
                      <dd>{p.sessions != null ? `${p.sessions} 堂` : '—'}</dd>
                      <dt>總售價</dt>
                      <dd>{formatMoney(Number(p.price) || 0)}</dd>
                      <dt>人數</dt>
                      <dd>
                        {p.planType === 'GROUP'
                          ? p.capacity != null
                            ? `${p.capacity} 人`
                            : '—'
                          : '—'}
                      </dd>
                      <dt>模式</dt>
                      <dd>
                        {
                          PLAN_MODE_LABELS[
                            p.planMode === 'CAMPAIGN' ? 'CAMPAIGN' : 'STANDING'
                          ]
                        }
                      </dd>
                      <dt>合約</dt>
                      <dd>
                        {p.requiresMemberContract
                          ? p.contracts?.length
                            ? `合約×${p.contracts.length}`
                            : '需合約'
                          : '—'}
                      </dd>
                    </dl>
                    <div className="hq-list-card__meta">
                      {formatPromotionSchedule(p.planMode, p.saleStartAt, p.saleEndAt)}
                      {extras !== '—' ? ` · ${extras}` : ''}
                    </div>
                    <div className="hq-list-card__foot">
                      <span className="hq-list-card__meta">#{p.id}</span>
                      <div className="btn-row">
                        <Button size="sm" variant="secondary" onClick={() => openEdit(p)}>
                          編輯
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyId === p.id}
                          disabled={busyId != null && busyId !== p.id}
                          onClick={() => void handleDelete(p)}
                        >
                          刪除
                        </Button>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </Card>
      </div>

      <Modal
        open={editing !== null}
        title={editing ? `編輯課程方案 · ${editing.name}` : '編輯'}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button onClick={handleUpdate}>儲存</Button>
          </>
        }
      >
        <form className="form-stack" onSubmit={handleUpdate}>
          <Field label="方案名稱">
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} required />
          </Field>
          <Field label="方案類型">
            <Select
              value={editPlanType}
              onChange={(e) => setEditPlanType(e.target.value as CoursePlanType)}
            >
              <option value="CUSTOM_PT">私教</option>
              <option value="GROUP">團課</option>
            </Select>
          </Field>
          <Field label="方案模式">
            <Select
              value={editPlanMode}
              onChange={(e) => setEditPlanMode(e.target.value as PromotionPlanMode)}
            >
              <option value="STANDING">長註</option>
              <option value="CAMPAIGN">檔期</option>
            </Select>
          </Field>
          {editPlanMode === 'CAMPAIGN' && (
            <>
              <Field label="上架">
                <Input
                  type="datetime-local"
                  value={editSaleStart}
                  onChange={(e) => setEditSaleStart(e.target.value)}
                />
              </Field>
              <Field label="下架">
                <Input
                  type="datetime-local"
                  value={editSaleEnd}
                  onChange={(e) => setEditSaleEnd(e.target.value)}
                />
              </Field>
            </>
          )}
          <Field label="單堂售價">
            <Input
              type="number"
              min={0}
              step="1"
              value={editUnitPrice}
              onChange={(e) => setEditUnitPrice(e.target.value)}
              required
            />
          </Field>
          <Field label={editPlanType === 'GROUP' ? '期班堂數' : '堂數'}>
            <Input
              type="number"
              min={1}
              value={editSessions}
              onChange={(e) => setEditSessions(e.target.value)}
              required
            />
          </Field>
          <Field label="總售價" hint="單堂售價 × 堂數">
            <Input
              value={
                editTotal != null
                  ? `${formatMoney(parseFloat(editUnitPrice) || 0)} × ${editSessions || '—'} 堂 ＝ ${formatMoney(editTotal)}`
                  : '—'
              }
              readOnly
              disabled
            />
          </Field>
          {editPlanType === 'GROUP' && (
            <Field label="課程人數上限">
              <Input
                type="number"
                min={1}
                value={editCapacity}
                onChange={(e) => setEditCapacity(e.target.value)}
                required
              />
            </Field>
          )}
          <Field label="說明">
            <textarea
              className="input"
              rows={3}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
            />
          </Field>
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editEnableSecondPerson}
              onChange={(e) => setEditEnableSecondPerson(e.target.checked)}
            />
            課程第二人+$500（課程當日現場支付）
          </label>
          <p className="text-muted text-sm" style={{ marginTop: '-0.35rem' }}>
            啟用後臨櫃可勾選；不計入本次結帳應付，僅註記現場另收 $500
          </p>
          <Field
            label="加贈禮"
            hint="選填；從進銷存商品選取，加入購物車時帶入且金額 $0"
          >
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <Select
                value={editGiftLabel}
                onChange={(e) => setEditGiftLabel(e.target.value)}
                style={{ flex: 1 }}
              >
                <option value="">無</option>
                {editGiftOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {editGiftLabel && !editGiftOptions.includes(editGiftLabel) ? (
                  <option value={editGiftLabel}>{editGiftLabel}（目前值）</option>
                ) : null}
              </Select>
              {editGiftLabel && (
                <>
                  <span className="text-sm">×</span>
                  <Input
                    type="number"
                    min={1}
                    value={editGiftQty}
                    onChange={(e) => setEditGiftQty(e.target.value)}
                    style={{ width: 70 }}
                    aria-label="加贈禮數量"
                  />
                </>
              )}
            </div>
            {editGiftOptions.length === 0 && (
              <p className="text-muted text-sm">此分店尚無啟用中商品，請先至「總部 HQ → 商品主檔」建立</p>
            )}
          </Field>
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editRequiresContract}
              onChange={(e) => {
                setEditRequiresContract(e.target.checked);
                if (!e.target.checked) setEditContractIds([]);
              }}
            />
            需簽署合約
          </label>
          {editRequiresContract && (
            <Field label="綁定合約">
              {activeContracts.length === 0 ? (
                <p className="text-muted text-sm">尚無啟用中合約</p>
              ) : (
                <div className="form-stack">
                  {activeContracts.map((c) => (
                    <label key={c.id} className="checkbox-item">
                      <input
                        type="checkbox"
                        checked={editContractIds.includes(c.id)}
                        onChange={() =>
                          toggleContractId(c.id, editContractIds, setEditContractIds)
                        }
                      />
                      {c.displayName || c.shortName || c.title}
                    </label>
                  ))}
                </div>
              )}
            </Field>
          )}
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editCardRecurring}
              onChange={(e) => setEditCardRecurring(e.target.checked)}
            />
            啟用信用卡定期定額
          </label>
          {editCardRecurring && (
            <>
              <Field label="可選期數" hint="未勾選的期數不會出現在櫃檯選項；兩者皆勾則可選 2 或 4 期">
                <div className="checkbox-group">
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={editAllowRecurring2}
                      onChange={(e) => {
                        setEditAllowRecurring2(e.target.checked);
                        if (!e.target.checked) {
                          setEditRecurring2FirstStr('');
                          setEditRecurring2SecondStr('');
                        }
                      }}
                    />
                    2 期
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={editAllowRecurring4}
                      onChange={(e) => {
                        setEditAllowRecurring4(e.target.checked);
                        if (!e.target.checked) {
                          setEditRecurring4BaseStr('');
                          setEditRecurring4FinalStr('');
                        }
                      }}
                    />
                    4 期
                  </label>
                </div>
              </Field>
              {editAllowRecurring2 && (
                <>
                  <Field
                    label="2期 · 第1期扣款金額"
                    hint="需滿足（第1期 + 第2期）= 總售價"
                  >
                    <Input
                      type="number"
                      min={1}
                      value={editRecurring2FirstStr}
                      onChange={(e) => setEditRecurring2FirstStr(e.target.value)}
                      placeholder="例：2500"
                    />
                  </Field>
                  <Field label="2期 · 第2期扣款金額" hint="續扣金額">
                    <Input
                      type="number"
                      min={1}
                      value={editRecurring2SecondStr}
                      onChange={(e) => setEditRecurring2SecondStr(e.target.value)}
                      placeholder="例：5000"
                    />
                  </Field>
                </>
              )}
              {editAllowRecurring4 && (
                <>
                  <Field
                    label="4期 · 第1~3期金額（相同）"
                    hint="需滿足（第1~3期共用 × 3）+ 第4期 = 總售價"
                  >
                    <Input
                      type="number"
                      min={1}
                      value={editRecurring4BaseStr}
                      onChange={(e) => setEditRecurring4BaseStr(e.target.value)}
                      placeholder="例：2000"
                    />
                  </Field>
                  <Field label="4期 · 第4期扣款金額" hint="最後一期續扣金額">
                    <Input
                      type="number"
                      min={1}
                      value={editRecurring4FinalStr}
                      onChange={(e) => setEditRecurring4FinalStr(e.target.value)}
                      placeholder="例：5000"
                    />
                  </Field>
                </>
              )}
            </>
          )}
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editActive}
              onChange={(e) => setEditActive(e.target.checked)}
            />
            上架中
          </label>
        </form>
      </Modal>
    </PageSection>
  );
}
