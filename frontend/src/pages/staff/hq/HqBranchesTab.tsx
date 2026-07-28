import { type FormEvent, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, PageSection, Select } from '../../../components/ui';
import {
  isValidTaiwanUbn,
  normalizeUbnDigits,
  validateOptionalSellerUbn,
} from '../../../components/staff/InvoiceCarrierField';
import { useToast } from '../../../contexts/ToastContext';
import {
  createBranch,
  createVenue,
  deleteHqBranch,
  deleteHqVenue,
  getErrorMessage,
  updateHqBranch,
  updateHqVenue,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import type { Branch, Venue } from '../../../types/api';
import type { HqDataProps } from './types';

function stationsToInput(v: Venue | null) {
  return (v?.stations || []).map((s) => s.name).join('、');
}

function normalizeCodeInput(raw: string) {
  return raw.trim().replace(/\s+/g, '').slice(0, 32);
}

export default function HqBranchesTab({
  branches,
  venues,
  onReload,
}: Pick<HqDataProps, 'branches' | 'venues' | 'onReload'>) {
  const { toast } = useToast();
  const [branchName, setBranchName] = useState('');
  const [branchCode, setBranchCode] = useState('');
  const [branchAddress, setBranchAddress] = useState('');
  const [branchSellerName, setBranchSellerName] = useState('');
  const [branchSellerUbn, setBranchSellerUbn] = useState('');
  const [venueBranchId, setVenueBranchId] = useState<number | ''>(branches[0]?.id ?? '');
  const [venueName, setVenueName] = useState('');
  const [venueStations, setVenueStations] = useState('');
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [editBranchName, setEditBranchName] = useState('');
  const [editBranchCode, setEditBranchCode] = useState('');
  const [editBranchAddress, setEditBranchAddress] = useState('');
  const [editBranchSellerName, setEditBranchSellerName] = useState('');
  const [editBranchSellerUbn, setEditBranchSellerUbn] = useState('');
  const [editBranchActive, setEditBranchActive] = useState(true);
  const [editingVenue, setEditingVenue] = useState<Venue | null>(null);
  const [editVenueName, setEditVenueName] = useState('');
  const [editVenueStations, setEditVenueStations] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function handleCreateBranch(e: FormEvent) {
    e.preventDefault();
    const code = normalizeCodeInput(branchCode);
    if (!code) {
      toast('請填寫分店代碼', 'error');
      return;
    }
    const ubnErr = validateOptionalSellerUbn(branchSellerUbn);
    if (ubnErr) {
      toast(ubnErr, 'error');
      return;
    }
    const ubn = normalizeUbnDigits(branchSellerUbn);
    try {
      const result = await createBranch(branchName, branchAddress || undefined, {
        code,
        invoiceSellerName: branchSellerName.trim() || undefined,
        invoiceSellerUbn: ubn || undefined,
      });
      toast(result.message || '分店建立成功', 'success');
      setBranchName('');
      setBranchCode('');
      setBranchAddress('');
      setBranchSellerName('');
      setBranchSellerUbn('');
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
    setEditBranchAddress(b.address || '');
    setEditBranchSellerName(b.invoiceSellerName || '');
    setEditBranchSellerUbn(normalizeUbnDigits(b.invoiceSellerUbn || ''));
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
    const ubnErr = validateOptionalSellerUbn(editBranchSellerUbn);
    if (ubnErr) {
      toast(ubnErr, 'error');
      return;
    }
    const ubn = normalizeUbnDigits(editBranchSellerUbn);
    try {
      const result = await updateHqBranch(editingBranch.id, {
        name: editBranchName,
        code,
        address: editBranchAddress || null,
        invoiceSellerName: editBranchSellerName.trim() || null,
        invoiceSellerUbn: ubn || null,
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
      desc="開立分店、建立場地與站點；員工端關聯顯示「代碼」，會員介面顯示正式名稱"
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
            <Field label="地址">
              <Input value={branchAddress} onChange={(e) => setBranchAddress(e.target.value)} />
            </Field>
            <Field
              label="發票／折讓抬頭"
              hint="營業人名稱；空白則用系統預設（環境變數）"
            >
              <Input
                value={branchSellerName}
                onChange={(e) => setBranchSellerName(e.target.value)}
                placeholder="例：某某運動有限公司"
              />
            </Field>
            <Field
              label="抬頭統編"
              hint="選填；填寫須為真實 8 碼統編（含檢查碼）。留空可直接存檔"
            >
              <Input
                value={branchSellerUbn}
                onChange={(e) => setBranchSellerUbn(normalizeUbnDigits(e.target.value))}
                placeholder="選填"
                inputMode="numeric"
                maxLength={8}
                autoComplete="off"
              />
            </Field>
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
                <th>發票抬頭</th>
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
                branches.flatMap((b) => {
                  const branchVenues = venues.filter((v) => v.branchId === b.id);
                  const sellerCell = b.invoiceSellerName
                    ? `${b.invoiceSellerName}${b.invoiceSellerUbn ? `（${b.invoiceSellerUbn}）` : ''}`
                    : '系統預設';
                  if (branchVenues.length === 0) {
                    return [
                      <tr key={`b-${b.id}`}>
                        <td>
                          <strong>{b.name}</strong>
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
                      <td>{idx === 0 ? <strong>{b.name}</strong> : ''}</td>
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
          <Field label="地址">
            <Input value={editBranchAddress} onChange={(e) => setEditBranchAddress(e.target.value)} />
          </Field>
          <Field
            label="發票／折讓抬頭"
            hint="營業人名稱；空白則用系統預設"
          >
            <Input
              value={editBranchSellerName}
              onChange={(e) => setEditBranchSellerName(e.target.value)}
              placeholder="例：某某運動有限公司"
            />
          </Field>
          <Field
            label="抬頭統編"
            hint={
              editBranchSellerUbn && !isValidTaiwanUbn(editBranchSellerUbn)
                ? editBranchSellerUbn.length < 8
                  ? '尚缺碼數，或清空此欄即可存檔'
                  : '檢查碼不正確；請改正或清空後再存'
                : '選填；清空則清除已存統編'
            }
          >
            <Input
              value={editBranchSellerUbn}
              onChange={(e) => setEditBranchSellerUbn(normalizeUbnDigits(e.target.value))}
              placeholder="選填"
              inputMode="numeric"
              maxLength={8}
              autoComplete="off"
            />
          </Field>
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
