import { type FormEvent, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  assignTrainer,
  createHqStaff,
  createHqTrainer,
  getErrorMessage,
  updateHqStaff,
  updateHqTrainer,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import { ALL_STAFF_PERMISSIONS, STAFF_PERMISSION_LABELS, STAFF_ROLE_LABELS } from '../../../lib/staffPermissions';
import type { StaffAccount, Trainer } from '../../../types/api';
import type { StaffPermission, StaffRole } from '../../../lib/storage';
import type { HqDataProps } from './types';

export default function HqPeopleTab({
  branches,
  staffList,
  trainers,
  onReload,
}: Pick<HqDataProps, 'branches' | 'staffList' | 'trainers' | 'onReload'>) {
  const { toast } = useToast();

  const [staffAccount, setStaffAccount] = useState('');
  const [staffPassword, setStaffPassword] = useState('');
  const [staffName, setStaffName] = useState('');
  const [staffDisplayName, setStaffDisplayName] = useState('匿名');
  const [staffRole, setStaffRole] = useState<StaffRole>('STAFF');
  const [staffBranchId, setStaffBranchId] = useState<number | ''>(branches[0]?.id ?? '');
  const [staffPermissions, setStaffPermissions] = useState<StaffPermission[]>(['ops']);

  const [trainerName, setTrainerName] = useState('');
  const [trainerDisplayName, setTrainerDisplayName] = useState('匿名');
  const [trainerPhone, setTrainerPhone] = useState('');
  const [trainerRole, setTrainerRole] = useState<'NORMAL' | 'MANAGER'>('NORMAL');
  const [trainerBranchIds, setTrainerBranchIds] = useState<number[]>([]);
  const [existingTrainerId, setExistingTrainerId] = useState<number | ''>('');

  const [editingStaff, setEditingStaff] = useState<StaffAccount | null>(null);
  const [editStaffName, setEditStaffName] = useState('');
  const [editStaffDisplayName, setEditStaffDisplayName] = useState('匿名');
  const [editStaffRole, setEditStaffRole] = useState<StaffRole>('STAFF');
  const [editStaffBranchId, setEditStaffBranchId] = useState<number | ''>('');
  const [editStaffPermissions, setEditStaffPermissions] = useState<StaffPermission[]>([]);
  const [editStaffActive, setEditStaffActive] = useState(true);
  const [editStaffPassword, setEditStaffPassword] = useState('');

  const [editingTrainer, setEditingTrainer] = useState<Trainer | null>(null);
  const [editTrainerName, setEditTrainerName] = useState('');
  const [editTrainerDisplayName, setEditTrainerDisplayName] = useState('匿名');
  const [editTrainerPhone, setEditTrainerPhone] = useState('');
  const [editTrainerRole, setEditTrainerRole] = useState<'NORMAL' | 'MANAGER'>('NORMAL');
  const [editTrainerActive, setEditTrainerActive] = useState(true);
  const [editTrainerStaffId, setEditTrainerStaffId] = useState<number | ''>('');
  const [editTrainerBranchIds, setEditTrainerBranchIds] = useState<number[]>([]);

  const [staffBranchFilter, setStaffBranchFilter] = useState<number | 'ALL' | 'HQ'>('ALL');
  const [trainerBranchFilter, setTrainerBranchFilter] = useState<number | 'ALL'>('ALL');

  const filteredStaff = staffList.filter((s) => {
    if (staffBranchFilter === 'ALL') return true;
    if (staffBranchFilter === 'HQ') return s.role === 'ADMIN' || s.branchId == null;
    return s.branchId === staffBranchFilter;
  });

  const filteredTrainers = trainers.filter((t) => {
    if (trainerBranchFilter === 'ALL') return true;
    return (t.branches || []).some((b) => b.branchId === trainerBranchFilter);
  });

  function toggleStaffPermission(perm: StaffPermission) {
    setStaffPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  }

  function toggleEditStaffPermission(perm: StaffPermission) {
    setEditStaffPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  }

  function toggleTrainerBranch(id: number) {
    setTrainerBranchIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function toggleEditTrainerBranch(id: number) {
    setEditTrainerBranchIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleCreateStaff(e: FormEvent) {
    e.preventDefault();
    if (staffRole !== 'ADMIN' && !staffBranchId) {
      toast('STAFF/DUTY/MANAGER 必須選擇分店', 'error');
      return;
    }
    if (staffRole !== 'ADMIN' && staffPermissions.length === 0) {
      toast('至少勾選一項模組權限', 'error');
      return;
    }
    try {
      const result = await createHqStaff({
        account: staffAccount,
        password: staffPassword,
        name: staffName,
        displayName: staffDisplayName.trim() || '匿名',
        role: staffRole,
        branchId: staffRole === 'ADMIN' ? null : Number(staffBranchId),
        permissions: staffRole === 'ADMIN' ? [] : staffPermissions,
      });
      toast(result.message || '員工已建立', 'success');
      setStaffAccount('');
      setStaffPassword('');
      setStaffName('');
      setStaffDisplayName('匿名');
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '建立員工失敗'), 'error');
    }
  }

  async function handleTrainerSubmit(e: FormEvent) {
    e.preventDefault();
    if (trainerRole === 'NORMAL' && trainerBranchIds.length === 0) {
      toast('一般教練須至少指派一間指定分店', 'error');
      return;
    }
    try {
      let trainerId = existingTrainerId ? Number(existingTrainerId) : 0;
      if (!trainerId) {
        if (!trainerName.trim() || !trainerPhone.trim()) {
          toast('新建教練須填姓名與電話', 'error');
          return;
        }
        const created = await createHqTrainer({
          name: trainerName.trim(),
          displayName: trainerDisplayName.trim() || '匿名',
          phone: trainerPhone.trim(),
          role: trainerRole,
        });
        const id = created.data?.id;
        if (!id) {
          toast(created.message || '建立教練失敗', 'error');
          return;
        }
        trainerId = id;
      }

      const result = await assignTrainer(trainerId, trainerRole, trainerBranchIds);
      toast(
        existingTrainerId
          ? result.message || '教練分店權限已更新'
          : result.message || '教練已建立並完成分店指派',
        'success',
      );
      setTrainerName('');
      setTrainerDisplayName('匿名');
      setTrainerPhone('');
      setTrainerRole('NORMAL');
      setTrainerBranchIds([]);
      setExistingTrainerId('');
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '教練操作失敗'), 'error');
    }
  }

  function openEditStaff(s: StaffAccount) {
    setEditingStaff(s);
    setEditStaffName(s.name);
    setEditStaffDisplayName(s.displayName || '匿名');
    setEditStaffRole(s.role);
    setEditStaffBranchId(s.branchId ?? '');
    setEditStaffPermissions(s.permissions || []);
    setEditStaffActive(s.isActive);
    setEditStaffPassword('');
  }

  async function handleUpdateStaff(e: FormEvent) {
    e.preventDefault();
    if (!editingStaff) return;
    if (editStaffRole !== 'ADMIN' && !editStaffBranchId) {
      toast('STAFF/DUTY/MANAGER 必須選擇分店', 'error');
      return;
    }
    if (editStaffRole !== 'ADMIN' && editStaffPermissions.length === 0) {
      toast('至少勾選一項模組權限', 'error');
      return;
    }
    try {
      const payload: Parameters<typeof updateHqStaff>[1] = {
        name: editStaffName,
        displayName: editStaffDisplayName.trim() || '匿名',
        role: editStaffRole,
        branchId: editStaffRole === 'ADMIN' ? null : Number(editStaffBranchId),
        permissions: editStaffRole === 'ADMIN' ? [] : editStaffPermissions,
        isActive: editStaffActive,
      };
      if (editStaffPassword.trim()) payload.password = editStaffPassword;
      const result = await updateHqStaff(editingStaff.id, payload);
      toast(result.message || '員工已更新', 'success');
      setEditingStaff(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '更新員工失敗'), 'error');
    }
  }

  function openEditTrainer(t: Trainer) {
    setEditingTrainer(t);
    setEditTrainerName(t.name);
    setEditTrainerDisplayName(t.displayName || '匿名');
    setEditTrainerPhone(t.phone || '');
    setEditTrainerRole(t.role === 'MANAGER' ? 'MANAGER' : 'NORMAL');
    setEditTrainerActive(t.isActive !== false);
    setEditTrainerStaffId(t.staffId ?? t.staff?.id ?? '');
    setEditTrainerBranchIds((t.branches || []).map((b) => b.branchId).filter(Boolean));
  }

  async function handleUpdateTrainer(e: FormEvent) {
    e.preventDefault();
    if (!editingTrainer) return;
    if (editTrainerRole === 'NORMAL' && editTrainerBranchIds.length === 0) {
      toast('一般教練須至少指派一間指定分店', 'error');
      return;
    }
    try {
      const result = await updateHqTrainer(editingTrainer.id, {
        name: editTrainerName,
        displayName: editTrainerDisplayName.trim() || '匿名',
        phone: editTrainerPhone,
        role: editTrainerRole,
        isActive: editTrainerActive,
        staffId: editTrainerStaffId === '' ? null : Number(editTrainerStaffId),
      });
      await assignTrainer(editingTrainer.id, editTrainerRole, editTrainerBranchIds);
      toast(result.message || '教練已更新', 'success');
      setEditingTrainer(null);
      await onReload();
    } catch (err) {
      toast(getErrorMessage(err, '更新教練失敗'), 'error');
    }
  }

  return (
    <PageSection title="員工管理" desc="員工帳號與教練權限；STAFF/DUTY/MANAGER 須綁定分店 · 交易異動限 DUTY 以上">
      <div className="staff-grid">
        <Card title="新增員工">
          <form onSubmit={handleCreateStaff} className="form-stack">
            <Field label="登入帳號">
              <Input value={staffAccount} onChange={(e) => setStaffAccount(e.target.value)} required />
            </Field>
            <Field label="初始密碼">
              <Input type="password" value={staffPassword} onChange={(e) => setStaffPassword(e.target.value)} required />
            </Field>
            <Field label="真實姓名">
              <Input value={staffName} onChange={(e) => setStaffName(e.target.value)} required />
            </Field>
            <Field label="顯示名稱" hint="側欄／對外顯示；預設匿名">
              <Input
                value={staffDisplayName}
                onChange={(e) => setStaffDisplayName(e.target.value)}
                placeholder="匿名"
              />
            </Field>
            <Field label="角色" hint="DUTY 以上可進入「交易異動」">
              <Select
                value={staffRole}
                onChange={(e) => {
                  const role = e.target.value as StaffRole;
                  setStaffRole(role);
                  if (role === 'ADMIN') setStaffPermissions([]);
                }}
              >
                <option value="STAFF">{STAFF_ROLE_LABELS.STAFF}</option>
                <option value="DUTY">{STAFF_ROLE_LABELS.DUTY}</option>
                <option value="MANAGER">{STAFF_ROLE_LABELS.MANAGER}</option>
                <option value="ADMIN">{STAFF_ROLE_LABELS.ADMIN}</option>
              </Select>
            </Field>
            {staffRole !== 'ADMIN' && (
              <>
                <Field label="綁定分店">
                  <Select
                    value={staffBranchId === '' ? '' : String(staffBranchId)}
                    onChange={(e) => setStaffBranchId(Number(e.target.value) || '')}
                    required
                  >
                    <option value="">— 請選擇 —</option>
                    {branches.filter((b) => b.isActive).map((b) => (
                      <option key={b.id} value={b.id}>{staffBranchLabel(b)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="模組權限">
                  <div className="checkbox-group">
                    {ALL_STAFF_PERMISSIONS.map((perm) => (
                      <label key={perm} className="checkbox-item">
                        <input
                          type="checkbox"
                          checked={staffPermissions.includes(perm)}
                          onChange={() => toggleStaffPermission(perm)}
                        />
                        {STAFF_PERMISSION_LABELS[perm]}
                      </label>
                    ))}
                  </div>
                </Field>
              </>
            )}
            <Button type="submit">建立員工</Button>
          </form>
        </Card>

        <Card
          title="新增教練與分店權限"
          subtitle="可新建教練或改指派既有教練 · 一般教練綁定指定分店（可多間）· 主管教練不限分店"
        >
          <form onSubmit={handleTrainerSubmit} className="form-stack">
            <Field label="既有教練（選填）" hint="選擇後改為更新該教練分店權限，無需再填姓名電話">
              <Select
                value={existingTrainerId === '' ? '' : String(existingTrainerId)}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : '';
                  setExistingTrainerId(id);
                  if (id) {
                    const t = trainers.find((x) => x.id === id);
                    if (t) {
                      setTrainerRole(t.role === 'MANAGER' ? 'MANAGER' : 'NORMAL');
                      setTrainerBranchIds(
                        (t.branches || []).map((b) => b.branchId).filter(Boolean),
                      );
                    }
                  } else {
                    setTrainerBranchIds([]);
                  }
                }}
              >
                <option value="">— 新建教練 —</option>
                {trainers
                  .filter((t) => t.isActive !== false)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}（{t.role}）
                    </option>
                  ))}
              </Select>
            </Field>
            {!existingTrainerId && (
              <>
                <Field label="真實姓名">
                  <Input
                    value={trainerName}
                    onChange={(e) => setTrainerName(e.target.value)}
                    required
                  />
                </Field>
                <Field label="顯示名稱" hint="會員／LINE 顯示；預設匿名">
                  <Input
                    value={trainerDisplayName}
                    onChange={(e) => setTrainerDisplayName(e.target.value)}
                    placeholder="匿名"
                  />
                </Field>
                <Field label="電話">
                  <Input
                    value={trainerPhone}
                    onChange={(e) => setTrainerPhone(e.target.value)}
                    required
                    inputMode="tel"
                  />
                </Field>
              </>
            )}
            <Field label="教練角色">
              <Select
                value={trainerRole}
                onChange={(e) => {
                  setTrainerRole(e.target.value as 'NORMAL' | 'MANAGER');
                }}
              >
                <option value="NORMAL">NORMAL 一般教練</option>
                <option value="MANAGER">MANAGER 主管教練</option>
              </Select>
            </Field>
            <Field
              label="指派分店"
              hint={
                trainerRole === 'MANAGER'
                  ? '主管不限分店：可不勾選；勾選僅作備註／篩選用'
                  : '一般教練僅能在已勾選的指定分店授課（可多選）'
              }
            >
              <div className="checkbox-group">
                {branches
                  .filter((b) => b.isActive)
                  .map((b) => (
                    <label key={b.id} className="checkbox-item">
                      <input
                        type="checkbox"
                        checked={trainerBranchIds.includes(b.id)}
                        onChange={() => toggleTrainerBranch(b.id)}
                      />
                      {staffBranchLabel(b)}
                    </label>
                  ))}
              </div>
            </Field>
            <Button
              type="submit"
              disabled={trainerRole === 'NORMAL' && trainerBranchIds.length === 0}
            >
              {existingTrainerId ? '儲存分店權限' : '建立教練並指派分店'}
            </Button>
          </form>
        </Card>
      </div>

      <Card
        title="員工一覽"
        className="mt-lg"
        subtitle={`顯示 ${filteredStaff.length}／${staffList.length} 人`}
      >
        <div className="list-toolbar">
          <span className="text-muted text-sm">分店篩選</span>
          <Select
            value={String(staffBranchFilter)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'ALL' || v === 'HQ') setStaffBranchFilter(v);
              else setStaffBranchFilter(Number(v));
            }}
            aria-label="員工分店篩選"
          >
            <option value="ALL">全部分店（{staffList.length}）</option>
            <option value="HQ">
              全連鎖／未綁店（
              {staffList.filter((s) => s.role === 'ADMIN' || s.branchId == null).length}）
            </option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {staffBranchLabel(b)}（{staffList.filter((s) => s.branchId === b.id).length}）
              </option>
            ))}
          </Select>
        </div>
        <div className="table-wrap mt-md">
          <table className="data-table">
            <thead>
              <tr>
                <th>帳號</th>
                <th>真實姓名</th>
                <th>顯示名稱</th>
                <th>角色</th>
                <th>分店</th>
                <th>權限</th>
                <th>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredStaff.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.account}</td>
                  <td>{s.name}</td>
                  <td>{s.displayName || '匿名'}</td>
                  <td>{s.role}</td>
                  <td>{staffBranchLabel(s.branch) || (s.role === 'ADMIN' ? '全連鎖' : '—')}</td>
                  <td>
                    {s.role === 'ADMIN'
                      ? '全部'
                      : (s.permissions || []).map((p) => STAFF_PERMISSION_LABELS[p]).join('、') || '—'}
                  </td>
                  <td>
                    <Badge tone={s.isActive ? 'success' : 'neutral'}>{s.isActive ? '啟用' : '停權'}</Badge>
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => openEditStaff(s)}>編輯</Button>
                  </td>
                </tr>
              ))}
              {filteredStaff.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted text-center">
                    {staffList.length === 0 ? '尚無員工' : '此分店尚無員工'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="教練一覽"
        className="mt-lg"
        subtitle={`顯示 ${filteredTrainers.length}／${trainers.length} 人`}
      >
        <div className="list-toolbar">
          <span className="text-muted text-sm">分店篩選</span>
          <Select
            value={trainerBranchFilter === 'ALL' ? 'ALL' : String(trainerBranchFilter)}
            onChange={(e) => {
              const v = e.target.value;
              setTrainerBranchFilter(v === 'ALL' ? 'ALL' : Number(v));
            }}
            aria-label="教練分店篩選"
          >
            <option value="ALL">全部分店（{trainers.length}）</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {staffBranchLabel(b)}（
                {trainers.filter((t) => (t.branches || []).some((x) => x.branchId === b.id)).length}）
              </option>
            ))}
          </Select>
        </div>
        <div className="table-wrap mt-md">
          <table className="data-table">
            <thead>
              <tr>
                <th>真實姓名</th>
                <th>顯示名稱</th>
                <th>電話</th>
                <th>角色</th>
                <th>指派分店</th>
                <th>綁定帳號</th>
                <th>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredTrainers.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.displayName || '匿名'}</td>
                  <td className="mono">{t.phone}</td>
                  <td>{t.role}</td>
                  <td>
                    {(t.branches || []).map((b) => staffBranchLabel(b.branch)).join('、') ||
                      (t.role === 'MANAGER' ? '不限分店' : '—')}
                  </td>
                  <td className="text-sm">
                    {t.staff
                      ? `${t.staff.name}（${t.staff.account}）`
                      : '—'}
                  </td>
                  <td>
                    <Badge tone={t.isActive !== false ? 'success' : 'neutral'}>
                      {t.isActive !== false ? '啟用' : '停權'}
                    </Badge>
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" onClick={() => openEditTrainer(t)}>編輯</Button>
                  </td>
                </tr>
              ))}
              {filteredTrainers.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted text-center">
                    {trainers.length === 0 ? '尚無教練' : '此分店尚無指派教練'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={editingStaff !== null}
        title={`編輯員工 · ${editingStaff?.account}`}
        onClose={() => setEditingStaff(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingStaff(null)}>取消</Button>
            <Button onClick={handleUpdateStaff}>儲存</Button>
          </>
        }
      >
        <form onSubmit={handleUpdateStaff} className="form-stack">
          <Field label="真實姓名">
            <Input value={editStaffName} onChange={(e) => setEditStaffName(e.target.value)} required />
          </Field>
          <Field label="顯示名稱" hint="側欄／對外顯示；預設匿名">
            <Input
              value={editStaffDisplayName}
              onChange={(e) => setEditStaffDisplayName(e.target.value)}
              placeholder="匿名"
            />
          </Field>
          <Field label="角色" hint="DUTY 以上可進入「交易異動」">
            <Select
              value={editStaffRole}
              onChange={(e) => {
                const role = e.target.value as StaffRole;
                setEditStaffRole(role);
                if (role === 'ADMIN') setEditStaffPermissions([]);
              }}
            >
              <option value="STAFF">{STAFF_ROLE_LABELS.STAFF}</option>
              <option value="DUTY">{STAFF_ROLE_LABELS.DUTY}</option>
              <option value="MANAGER">{STAFF_ROLE_LABELS.MANAGER}</option>
              <option value="ADMIN">{STAFF_ROLE_LABELS.ADMIN}</option>
            </Select>
          </Field>
          {editStaffRole !== 'ADMIN' && (
            <>
              <Field label="綁定分店">
                <Select
                  value={editStaffBranchId === '' ? '' : String(editStaffBranchId)}
                  onChange={(e) => setEditStaffBranchId(Number(e.target.value) || '')}
                  required
                >
                  <option value="">— 請選擇 —</option>
                  {branches.filter((b) => b.isActive).map((b) => (
                    <option key={b.id} value={b.id}>{staffBranchLabel(b)}</option>
                  ))}
                </Select>
              </Field>
              <Field label="模組權限">
                <div className="checkbox-group">
                  {ALL_STAFF_PERMISSIONS.map((perm) => (
                    <label key={perm} className="checkbox-item">
                      <input
                        type="checkbox"
                        checked={editStaffPermissions.includes(perm)}
                        onChange={() => toggleEditStaffPermission(perm)}
                      />
                      {STAFF_PERMISSION_LABELS[perm]}
                    </label>
                  ))}
                </div>
              </Field>
            </>
          )}
          <Field label="重設密碼（選填）">
            <Input type="password" value={editStaffPassword} onChange={(e) => setEditStaffPassword(e.target.value)} placeholder="留空則不變更" />
          </Field>
          <label className="checkbox-item">
            <input type="checkbox" checked={editStaffActive} onChange={(e) => setEditStaffActive(e.target.checked)} />
            帳號啟用
          </label>
        </form>
      </Modal>

      <Modal
        open={editingTrainer !== null}
        title={`編輯教練 · ${editingTrainer?.name}`}
        onClose={() => setEditingTrainer(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingTrainer(null)}>取消</Button>
            <Button onClick={handleUpdateTrainer}>儲存</Button>
          </>
        }
      >
        <form onSubmit={handleUpdateTrainer} className="form-stack">
          <Field label="真實姓名">
            <Input value={editTrainerName} onChange={(e) => setEditTrainerName(e.target.value)} required />
          </Field>
          <Field label="顯示名稱" hint="會員／LINE 顯示；預設匿名">
            <Input
              value={editTrainerDisplayName}
              onChange={(e) => setEditTrainerDisplayName(e.target.value)}
              placeholder="匿名"
            />
          </Field>
          <Field label="電話">
            <Input value={editTrainerPhone} onChange={(e) => setEditTrainerPhone(e.target.value)} required />
          </Field>
          <Field label="角色">
            <Select value={editTrainerRole} onChange={(e) => setEditTrainerRole(e.target.value as 'NORMAL' | 'MANAGER')}>
              <option value="NORMAL">NORMAL</option>
              <option value="MANAGER">MANAGER</option>
            </Select>
          </Field>
          <Field
            label="指派分店"
            hint={
              editTrainerRole === 'MANAGER'
                ? '主管不限分店：可不勾選；勾選僅作備註／篩選用'
                : '一般教練僅能在已勾選的指定分店授課（可多選）'
            }
          >
            <div className="checkbox-group">
              {branches
                .filter((b) => b.isActive)
                .map((b) => (
                  <label key={b.id} className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={editTrainerBranchIds.includes(b.id)}
                      onChange={() => toggleEditTrainerBranch(b.id)}
                    />
                    {staffBranchLabel(b)}
                  </label>
                ))}
            </div>
          </Field>
          <label className="checkbox-item">
            <input type="checkbox" checked={editTrainerActive} onChange={(e) => setEditTrainerActive(e.target.checked)} />
            教練啟用
          </label>
          <Field
            label="綁定員工帳號"
            hint="教練工作區僅顯示本人資料；需具備 trainer 模組權限。選「不綁定」可解除。"
          >
            <Select
              value={editTrainerStaffId === '' ? '' : String(editTrainerStaffId)}
              onChange={(e) =>
                setEditTrainerStaffId(e.target.value ? Number(e.target.value) : '')
              }
            >
              <option value="">— 不綁定 —</option>
              {staffList
                .filter((s) => s.isActive !== false)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{s.account}）
                    {s.role === 'ADMIN' || (s.permissions || []).includes('trainer')
                      ? ''
                      : ' · 缺 trainer 權限'}
                  </option>
                ))}
            </Select>
          </Field>
        </form>
      </Modal>
    </PageSection>
  );
}
