import { type FormEvent, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createBranch,
  createVenue,
  deleteHqBranch,
  deleteHqVenue,
  fetchHqLegalEntities,
  getErrorMessage,
  updateHqBranch,
  updateHqVenue,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import {
  ALL_BRANCH_TYPES,
  BRANCH_TYPES,
  type BranchType,
  branchTypeOf,
} from '../../../lib/orgStructure';
import type { Branch, LegalEntity, Venue } from '../../../types/api';
import type { HqDataProps } from './types';

function LegalEntitySelect({
  value,
  onChange,
  entities,
}: {
  value: number | '';
  onChange: (id: number | '') => void;
  entities: LegalEntity[];
}) {
  return (
    <Field label="所屬營業人（統編）" hint="決定發票開立之 ezPay 商店與進貨／應付分帳；有庫存或發票後不可改（後端檢查）">
      <Select value={value === '' ? '' : String(value)} onChange={(e) => onChange(Number(e.target.value) || '')}>
        <option value="">— 未綁定（不可開發票／採購） —</option>
        {entities
          .filter((e) => e.isActive || e.id === value)
          .map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}（{e.ubn}）{e.ezpay.configured ? '' : ' · ezPay 金鑰未齊'}
            </option>
          ))}
      </Select>
    </Field>
  );
}

function stationsToInput(v: Venue | null) {
  return (v?.stations || []).map((s) => s.name).join('、');
}

function normalizeCodeInput(raw: string) {
  return raw.trim().replace(/\s+/g, '').slice(0, 32);
}

/** 可作為上層之分店：啟用、頂層、類型符合、非自己 */
function parentCandidates(branches: Branch[], type: BranchType, selfId?: number) {
  const allowed = BRANCH_TYPES[type].parentTypes;
  return branches.filter(
    (b) => b.isActive && !b.parentId && b.id !== selfId && allowed.includes(branchTypeOf(b)),
  );
}

function branchParentHint(type: BranchType, parentId: number | ''): string | null {
  return BRANCH_TYPES[type].requiresParent && parentId === ''
    ? `${BRANCH_TYPES[type].label}必須選擇隸屬分店`
    : null;
}

/** 頂層分店依序，隸屬分店緊接在上層之後 */
function orderByHierarchy(branches: Branch[]) {
  const ids = new Set(branches.map((b) => b.id));
  const roots = branches.filter((b) => !b.parentId || !ids.has(b.parentId));
  return roots.flatMap((r) => [r, ...branches.filter((b) => b.parentId === r.id)]);
}

function BranchTypeFields({
  type,
  parentId,
  onType,
  onParent,
  branches,
  selfId,
}: {
  type: BranchType;
  parentId: number | '';
  onType: (t: BranchType) => void;
  onParent: (id: number | '') => void;
  branches: Branch[];
  selfId?: number;
}) {
  const def = BRANCH_TYPES[type];
  const canHaveParent = def.parentTypes.length > 0;
  const candidates = parentCandidates(branches, type, selfId);
  return (
    <>
      <Field label="分店類型" hint="健身房設店長＋場務／教練；教室隸屬健身房、由該店長督導與支援（不直接綁員工）；學院由 FM 督導、僅教練部">
        <Select
          value={type}
          onChange={(e) => {
            const next = e.target.value as BranchType;
            onType(next);
            if (BRANCH_TYPES[next].parentTypes.length === 0) onParent('');
          }}
        >
          {ALL_BRANCH_TYPES.map((t) => (
            <option key={t} value={t}>{t} {BRANCH_TYPES[t].label}</option>
          ))}
        </Select>
      </Field>
      {canHaveParent && (
        <Field label="隸屬分店" hint={def.requiresParent ? '必填；如熱河教室隸屬和平店' : '選填'}>
          <Select
            value={parentId === '' ? '' : String(parentId)}
            onChange={(e) => onParent(Number(e.target.value) || '')}
            required={def.requiresParent}
          >
            <option value="">{def.requiresParent ? '— 請選擇 —' : '— 無（獨立） —'}</option>
            {candidates.map((b) => (
              <option key={b.id} value={b.id}>{staffBranchLabel(b)} {b.name}</option>
            ))}
          </Select>
        </Field>
      )}
    </>
  );
}

function BranchNameCell({ branch }: { branch: Branch }) {
  const type = branchTypeOf(branch);
  return (
    <div className={branch.parentId ? 'branch-name-cell branch-name-cell--child' : 'branch-name-cell'}>
      <strong>{branch.name}</strong>
      <Badge tone="neutral">{BRANCH_TYPES[type].label}</Badge>
      {branch.parent && (
        <span className="text-muted text-sm">隸屬 {staffBranchLabel(branch.parent)}</span>
      )}
    </div>
  );
}

export default function HqBranchesTab({
  branches,
  venues,
  onReload,
}: Pick<HqDataProps, 'branches' | 'venues' | 'onReload'>) {
  const { toast } = useToast();
  const [branchName, setBranchName] = useState('');
  const [branchCode, setBranchCode] = useState('');
  const [branchType, setBranchType] = useState<BranchType>('GYM');
  const [branchParentId, setBranchParentId] = useState<number | ''>('');
  const [branchAddress, setBranchAddress] = useState('');
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [branchEntityId, setBranchEntityId] = useState<number | ''>('');
  const [venueBranchId, setVenueBranchId] = useState<number | ''>(branches[0]?.id ?? '');
  const [venueName, setVenueName] = useState('');
  const [venueStations, setVenueStations] = useState('');
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [editBranchName, setEditBranchName] = useState('');
  const [editBranchCode, setEditBranchCode] = useState('');
  const [editBranchType, setEditBranchType] = useState<BranchType>('GYM');
  const [editBranchParentId, setEditBranchParentId] = useState<number | ''>('');
  const [editBranchAddress, setEditBranchAddress] = useState('');
  const [editBranchEntityId, setEditBranchEntityId] = useState<number | ''>('');
  const [editBranchActive, setEditBranchActive] = useState(true);
  const [editingVenue, setEditingVenue] = useState<Venue | null>(null);
  const [editVenueName, setEditVenueName] = useState('');
  const [editVenueStations, setEditVenueStations] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchHqLegalEntities();
        if (!cancelled) setEntities(res.data || []);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入營業人失敗'), 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  async function handleCreateBranch(e: FormEvent) {
    e.preventDefault();
    const code = normalizeCodeInput(branchCode);
    if (!code) {
      toast('請填寫分店代碼', 'error');
      return;
    }
    const parentErr = branchParentHint(branchType, branchParentId);
    if (parentErr) {
      toast(parentErr, 'error');
      return;
    }
    try {
      const result = await createBranch(branchName, branchAddress || undefined, {
        code,
        type: branchType,
        parentId: branchParentId === '' ? null : branchParentId,
        legalEntityId: branchEntityId === '' ? null : branchEntityId,
      });
      toast(result.message || '分店建立成功', 'success');
      setBranchName('');
      setBranchCode('');
      setBranchType('GYM');
      setBranchParentId('');
      setBranchAddress('');
      setBranchEntityId('');
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '建立分店失敗'), 'error');
    }
  }

  async function handleCreateVenue(e: FormEvent) {
    e.preventDefault();
    if (!venueBranchId) return;
    try {
      const result = await createVenue(
        Number(venueBranchId),
        venueName,
        venueStations.trim() || undefined,
      );
      toast(result.message || '場地建立成功', 'success');
      setVenueName('');
      setVenueStations('');
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '建立場地失敗'), 'error');
    }
  }

  function openEditBranch(b: Branch) {
    setEditingBranch(b);
    setEditBranchName(b.name);
    setEditBranchCode(b.code || '');
    setEditBranchType(branchTypeOf(b));
    setEditBranchParentId(b.parentId ?? '');
    setEditBranchAddress(b.address || '');
    setEditBranchEntityId(b.legalEntityId ?? '');
    setEditBranchActive(b.isActive);
  }

  async function handleUpdateBranch(e?: FormEvent) {
    e?.preventDefault();
    if (!editingBranch) return;
    const code = normalizeCodeInput(editBranchCode);
    if (!code) {
      toast('請填寫分店代碼', 'error');
      return;
    }
    const parentErr = branchParentHint(editBranchType, editBranchParentId);
    if (parentErr) {
      toast(parentErr, 'error');
      return;
    }
    const nextEntityId = editBranchEntityId === '' ? null : editBranchEntityId;
    try {
      const result = await updateHqBranch(editingBranch.id, {
        name: editBranchName,
        code,
        type: editBranchType,
        parentId: editBranchParentId === '' ? null : editBranchParentId,
        address: editBranchAddress || null,
        ...(nextEntityId !== (editingBranch.legalEntityId ?? null) ? { legalEntityId: nextEntityId } : {}),
        isActive: editBranchActive,
      });
      toast(result.message || '分店已更新', 'success');
      setEditingBranch(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '更新分店失敗'), 'error');
    }
  }

  function openEditVenue(v: Venue) {
    setEditingVenue(v);
    setEditVenueName(v.name);
    setEditVenueStations(stationsToInput(v));
  }

  async function handleUpdateVenue(e?: FormEvent) {
    e?.preventDefault();
    if (!editingVenue) return;
    try {
      const result = await updateHqVenue(editingVenue.id, {
        name: editVenueName,
        stations: editVenueStations,
      });
      toast(result.message || '場地已更新', 'success');
      setEditingVenue(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '更新場地失敗'), 'error');
    }
  }

  async function handleDeleteBranch(b: Branch) {
    const msg = b.isActive
      ? `確定刪除分店「${b.name}」？\n若有歷史／綁定資料將改為停用（可再於編輯啟用）；無關聯則永久刪除。`
      : `分店「${b.name}」已停用。若無關聯資料將永久刪除，確定繼續？`;
    if (!window.confirm(msg)) return;
    const key = `b-${b.id}`;
    setBusyKey(key);
    try {
      const result = await deleteHqBranch(b.id);
      toast(result.message || '分店已處理', 'success');
      if (editingBranch?.id === b.id) setEditingBranch(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '刪除分店失敗'), 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDeleteVenue(v: Venue) {
    if (
      !window.confirm(
        `確定刪除場地「${v.name}」？\n站點一併刪除；若仍有課程／期班將無法刪除。`,
      )
    ) {
      return;
    }
    const key = `v-${v.id}`;
    setBusyKey(key);
    try {
      const result = await deleteHqVenue(v.id);
      toast(result.message || '場地已刪除', 'success');
      if (editingVenue?.id === v.id) setEditingVenue(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '刪除場地失敗'), 'error');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <PageSection
      title="分店場地"
      desc="開立分店（類型／隸屬／營業人）、建立場地與站點；員工端關聯顯示「代碼」，會員介面顯示正式名稱"
    >
      <div className="staff-grid">
        <Card title="開立分店">
          <form onSubmit={handleCreateBranch} className="form-stack">
            <Field label="正式名稱" hint="會員介面顯示">
              <Input value={branchName} onChange={(e) => setBranchName(e.target.value)} required />
            </Field>
            <Field label="代碼" hint="員工端篩選／關聯顯示；如 HP、FJ">
              <Input
                value={branchCode}
                onChange={(e) => setBranchCode(normalizeCodeInput(e.target.value))}
                required
                placeholder="HP"
                maxLength={32}
                autoComplete="off"
              />
            </Field>
            <BranchTypeFields
              type={branchType}
              parentId={branchParentId}
              onType={setBranchType}
              onParent={setBranchParentId}
              branches={branches}
            />
            <Field label="地址">
              <Input value={branchAddress} onChange={(e) => setBranchAddress(e.target.value)} />
            </Field>
            <LegalEntitySelect value={branchEntityId} onChange={setBranchEntityId} entities={entities} />
            <Button type="submit">建立分店</Button>
          </form>
        </Card>

        <Card title="建立場地">
          <form onSubmit={handleCreateVenue} className="form-stack">
            <Field label="所屬分店">
              <Select
                value={venueBranchId === '' ? '' : String(venueBranchId)}
                onChange={(e) => setVenueBranchId(Number(e.target.value) || '')}
              >
                {branches.filter((b) => b.isActive).map((b) => (
                  <option key={b.id} value={b.id}>{staffBranchLabel(b)}</option>
                ))}
              </Select>
            </Field>
            <Field label="場地名稱">
              <Input value={venueName} onChange={(e) => setVenueName(e.target.value)} required />
            </Field>
            <Field label="站點" hint="選填；例：A~E、外區（逗號／頓號分隔，字母範圍會自動展開）">
              <Input
                value={venueStations}
                onChange={(e) => setVenueStations(e.target.value)}
                placeholder="A~E、外區"
              />
            </Field>
            <Button type="submit">建立場地</Button>
          </form>
        </Card>
      </div>

      <Card title="分店與場地一覽" className="mt-lg">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>正式名稱</th>
                <th>代碼</th>
                <th>地址</th>
                <th>營業人／統編</th>
                <th>分店狀態</th>
                <th>場地</th>
                <th>站點</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {branches.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-muted text-center">尚無分店</td>
                </tr>
              ) : (
                orderByHierarchy(branches).flatMap((b) => {
                  const branchVenues = venues.filter((v) => v.branchId === b.id);
                  const sellerCell = b.legalEntity
                    ? `${b.legalEntity.name}・統編 ${b.legalEntity.ubn || '—'}`
                    : '未綁定';
                  if (branchVenues.length === 0) {
                    return [
                      <tr key={`b-${b.id}`}>
                        <td>
                          <BranchNameCell branch={b} />
                        </td>
                        <td className="mono">{b.code || '—'}</td>
                        <td>{b.address || '—'}</td>
                        <td className="text-sm">{sellerCell}</td>
                        <td>
                          <Badge tone={b.isActive ? 'success' : 'neutral'}>
                            {b.isActive ? '營運中' : '已停用'}
                          </Badge>
                        </td>
                        <td className="text-muted">—</td>
                        <td className="text-muted">—</td>
                        <td className="table-actions">
                          <Button size="sm" variant="secondary" onClick={() => openEditBranch(b)}>
                            編輯分店
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busyKey === `b-${b.id}`}
                            disabled={busyKey != null && busyKey !== `b-${b.id}`}
                            onClick={() => void handleDeleteBranch(b)}
                          >
                            刪除
                          </Button>
                        </td>
                      </tr>,
                    ];
                  }
                  return branchVenues.map((v, idx) => (
                    <tr key={`v-${v.id}`}>
                      <td>{idx === 0 ? <BranchNameCell branch={b} /> : ''}</td>
                      <td className="mono">{idx === 0 ? b.code || '—' : ''}</td>
                      <td>{idx === 0 ? b.address || '—' : ''}</td>
                      <td className="text-sm">{idx === 0 ? sellerCell : ''}</td>
                      <td>
                        {idx === 0 ? (
                          <Badge tone={b.isActive ? 'success' : 'neutral'}>
                            {b.isActive ? '營運中' : '已停用'}
                          </Badge>
                        ) : null}
                      </td>
                      <td>{v.name}</td>
                      <td className="text-sm">
                        {(v.stations || []).length > 0
                          ? (v.stations || []).map((s) => s.name).join('、')
                          : '未設站點'}
                      </td>
                      <td className="table-actions">
                        <Button size="sm" variant="ghost" onClick={() => openEditVenue(v)}>
                          編輯場地
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyKey === `v-${v.id}`}
                          disabled={busyKey != null && busyKey !== `v-${v.id}`}
                          onClick={() => void handleDeleteVenue(v)}
                        >
                          刪除場地
                        </Button>
                        {idx === 0 ? (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => openEditBranch(b)}>
                              編輯分店
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={busyKey === `b-${b.id}`}
                              disabled={busyKey != null && busyKey !== `b-${b.id}`}
                              onClick={() => void handleDeleteBranch(b)}
                            >
                              刪除分店
                            </Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ));
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={editingBranch !== null}
        title={`編輯分店 · ${editingBranch?.name}`}
        onClose={() => setEditingBranch(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingBranch(null)}>取消</Button>
            <Button onClick={() => void handleUpdateBranch()}>儲存</Button>
          </>
        }
      >
        <form onSubmit={handleUpdateBranch} className="form-stack">
          <Field label="正式名稱" hint="會員介面顯示">
            <Input value={editBranchName} onChange={(e) => setEditBranchName(e.target.value)} required />
          </Field>
          <Field label="代碼" hint="員工端關聯顯示">
            <Input
              value={editBranchCode}
              onChange={(e) => setEditBranchCode(normalizeCodeInput(e.target.value))}
              required
              maxLength={32}
              autoComplete="off"
            />
          </Field>
          <BranchTypeFields
            type={editBranchType}
            parentId={editBranchParentId}
            onType={setEditBranchType}
            onParent={setEditBranchParentId}
            branches={branches}
            selfId={editingBranch?.id}
          />
          <Field label="地址">
            <Input value={editBranchAddress} onChange={(e) => setEditBranchAddress(e.target.value)} />
          </Field>
          <LegalEntitySelect value={editBranchEntityId} onChange={setEditBranchEntityId} entities={entities} />
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editBranchActive}
              onChange={(e) => setEditBranchActive(e.target.checked)}
            />
            分店啟用中
          </label>
        </form>
      </Modal>

      <Modal
        open={editingVenue !== null}
        title={`編輯場地 · ${staffBranchLabel(editingVenue?.branch) || ''}`}
        onClose={() => setEditingVenue(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingVenue(null)}>取消</Button>
            <Button onClick={() => void handleUpdateVenue()}>儲存</Button>
          </>
        }
      >
        <form onSubmit={handleUpdateVenue} className="form-stack">
          <Field label="場地名稱">
            <Input value={editVenueName} onChange={(e) => setEditVenueName(e.target.value)} required />
          </Field>
          <Field label="站點" hint="例：A~E、外區；清空則移除此場地全部站點">
            <Input
              value={editVenueStations}
              onChange={(e) => setEditVenueStations(e.target.value)}
              placeholder="A~E、外區"
            />
          </Field>
        </form>
      </Modal>
    </PageSection>
  );
}
