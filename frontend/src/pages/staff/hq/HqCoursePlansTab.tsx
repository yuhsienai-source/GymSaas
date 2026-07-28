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
  const [requiresContract, setRequiresContract] = useState(false);
  const [contractIds, setContractIds] = useState<number[]>([]);
  const [enableSecondPerson, setEnableSecondPerson] = useState(false);
  const [giftLabel, setGiftLabel] = useState('');
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
  const [editRequiresContract, setEditRequiresContract] = useState(false);
  const [editContractIds, setEditContractIds] = useState<number[]>([]);
  const [editEnableSecondPerson, setEditEnableSecondPerson] = useState(false);
  const [editGiftLabel, setEditGiftLabel] = useState('');
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
    if (planMode === 'CAMPAIGN' && saleStart && saleEnd && saleEnd <= saleStart) {
      toast('活動下架時間必須晚於上架時間', 'error');
      return;
    }
    if (!sessions || parseInt(sessions, 10) <= 0) {
      toast(planType === 'GROUP' ? '團體課程必須設定期班堂數' : '客製化私教必須設定堂數', 'error');
      return;
    }
    if (createTotal == null) {
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
    const price = Number(createTotal);
    try {
      const result = await createHqCoursePlan({
        branchIds,
        name: name.trim(),
        planType,
        planMode,
        saleStartAt: planMode === 'CAMPAIGN' ? toIsoOrNull(saleStart) : null,
        saleEndAt: planMode === 'CAMPAIGN' ? toIsoOrNull(saleEnd) : null,
        price,
        sessions: parseInt(sessions, 10),
        capacity: planType === 'GROUP' ? parseInt(capacity, 10) : capacity ? parseInt(capacity, 10) : null,
        description: description.trim() || null,
        enableCardRecurring: cardRecurring,
        requiresMemberContract: requiresContract,
        enableSecondPerson,
        giftLabel: effectiveGiftLabel.trim() || null,
        contractIds: requiresContract ? contractIds : [],
      });
      toast(result.message || '課程方案已建立', 'success');
      setName('');
      setDescription('');
      setSaleStart('');
      setSaleEnd('');
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
    setEditRequiresContract(Boolean(p.requiresMemberContract));
    setEditContractIds((p.contracts || []).map((c) => c.id));
    setEditEnableSecondPerson(Boolean(p.enableSecondPerson));
    setEditGiftLabel(p.giftLabel || '');
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
        requiresMemberContract: editRequiresContract,
        enableSecondPerson: editEnableSecondPerson,
        giftLabel: editGiftLabel.trim() || null,
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
      desc="客製化私教／團體課程商品化上架 · 長註或活動檔期"
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
            <Field label="方案類型">
              <Select
                value={planType}
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
              <Select
                value={effectiveGiftLabel}
                onChange={(e) => setGiftLabel(e.target.value)}
                disabled={branchIds.length === 0}
              >
                <option value="">無</option>
                {createGiftOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
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
                  <th>類型</th>
                  <th>名稱</th>
                  <th>單堂售價</th>
                  <th>堂數</th>
                  <th>總售價</th>
                  <th>人數上限</th>
                  <th>模式</th>
                  <th>檔期</th>
                  <th>合約</th>
                  <th>二人／贈禮</th>
                  <th>狀態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="text-muted text-center">
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
                        <td className="text-sm">
                          {[
                            p.enableSecondPerson ? '∨' : null,
                            p.giftLabel ? `贈：${p.giftLabel}` : null,
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
                    p.enableSecondPerson ? '第二人' : null,
                    p.giftLabel ? `贈：${p.giftLabel}` : null,
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
            <Select
              value={editGiftLabel}
              onChange={(e) => setEditGiftLabel(e.target.value)}
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
