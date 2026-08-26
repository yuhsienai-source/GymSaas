import { type FormEvent, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createPromotion,
  deleteHqPromotion,
  fetchHqContracts,
  getErrorMessage,
  updateHqPromotion,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import {
  formatPromotionDuration,
  formatPromotionSchedule,
  formatPromotionValue,
  getCampaignStatus,
  toDatetimeLocalValue,
  USAGE_TYPE_LABELS,
  type PromotionPlanMode,
  type PromotionUsageType,
} from '../../../lib/promotionLabels';
import type { MembershipContract, Promotion } from '../../../types/api';
import type { HqDataProps } from './types';

function toIsoOrNull(local: string) {
  if (!local.trim()) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function HqPromotionsTab({
  branches,
  promotions,
  onReload,
}: Pick<HqDataProps, 'branches' | 'promotions' | 'onReload'>) {
  const { toast } = useToast();
  const activeBranches = branches.filter((b) => b.isActive);
  const [promoBranchIds, setPromoBranchIds] = useState<number[]>(
    activeBranches[0] ? [activeBranches[0].id] : [],
  );
  const [promoName, setPromoName] = useState('');
  const [promoKind, setPromoKind] = useState<'SALE' | 'COMPENSATION'>('SALE');
  const [promoUsageType, setPromoUsageType] = useState<PromotionUsageType>('TIMED');
  const [promoPlanMode, setPromoPlanMode] = useState<PromotionPlanMode>('STANDING');
  const [promoSaleStart, setPromoSaleStart] = useState('');
  const [promoSaleEnd, setPromoSaleEnd] = useState('');
  const [promoPrice, setPromoPrice] = useState('500');
  const [promoBonus, setPromoBonus] = useState('100');
  const [promoUnitDays, setPromoUnitDays] = useState('30');
  const [promoPeriodCount, setPromoPeriodCount] = useState('1');
  const [promoRequiresContract, setPromoRequiresContract] = useState(false);
  const [promoCardRecurring, setPromoCardRecurring] = useState(false);
  const [promoContractIds, setPromoContractIds] = useState<number[]>([]);
  const [filterBranchId, setFilterBranchId] = useState<number | ''>('');
  const [activeContracts, setActiveContracts] = useState<MembershipContract[]>([]);

  const [editingPromo, setEditingPromo] = useState<Promotion | null>(null);
  const [editName, setEditName] = useState('');
  const [editUsageType, setEditUsageType] = useState<PromotionUsageType>('TIMED');
  const [editPlanMode, setEditPlanMode] = useState<PromotionPlanMode>('STANDING');
  const [editSaleStart, setEditSaleStart] = useState('');
  const [editSaleEnd, setEditSaleEnd] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editBonus, setEditBonus] = useState('');
  const [editUnitDays, setEditUnitDays] = useState('');
  const [editPeriodCount, setEditPeriodCount] = useState('');
  const [editRequiresContract, setEditRequiresContract] = useState(false);
  const [editCardRecurring, setEditCardRecurring] = useState(false);
  const [editContractIds, setEditContractIds] = useState<number[]>([]);
  const [editActive, setEditActive] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

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

  function toggleContractId(
    id: number,
    selected: number[],
    setSelected: (ids: number[]) => void,
  ) {
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  const filtered = filterBranchId
    ? promotions.filter((p) => p.branchId === filterBranchId)
    : promotions;

  const isCompensation = promoKind === 'COMPENSATION';
  const isUnlimited = !isCompensation && promoUsageType === 'UNLIMITED';
  const editIsUnlimited = editUsageType === 'UNLIMITED';
  const promoEffectiveDays =
    Math.max(0, parseInt(promoUnitDays, 10) || 0) *
    Math.max(0, parseInt(promoPeriodCount, 10) || 0);
  const editEffectiveDays =
    Math.max(0, parseInt(editUnitDays, 10) || 0) *
    Math.max(0, parseInt(editPeriodCount, 10) || 0);

  function togglePromoBranch(branchId: number) {
    setPromoBranchIds((prev) =>
      prev.includes(branchId) ? prev.filter((id) => id !== branchId) : [...prev, branchId],
    );
  }

  function toggleAllPromoBranches() {
    if (promoBranchIds.length === activeBranches.length) {
      setPromoBranchIds([]);
    } else {
      setPromoBranchIds(activeBranches.map((b) => b.id));
    }
  }

  async function handleCreatePromotion(e: FormEvent) {
    e.preventDefault();
    if (promoBranchIds.length === 0) {
      toast('請至少選擇一間分店', 'error');
      return;
    }
    if (promoPlanMode === 'CAMPAIGN' && promoSaleStart && promoSaleEnd && promoSaleEnd <= promoSaleStart) {
      toast('活動下架時間必須晚於上架時間', 'error');
      return;
    }
    if (
      isUnlimited &&
      (!promoUnitDays ||
        parseInt(promoUnitDays, 10) <= 0 ||
        !promoPeriodCount ||
        parseInt(promoPeriodCount, 10) <= 0)
    ) {
      toast('無限使用方案必須設定天數與期數（皆為正整數）', 'error');
      return;
    }
    if (promoRequiresContract && promoContractIds.length === 0) {
      toast('簽署合約時，請至少選擇一份合約', 'error');
      return;
    }
    if (promoCardRecurring) {
      if (isCompensation) {
        toast('客訴補償專案不可啟用定期定額', 'error');
        return;
      }
      if (!isUnlimited) {
        toast('定期定額僅限「無限使用」方案', 'error');
        return;
      }
      if (!promoPeriodCount || parseInt(promoPeriodCount, 10) <= 0) {
        toast('啟用定期定額時必須設定有效期期數', 'error');
        return;
      }
    }
    if (isCompensation) {
      if (parseFloat(promoBonus) <= 0) {
        toast('客訴補償專案必須設定運動金額度（bonusGiven > 0）', 'error');
        return;
      }
    }
    try {
      const result = await createPromotion({
        branchIds: promoBranchIds,
        name: promoName,
        kind: promoKind,
        price: isCompensation ? 0 : parseFloat(promoPrice),
        bonusGiven: isUnlimited ? 0 : parseFloat(promoBonus),
        usageType: isCompensation ? 'TIMED' : promoUsageType,
        planMode: promoPlanMode,
        saleStartAt: promoPlanMode === 'CAMPAIGN' ? toIsoOrNull(promoSaleStart) : null,
        saleEndAt: promoPlanMode === 'CAMPAIGN' ? toIsoOrNull(promoSaleEnd) : null,
        unitDays: isUnlimited ? parseInt(promoUnitDays, 10) : null,
        periodCount: isUnlimited ? parseInt(promoPeriodCount, 10) : null,
        requiresMemberContract: isCompensation ? false : promoRequiresContract,
        enableCardRecurring: isCompensation ? false : promoCardRecurring,
        recurringAmount: !isCompensation && promoCardRecurring ? parseFloat(promoPrice) || null : null,
        contractIds: !isCompensation && promoRequiresContract ? promoContractIds : [],
      });
      toast(result.message || '方案上架成功', 'success');
      setPromoName('');
      setPromoKind('SALE');
      setPromoSaleStart('');
      setPromoSaleEnd('');
      setPromoUnitDays('30');
      setPromoPeriodCount('1');
      setPromoContractIds([]);
      setPromoRequiresContract(false);
      setPromoCardRecurring(false);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '建立方案失敗'), 'error');
    }
  }

  function openEditPromo(p: Promotion) {
    setEditingPromo(p);
    setEditName(p.name);
    setEditUsageType(p.usageType === 'UNLIMITED' ? 'UNLIMITED' : 'TIMED');
    setEditPlanMode(p.planMode === 'CAMPAIGN' ? 'CAMPAIGN' : 'STANDING');
    setEditSaleStart(toDatetimeLocalValue(p.saleStartAt));
    setEditSaleEnd(toDatetimeLocalValue(p.saleEndAt));
    setEditPrice(String(p.price));
    setEditBonus(String(p.bonusGiven));
    if (p.unitDays && p.periodCount) {
      setEditUnitDays(String(p.unitDays));
      setEditPeriodCount(String(p.periodCount));
    } else if (p.durationDays) {
      setEditUnitDays(String(p.durationDays));
      setEditPeriodCount('1');
    } else {
      setEditUnitDays('30');
      setEditPeriodCount('1');
    }
    setEditRequiresContract(Boolean(p.requiresMemberContract));
    setEditCardRecurring(Boolean(p.enableCardRecurring));
    setEditContractIds((p.contracts || []).map((c) => c.id));
    setEditActive(p.isActive !== false);
  }

  async function handleUpdatePromo(e: FormEvent) {
    e.preventDefault();
    if (!editingPromo) return;
    if (editPlanMode === 'CAMPAIGN' && editSaleStart && editSaleEnd && editSaleEnd <= editSaleStart) {
      toast('活動下架時間必須晚於上架時間', 'error');
      return;
    }
    if (
      editIsUnlimited &&
      (!editUnitDays ||
        parseInt(editUnitDays, 10) <= 0 ||
        !editPeriodCount ||
        parseInt(editPeriodCount, 10) <= 0)
    ) {
      toast('無限使用方案必須設定天數與期數（皆為正整數）', 'error');
      return;
    }
    if (editRequiresContract && editContractIds.length === 0) {
      toast('需簽署會員合約時，請至少選擇一份合約', 'error');
      return;
    }
    if (editCardRecurring) {
      if (!editIsUnlimited) {
        toast('定期定額僅限「無限使用」方案', 'error');
        return;
      }
      if (!editPeriodCount || parseInt(editPeriodCount, 10) <= 0) {
        toast('啟用定期定額時必須設定有效期期數', 'error');
        return;
      }
    }
    try {
      const result = await updateHqPromotion(editingPromo.id, {
        name: editName,
        usageType: editUsageType,
        planMode: editPlanMode,
        saleStartAt: editPlanMode === 'CAMPAIGN' ? toIsoOrNull(editSaleStart) : null,
        saleEndAt: editPlanMode === 'CAMPAIGN' ? toIsoOrNull(editSaleEnd) : null,
        price: parseFloat(editPrice),
        bonusGiven: editIsUnlimited ? 0 : parseFloat(editBonus),
        unitDays: editIsUnlimited ? parseInt(editUnitDays, 10) : null,
        periodCount: editIsUnlimited ? parseInt(editPeriodCount, 10) : null,
        requiresMemberContract: editRequiresContract,
        enableCardRecurring: editCardRecurring,
        recurringAmount: editCardRecurring ? parseFloat(editPrice) || null : null,
        isActive: editActive,
        contractIds: editRequiresContract ? editContractIds : [],
      });
      toast(result.message || '方案已更新', 'success');
      setEditingPromo(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '更新方案失敗'), 'error');
    }
  }

  async function handleDeletePromo(p: Promotion) {
    const msg = p.isActive
      ? `確定刪除方案「${p.name}」？\n若有定期定額訂閱將改為下架；否則永久刪除。`
      : `方案「${p.name}」已下架。若無訂閱將永久刪除，確定繼續？`;
    if (!window.confirm(msg)) return;
    setBusyId(p.id);
    try {
      const result = await deleteHqPromotion(p.id);
      toast(result.message || '方案已處理', 'success');
      if (editingPromo?.id === p.id) setEditingPromo(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '刪除方案失敗'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageSection
      title="儲值方案"
      desc="分鐘計費：金額進錢包 · 無限使用：收取方案費、延長效期 · 客訴補償：price $0、僅總部合規配發"
    >
      <div className="staff-grid">
        <Card title="新增方案">
          <form onSubmit={handleCreatePromotion} className="form-stack">
            <Field label="適用分店" hint="可多選；每間分店會各建立一筆相同條件的方案">
              <div className="checkbox-group">
                {activeBranches.length > 1 && (
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={promoBranchIds.length === activeBranches.length && activeBranches.length > 0}
                      onChange={toggleAllPromoBranches}
                    />
                    全選
                  </label>
                )}
                {activeBranches.map((b) => (
                  <label key={b.id} className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={promoBranchIds.includes(b.id)}
                      onChange={() => togglePromoBranch(b.id)}
                    />
                    {staffBranchLabel(b)}
                  </label>
                ))}
                {activeBranches.length === 0 && (
                  <span className="text-muted text-sm">尚無啟用中的分店</span>
                )}
              </div>
            </Field>
            <Field label="方案用途" hint="客訴補償專案不出現在櫃檯／會員購案；僅「合規補償」可配發">
              <Select
                value={promoKind}
                onChange={(e) => {
                  const next = e.target.value as 'SALE' | 'COMPENSATION';
                  setPromoKind(next);
                  if (next === 'COMPENSATION') {
                    setPromoUsageType('TIMED');
                    setPromoPrice('0');
                    setPromoCardRecurring(false);
                    setPromoRequiresContract(false);
                  } else if (promoPrice === '0') {
                    setPromoPrice('500');
                  }
                }}
              >
                <option value="SALE">可售方案（SALE）</option>
                <option value="COMPENSATION">客訴補償專案（COMPENSATION）</option>
              </Select>
            </Field>
            <Field label="方案類型" hint="無限使用：方案費不入會員錢包，改延長有效期限">
              <Select
                value={promoUsageType}
                disabled={isCompensation}
                onChange={(e) => setPromoUsageType(e.target.value as PromotionUsageType)}
              >
                <option value="TIMED">計時</option>
                <option value="UNLIMITED">月卡</option>
              </Select>
            </Field>
            <Field label="方案模式">
              <Select
                value={promoPlanMode}
                onChange={(e) => {
                  const mode = e.target.value as PromotionPlanMode;
                  setPromoPlanMode(mode);
                  if (mode === 'STANDING') {
                    setPromoSaleStart('');
                    setPromoSaleEnd('');
                  }
                }}
              >
                <option value="STANDING">長註</option>
                <option value="CAMPAIGN">活動</option>
              </Select>
            </Field>
            {promoPlanMode === 'CAMPAIGN' && (
              <>
                <Field label="活動上架時間">
                  <Input
                    type="datetime-local"
                    value={promoSaleStart}
                    onChange={(e) => setPromoSaleStart(e.target.value)}
                  />
                </Field>
                <Field label="活動下架時間">
                  <Input
                    type="datetime-local"
                    value={promoSaleEnd}
                    onChange={(e) => setPromoSaleEnd(e.target.value)}
                  />
                </Field>
              </>
            )}
            <Field label="方案名稱">
              <Input value={promoName} onChange={(e) => setPromoName(e.target.value)} required />
            </Field>
            {isUnlimited ? (
              <Field
                label="有效期限"
                hint="天數 × 期數＝購買後延長的有效天數"
              >
                <div className="duration-formula" aria-label="天數乘以期數等於有效天數">
                  <label className="duration-formula__part">
                    <span className="duration-formula__caption">天數</span>
                    <Input
                      type="number"
                      min={1}
                      value={promoUnitDays}
                      onChange={(e) => setPromoUnitDays(e.target.value)}
                      required
                      aria-label="每期天數"
                    />
                  </label>
                  <span className="duration-formula__op" aria-hidden>
                    ×
                  </span>
                  <label className="duration-formula__part">
                    <span className="duration-formula__caption">期數</span>
                    <Input
                      type="number"
                      min={1}
                      value={promoPeriodCount}
                      onChange={(e) => setPromoPeriodCount(e.target.value)}
                      required
                      aria-label="期數"
                    />
                  </label>
                  <span className="duration-formula__op" aria-hidden>
                    ＝
                  </span>
                  <div className="duration-formula__result">
                    <span className="duration-formula__caption">有效天數</span>
                    <strong>{promoEffectiveDays > 0 ? `${promoEffectiveDays} 天` : '—'}</strong>
                  </div>
                </div>
              </Field>
            ) : null}
            <Field
              label={isCompensation ? '售價（固定 $0）' : isUnlimited ? '方案費用' : '現金本金'}
              hint={isCompensation ? '禁止自填補償現金；額度請設於下方 SC' : undefined}
            >
              <Input
                type="number"
                value={promoPrice}
                disabled={isCompensation}
                onChange={(e) => setPromoPrice(e.target.value)}
              />
            </Field>
            {!isUnlimited && (
              <Field
                label={isCompensation ? '補償運動金（SC）' : '贈送 SC'}
                hint="會員錢包仍顯示為運動金；方案文案為 SC $金額"
              >
                <Input type="number" value={promoBonus} onChange={(e) => setPromoBonus(e.target.value)} />
              </Field>
            )}
            {!isCompensation && (
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={promoRequiresContract}
                onChange={(e) => {
                  setPromoRequiresContract(e.target.checked);
                  if (!e.target.checked) setPromoContractIds([]);
                }}
              />
              簽署合約
            </label>
            )}
            {!isCompensation && promoRequiresContract && (
              <Field label="綁定合約" hint="勾選後必選至少一份；請先至「合約」頁籤建立範本">
                {activeContracts.length === 0 ? (
                  <p className="text-muted text-sm">尚無啟用中合約</p>
                ) : (
                  <div className="form-stack">
                    {activeContracts.map((c) => (
                      <label key={c.id} className="checkbox-item">
                        <input
                          type="checkbox"
                          checked={promoContractIds.includes(c.id)}
                          onChange={() =>
                            toggleContractId(c.id, promoContractIds, setPromoContractIds)
                          }
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
            {!isCompensation && (
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={promoCardRecurring}
                onChange={(e) => setPromoCardRecurring(e.target.checked)}
              />
              啟用信用卡定期定額
            </label>
            )}
            {!isCompensation && promoCardRecurring && (
              <p className="text-muted text-sm">
                每期扣款＝方案費用
                {promoPrice ? ` $${Number(promoPrice).toLocaleString('zh-TW')}` : ''}
                ；總期數＝有效期期數
                {promoPeriodCount ? ` ${promoPeriodCount} 期` : '（請先設定期數）'}
                。僅限無限使用方案。
              </p>
            )}
            <Button type="submit" disabled={promoBranchIds.length === 0}>
              建立方案{promoBranchIds.length > 1 ? `（${promoBranchIds.length} 間分店）` : ''}
            </Button>
          </form>
        </Card>

        <Card title="方案一覽" subtitle={`顯示 ${filtered.length}／${promotions.length} 筆`}>
          <div className="list-toolbar">
            <span className="text-muted text-sm">分店篩選</span>
            <Select
              value={filterBranchId === '' ? '' : String(filterBranchId)}
              onChange={(e) => setFilterBranchId(e.target.value ? Number(e.target.value) : '')}
              aria-label="儲值方案分店篩選"
            >
              <option value="">全部分店（{promotions.length}）</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {staffBranchLabel(b)}（{promotions.filter((p) => p.branchId === b.id).length}）
                </option>
              ))}
            </Select>
          </div>
          <div className="table-wrap mt-md">
            <table className="data-table">
              <thead>
                <tr>
                  <th>分店</th>
                  <th>用途</th>
                  <th>類型</th>
                  <th>名稱</th>
                  <th>費用／儲值</th>
                  <th>有效期限</th>
                  <th>會員合約</th>
                  <th>定期定額</th>
                  <th>檔期</th>
                  <th>狀態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="text-muted text-center">
                      {promotions.length === 0 ? '尚無方案' : '此分店尚無方案'}
                    </td>
                  </tr>
                ) : (
                  filtered.map((p) => {
                    const status = getCampaignStatus(p.planMode, p.saleStartAt, p.saleEndAt, p.isActive);
                    const statusTone =
                      status === '進行中' || status === '長註'
                        ? 'success'
                        : status === '未開始'
                          ? 'info'
                          : 'neutral';
                    return (
                      <tr key={p.id}>
                        <td>{staffBranchLabel(p.branch) || `#${p.branchId}`}</td>
                        <td>{p.kind === 'COMPENSATION' ? '補償' : '可售'}</td>
                        <td>{USAGE_TYPE_LABELS[p.usageType === 'UNLIMITED' ? 'UNLIMITED' : 'TIMED']}</td>
                        <td>{p.name}</td>
                        <td>{formatPromotionValue(p)}</td>
                        <td className="text-sm">{formatPromotionDuration(p)}</td>
                        <td className="text-sm">
                          {p.requiresMemberContract
                            ? (p.contracts?.length
                                ? `合約×${p.contracts.length}`
                                : '需合約')
                            : '—'}
                        </td>
                        <td className="text-sm">
                          {p.enableCardRecurring
                            ? `是 · 每期 $${Number(p.price).toLocaleString('zh-TW')}${
                                p.periodCount ? ` · ${p.periodCount} 期` : ''
                              }`
                            : '否'}
                        </td>
                        <td className="text-sm">
                          {formatPromotionSchedule(p.planMode, p.saleStartAt, p.saleEndAt)}
                        </td>
                        <td>
                          <Badge tone={statusTone}>{status}</Badge>
                        </td>
                        <td className="table-actions">
                          <Button size="sm" variant="secondary" onClick={() => openEditPromo(p)}>
                            編輯
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busyId === p.id}
                            disabled={busyId != null && busyId !== p.id}
                            onClick={() => void handleDeletePromo(p)}
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
        </Card>
      </div>

      <Modal
        open={editingPromo !== null}
        title={`編輯方案 · ${editingPromo?.name}`}
        onClose={() => setEditingPromo(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingPromo(null)}>取消</Button>
            <Button onClick={handleUpdatePromo}>儲存</Button>
          </>
        }
      >
        <form onSubmit={handleUpdatePromo} className="form-stack">
          <Field label="方案類型">
            <Select
              value={editUsageType}
              onChange={(e) => setEditUsageType(e.target.value as PromotionUsageType)}
            >
              <option value="TIMED">計時</option>
              <option value="UNLIMITED">月卡</option>
            </Select>
          </Field>
          <Field label="方案模式">
            <Select
              value={editPlanMode}
              onChange={(e) => {
                const mode = e.target.value as PromotionPlanMode;
                setEditPlanMode(mode);
                if (mode === 'STANDING') {
                  setEditSaleStart('');
                  setEditSaleEnd('');
                }
              }}
            >
              <option value="STANDING">長註</option>
              <option value="CAMPAIGN">活動</option>
            </Select>
          </Field>
          {editPlanMode === 'CAMPAIGN' && (
            <>
              <Field label="活動上架時間">
                <Input type="datetime-local" value={editSaleStart} onChange={(e) => setEditSaleStart(e.target.value)} />
              </Field>
              <Field label="活動下架時間">
                <Input type="datetime-local" value={editSaleEnd} onChange={(e) => setEditSaleEnd(e.target.value)} />
              </Field>
            </>
          )}
          <Field label="方案名稱">
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} required />
          </Field>
          {editIsUnlimited && (
            <Field label="有效期限" hint="天數 × 期數＝購買後延長的有效天數">
              <div className="duration-formula" aria-label="天數乘以期數等於有效天數">
                <label className="duration-formula__part">
                  <span className="duration-formula__caption">天數</span>
                  <Input
                    type="number"
                    min={1}
                    value={editUnitDays}
                    onChange={(e) => setEditUnitDays(e.target.value)}
                    required
                    aria-label="每期天數"
                  />
                </label>
                <span className="duration-formula__op" aria-hidden>
                  ×
                </span>
                <label className="duration-formula__part">
                  <span className="duration-formula__caption">期數</span>
                  <Input
                    type="number"
                    min={1}
                    value={editPeriodCount}
                    onChange={(e) => setEditPeriodCount(e.target.value)}
                    required
                    aria-label="期數"
                  />
                </label>
                <span className="duration-formula__op" aria-hidden>
                  ＝
                </span>
                <div className="duration-formula__result">
                  <span className="duration-formula__caption">有效天數</span>
                  <strong>{editEffectiveDays > 0 ? `${editEffectiveDays} 天` : '—'}</strong>
                </div>
              </div>
            </Field>
          )}
          <Field label={editIsUnlimited ? '方案費用' : '現金本金'}>
            <Input type="number" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} required />
          </Field>
          {!editIsUnlimited && (
            <Field label="贈送 SC" hint="會員錢包仍顯示為運動金；方案文案為 SC $金額">
              <Input type="number" value={editBonus} onChange={(e) => setEditBonus(e.target.value)} required />
            </Field>
          )}
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editRequiresContract}
              onChange={(e) => {
                setEditRequiresContract(e.target.checked);
                if (!e.target.checked) setEditContractIds([]);
              }}
            />
            需簽署會員合約
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
            <p className="text-muted text-sm">
              每期扣款＝方案費用
              {editPrice ? ` $${Number(editPrice).toLocaleString('zh-TW')}` : ''}
              ；總期數＝有效期期數
              {editPeriodCount ? ` ${editPeriodCount} 期` : '（請先設定期數）'}
              。僅限無限使用方案。
            </p>
          )}
          {editPlanMode === 'CAMPAIGN' && (
            <label className="checkbox-item">
              <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
              手動上架（活動仍可被檔期時間限制）
            </label>
          )}
          {editPlanMode === 'STANDING' && (
            <label className="checkbox-item">
              <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
              長註啟用（緊急停賣時可關閉）
            </label>
          )}
        </form>
      </Modal>
    </PageSection>
  );
}
