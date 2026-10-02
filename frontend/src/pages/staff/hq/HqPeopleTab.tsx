import { type FormEvent, type ReactNode, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageSection, Select } from '../../../components/ui';
import StaffAvatar from '../../../components/staff/StaffAvatar';
import StaffPhotoPanel from '../../../components/staff/StaffPhotoPanel';
import { useToast } from '../../../contexts/ToastContext';
import { useStaffAuth } from '../../../contexts/StaffAuthContext';
import {
  assignTrainer,
  createHqStaff,
  createHqTrainer,
  getErrorMessage,
  updateHqStaff,
  updateHqTrainer,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import { ALL_STAFF_PERMISSIONS, STAFF_PERMISSION_LABELS } from '../../../lib/staffPermissions';
import {
  ALL_POSITIONS,
  BRANCH_TYPES,
  DEPARTMENT_LABELS,
  POSITIONS,
  TRAINER_LEVEL_LABELS,
  TRAINER_ROLE_LABELS,
  type Position,
  type TrainerLevel,
  type TrainerRole,
  type BranchType,
  branchTypeOf,
  canonicalPosition,
  departmentOf,
  isCrossBranchRole,
  isManagerTrainer,
  isPosition,
  positionFitsBranchType,
  positionLabel,
  trainerLevelOf,
  trainerRoleOf,
} from '../../../lib/orgStructure';
import type { Branch, StaffAccount, StaffLeaveBalance, Trainer } from '../../../types/api';
import {
  ALL_EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPE_SHORT,
  FULL_TIME_WEEKLY_HOURS,
  employmentTypeOf,
  formatDays,
  formatLeaveQuota,
  formatSeniority,
  taipeiToday,
  type EmploymentType,
} from '../../../lib/laborLaw';
import type { StaffPermission, StaffRole } from '../../../lib/storage';
import type { HqDataProps } from './types';

type ScopeFilter = 'ALL' | 'HQ' | number;
type ListView = 'staff' | 'trainers';

const levelLabel = (level: TrainerLevel) => `${level} ${TRAINER_LEVEL_LABELS[level]}`;

function roleOptionLabel(role: string) {
  return canonicalPosition(role) === role ? positionLabel(role) : `${positionLabel(role)}（舊制 ${role}）`;
}

function branchOptionLabel(b: Branch) {
  return `${staffBranchLabel(b)}（${BRANCH_TYPES[branchTypeOf(b)].label}）`;
}

/** 部門欄：店長顯示所屬分店類型主管 */
function departmentLabel(role: string) {
  const dept = departmentOf(role);
  if (dept) return DEPARTMENT_LABELS[dept];
  return canonicalPosition(role) ? '分店主管' : '—';
}

interface StaffFormState {
  account: string;
  password: string;
  name: string;
  displayName: string;
  role: StaffRole;
  branchId: number | '';
  permissions: StaffPermission[];
  isActive: boolean;
  employmentType: EmploymentType;
  hireDate: string;
  weeklyHours: string;
  laborActApplies: boolean;
}

interface TrainerFormState {
  name: string;
  displayName: string;
  phone: string;
  role: TrainerRole;
  level: TrainerLevel;
  branchIds: number[];
  isActive: boolean;
  staffId: number | '';
}

const emptyStaffForm = (branchId: number | ''): StaffFormState => ({
  account: '',
  password: '',
  name: '',
  displayName: '匿名',
  role: 'STAFF',
  branchId,
  permissions: ['ops'],
  isActive: true,
  employmentType: 'FULL_TIME',
  hireDate: taipeiToday(),
  weeklyHours: '',
  laborActApplies: true,
});

const emptyTrainerForm = (branchIds: number[]): TrainerFormState => ({
  name: '',
  displayName: '匿名',
  phone: '',
  role: 'NORMAL',
  level: 'SILVER',
  branchIds,
  isActive: true,
  staffId: '',
});

function toggleIn<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function validateEmployment(f: StaffFormState, mode: 'create' | 'edit'): string | null {
  if (mode === 'create' && !f.hireDate) return '請填寫到職日';
  const hours = f.weeklyHours.trim() === '' ? null : Number(f.weeklyHours);
  if (f.employmentType === 'PART_TIME') {
    if (hours === null) return '兼職須填寫約定每週工時';
    if (!(hours > 0 && hours < FULL_TIME_WEEKLY_HOURS)) return `兼職週工時須介於 0～${FULL_TIME_WEEKLY_HOURS} 小時（不含）`;
  }
  if (f.employmentType === 'INTERN' && hours !== null && !(hours > 0 && hours <= FULL_TIME_WEEKLY_HOURS)) {
    return `實習週工時須介於 0～${FULL_TIME_WEEKLY_HOURS} 小時`;
  }
  return null;
}

function validateStaffForm(f: StaffFormState, branches: Branch[], mode: 'create' | 'edit'): string | null {
  const employmentError = validateEmployment(f, mode);
  if (employmentError) return employmentError;
  const cross = isCrossBranchRole(f.role);
  if (!cross && !f.branchId) return '店長／場務／教練須綁定所屬分店';
  const branch = branches.find((b) => b.id === f.branchId);
  if (!cross && branch && !positionFitsBranchType(f.role, branchTypeOf(branch))) {
    return `${positionLabel(f.role)} 不可綁定於${BRANCH_TYPES[branchTypeOf(branch)].label}（${staffBranchLabel(branch)}）`;
  }
  if (!isPosition(f.role, 'ADMIN') && f.permissions.length === 0) return '至少勾選一項模組權限';
  return null;
}

function staffPayload(f: StaffFormState) {
  const hq = isCrossBranchRole(f.role);
  const admin = isPosition(f.role, 'ADMIN');
  return {
    name: f.name.trim(),
    displayName: f.displayName.trim() || '匿名',
    role: f.role,
    branchId: admin || (hq && !f.branchId) ? null : Number(f.branchId),
    permissions: admin ? [] : f.permissions,
    employmentType: f.employmentType,
    weeklyHours: f.employmentType === 'FULL_TIME' || f.weeklyHours.trim() === '' ? null : Number(f.weeklyHours),
    laborActApplies: f.employmentType === 'INTERN' ? f.laborActApplies : true,
  };
}

function EmploymentFields({
  form,
  setForm,
}: {
  form: StaffFormState;
  setForm: (updater: (prev: StaffFormState) => StaffFormState) => void;
}) {
  const hoursField = form.employmentType !== 'FULL_TIME';
  return (
    <fieldset className="staff-employment">
      <legend>勞動條件</legend>
      <Field label="工作型態" hint="兼職＝部分工時，特休依週工時比例計給；實習無勞雇關係（學校課程實習／建教生）不適用勞基法假別">
        <Select
          value={form.employmentType}
          onChange={(e) => {
            const employmentType = e.target.value as EmploymentType;
            setForm((p) => ({
              ...p,
              employmentType,
              weeklyHours: employmentType === 'FULL_TIME' ? '' : p.weeklyHours,
              laborActApplies: employmentType === 'INTERN' ? p.laborActApplies : true,
            }));
          }}
        >
          {ALL_EMPLOYMENT_TYPES.map((t) => (
            <option key={t} value={t}>{EMPLOYMENT_TYPE_LABELS[t]}</option>
          ))}
        </Select>
      </Field>
      <Field label="到職日" hint="年資與特休自此日起算">
        <Input
          type="date"
          value={form.hireDate}
          onChange={(e) => setForm((p) => ({ ...p, hireDate: e.target.value }))}
        />
      </Field>
      {hoursField && (
        <Field
          label="約定每週工時"
          hint={form.employmentType === 'PART_TIME' ? `須少於 ${FULL_TIME_WEEKLY_HOURS} 小時` : `選填，預設 ${FULL_TIME_WEEKLY_HOURS} 小時`}
        >
          <Input
            type="number"
            inputMode="decimal"
            min={0.5}
            max={FULL_TIME_WEEKLY_HOURS}
            step={0.5}
            value={form.weeklyHours}
            onChange={(e) => setForm((p) => ({ ...p, weeklyHours: e.target.value }))}
            placeholder={form.employmentType === 'PART_TIME' ? '例如 20' : String(FULL_TIME_WEEKLY_HOURS)}
          />
        </Field>
      )}
      {form.employmentType === 'INTERN' && (
        <label className="checkbox-item">
          <input
            type="checkbox"
            checked={form.laborActApplies}
            onChange={(e) => setForm((p) => ({ ...p, laborActApplies: e.target.checked }))}
          />
          具勞雇關係（領薪、受指揮監督），適用勞基法
        </label>
      )}
    </fieldset>
  );
}

/** 年資／特休／國休摘要（計算由後端） */
function LeaveBalanceSummary({ balance }: { balance: StaffLeaveBalance | null | undefined }) {
  if (!balance?.hireDate) {
    return <Alert tone="warning">尚未設定到職日，無法計算年資與特休／國休。</Alert>;
  }
  const a = balance.annualLeave;
  const n = balance.nationalHoliday;
  return (
    <div className="staff-leave-summary">
      <div>
        <span className="text-muted text-sm">年資</span>
        <strong>{formatSeniority(balance.seniority)}</strong>
        <span className="text-muted text-sm">到職 {balance.hireDate}</span>
      </div>
      {!balance.laborActApplies ? (
        <div>
          <span className="text-muted text-sm">特休／國休</span>
          <strong>不適用</strong>
          <span className="text-muted text-sm">無勞雇關係之實習</span>
        </div>
      ) : (
        <>
          <div>
            <span className="text-muted text-sm">特休（已用／總特休）</span>
            <strong>{a?.eligible ? formatLeaveQuota(a.usedHours, a.entitledHours, a.unit) : '尚未取得'}</strong>
            <span className="text-muted text-sm">
              {a?.eligible
                ? `${a.periodStart}～${a.periodEnd}；${a.nextGrantDate} 起 ${a.nextGrantDays} 日`
                : `${a?.nextGrantDate} 滿 6 個月起 3 日`}
            </span>
          </div>
          <div>
            <span className="text-muted text-sm">國休（已用／總國休）</span>
            <strong>{n ? formatDays(n.usedDays, n.entitledDays) : '—'}</strong>
            <span className="text-muted text-sm">
              {n?.basis === 'SCHEDULED_WORKDAY'
                ? '部分工時：國定假日逢約定工作日始放假'
                : `${n?.year} 年，到職日後之國定假日`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function StaffFormFields({
  form,
  setForm,
  branches,
  mode,
}: {
  form: StaffFormState;
  setForm: (updater: (prev: StaffFormState) => StaffFormState) => void;
  branches: Branch[];
  mode: 'create' | 'edit';
}) {
  const hq = isCrossBranchRole(form.role);
  const admin = isPosition(form.role, 'ADMIN');
  const position = canonicalPosition(form.role);
  const requiredPerms = position ? POSITIONS[position].requiredPermissions : [];
  const roleOptions: StaffRole[] = (ALL_POSITIONS as StaffRole[]).includes(form.role)
    ? ALL_POSITIONS
    : [...ALL_POSITIONS, form.role];
  const branchOptions = branches.filter(
    (b) => b.isActive && positionFitsBranchType(form.role, branchTypeOf(b)),
  );

  return (
    <>
      {mode === 'create' && (
        <>
          <Field label="登入帳號">
            <Input
              value={form.account}
              onChange={(e) => setForm((p) => ({ ...p, account: e.target.value }))}
              required
            />
          </Field>
          <Field label="初始密碼">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
              required
            />
          </Field>
        </>
      )}
      <Field label="真實姓名">
        <Input
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          required
        />
      </Field>
      <Field label="顯示名稱" hint="側欄／對外顯示；預設匿名">
        <Input
          value={form.displayName}
          onChange={(e) => setForm((p) => ({ ...p, displayName: e.target.value }))}
          placeholder="匿名"
        />
      </Field>
      <EmploymentFields form={form} setForm={setForm} />
      <Field
        label="職位"
        hint="DUTY 以上可進入「交易異動」；總公司／GM／FM 不綁單一分店；店長僅健身房、場務不可綁學院；教室由上層健身房支援，不直接綁員工"
      >
        <Select
          value={form.role}
          onChange={(e) => {
            const role = e.target.value as StaffRole;
            const position = canonicalPosition(role);
            setForm((p) => {
              const current = branches.find((b) => b.id === p.branchId);
              const keepBranch =
                !isPosition(role, 'ADMIN') &&
                (!current || positionFitsBranchType(role, branchTypeOf(current)));
              return {
                ...p,
                role,
                permissions: position ? POSITIONS[position].defaultPermissions : p.permissions,
                branchId: keepBranch ? p.branchId : '',
              };
            });
          }}
        >
          {roleOptions.map((r) => (
            <option key={r} value={r}>{roleOptionLabel(r)}</option>
          ))}
        </Select>
      </Field>
      {!admin && (
        <>
          <Field label={hq ? '主責分店（選填）' : '所屬分店'}>
            <Select
              value={form.branchId === '' ? '' : String(form.branchId)}
              onChange={(e) => setForm((p) => ({ ...p, branchId: Number(e.target.value) || '' }))}
              required={!hq}
            >
              <option value="">{hq ? '— 全連鎖 —' : '— 請選擇 —'}</option>
              {branchOptions.map((b) => (
                <option key={b.id} value={b.id}>{branchOptionLabel(b)}</option>
              ))}
            </Select>
          </Field>
          <Field label="模組權限">
            <div className="checkbox-group">
              {ALL_STAFF_PERMISSIONS.map((perm) => (
                <label key={perm} className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={form.permissions.includes(perm) || requiredPerms.includes(perm)}
                    disabled={requiredPerms.includes(perm)}
                    onChange={() => setForm((p) => ({ ...p, permissions: toggleIn(p.permissions, perm) }))}
                  />
                  {STAFF_PERMISSION_LABELS[perm]}
                  {requiredPerms.includes(perm) ? '（職位必備）' : ''}
                </label>
              ))}
            </div>
          </Field>
        </>
      )}
    </>
  );
}

function StaffEmploymentCells({ staff }: { staff: StaffAccount }) {
  const b = staff.leaveBalance;
  const type = employmentTypeOf(staff.employmentType);
  const a = b?.annualLeave;
  const n = b?.nationalHoliday;
  const na = <span className="text-muted">—</span>;
  return (
    <>
      <td>
        {EMPLOYMENT_TYPE_SHORT[type]}
        {staff.weeklyHours ? <div className="text-muted text-sm">週 {staff.weeklyHours} 時</div> : null}
        {type === 'INTERN' && staff.laborActApplies === false ? (
          <div className="text-muted text-sm">無勞雇關係</div>
        ) : null}
      </td>
      <td>
        {b?.hireDate ? formatSeniority(b.seniority) : <Badge tone="warning">未設到職日</Badge>}
        {b?.hireDate ? <div className="text-muted text-sm">{b.hireDate}</div> : null}
      </td>
      <td>{a ? (a.eligible ? formatLeaveQuota(a.usedHours, a.entitledHours, a.unit) : '未滿半年') : na}</td>
      <td>{n ? formatDays(n.usedDays, n.entitledDays) : na}</td>
    </>
  );
}

function TrainerFormFields({
  form,
  setForm,
  branches,
}: {
  form: TrainerFormState;
  setForm: (updater: (prev: TrainerFormState) => TrainerFormState) => void;
  branches: Branch[];
}) {
  return (
    <>
      <Field label="真實姓名">
        <Input
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          required
        />
      </Field>
      <Field label="顯示名稱" hint="會員／LINE 顯示；預設匿名">
        <Input
          value={form.displayName}
          onChange={(e) => setForm((p) => ({ ...p, displayName: e.target.value }))}
          placeholder="匿名"
        />
      </Field>
      <Field label="電話">
        <Input
          value={form.phone}
          onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
          required
          inputMode="tel"
        />
      </Field>
      <Field label="教練等級">
        <Select
          value={form.level}
          onChange={(e) => setForm((p) => ({ ...p, level: e.target.value as TrainerLevel }))}
        >
          <option value="GOLD">{levelLabel('GOLD')}</option>
          <option value="SILVER">{levelLabel('SILVER')}</option>
        </Select>
      </Field>
      <Field label="教練角色">
        <Select
          value={form.role}
          onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as TrainerRole }))}
        >
          <option value="NORMAL">NORMAL {TRAINER_ROLE_LABELS.NORMAL}</option>
          <option value="MANAGER">MANAGER {TRAINER_ROLE_LABELS.MANAGER}</option>
        </Select>
      </Field>
      <Field
        label="指派分店"
        hint={
          isManagerTrainer(form)
            ? '主管教練不限分店：可不勾選；勾選僅作組織歸屬／篩選'
            : '一般教練僅能在已勾選的分店授課（可多選）'
        }
      >
        <div className="checkbox-group">
          {branches.filter((b) => b.isActive).map((b) => (
            <label key={b.id} className="checkbox-item">
              <input
                type="checkbox"
                checked={form.branchIds.includes(b.id)}
                onChange={() => setForm((p) => ({ ...p, branchIds: toggleIn(p.branchIds, b.id) }))}
              />
              {branchOptionLabel(b)}
            </label>
          ))}
        </div>
      </Field>
    </>
  );
}

function PersonTags({ people, empty = '—' }: { people: { id: number; name: string }[]; empty?: string }) {
  if (people.length === 0) return <span className="text-muted text-sm">{empty}</span>;
  return (
    <div className="org-chart-node__people">
      {people.map((p) => (
        <span key={p.id} className="org-chart-person-tag">{p.name}</span>
      ))}
    </div>
  );
}

interface OrgUnit {
  branch: Branch;
  type: BranchType;
  managers: StaffAccount[];
  duty: StaffAccount[];
  floor: StaffAccount[];
  gold: Trainer[];
  silver: Trainer[];
}

function unitSupervisionLabel(unit: OrgUnit, parent?: OrgUnit) {
  const def = BRANCH_TYPES[unit.type];
  const managerNames = (u: OrgUnit) => u.managers.map((m) => m.name).join('、') || '尚未設置';
  if (def.inheritsParent) {
    return parent
      ? `隸屬 ${staffBranchLabel(parent.branch)}，由店長督導：${managerNames(parent)}`
      : '隸屬上層分店（尚未設定）';
  }
  if (def.heads.includes('STORE_MANAGER')) return `STORE MANAGER 店長：${managerNames(unit)}`;
  return `由 ${def.heads.map((h) => positionLabel(h)).join('、')} 督導`;
}

function OrgUnitNode({
  unit,
  parent,
  scope,
  onSelect,
  children,
}: {
  unit: OrgUnit;
  parent?: OrgUnit;
  scope: ScopeFilter;
  onSelect: (id: number) => void;
  children?: ReactNode;
}) {
  const def = BRANCH_TYPES[unit.type];
  const nested = Boolean(parent);
  const hasStore = def.departments.includes('STORE') && unit.duty.length + unit.floor.length > 0;
  const hasCoach = unit.gold.length + unit.silver.length > 0;
  const select = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onSelect(unit.branch.id);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className={`org-chart-node org-chart-node--unit ${nested ? 'org-chart-node--child' : ''} ${scope === unit.branch.id ? 'is-active' : ''}`}
      onClick={select}
      onKeyDown={(e) => e.key === 'Enter' && select(e)}
    >
      <div className="org-chart-node__header">
        <h3 className="org-chart-node__title">
          {unit.branch.name} <span className="mono text-sm">{staffBranchLabel(unit.branch)}</span>
        </h3>
        <span className="org-chart-node__role">{unit.type}</span>
      </div>
      <div className="org-chart-node__meta">
        {unitSupervisionLabel(unit, parent)}
        {unit.branch.legalEntity?.ubn ? ` · 統編 ${unit.branch.legalEntity.ubn}` : ''}
      </div>
      <div className="org-chart-node__subgroups">
        {hasStore && (
          <div className="org-chart-subgroup">
            <div className="org-chart-subgroup__title">
              場務 <span>DUTY {unit.duty.length} · STAFF {unit.floor.length}</span>
            </div>
            <PersonTags people={[...unit.duty, ...unit.floor]} />
          </div>
        )}
        {hasCoach && (
          <div className="org-chart-subgroup">
            <div className="org-chart-subgroup__title">
              教練 <span>GOLD {unit.gold.length} · SILVER {unit.silver.length}</span>
            </div>
            <PersonTags people={[...unit.gold, ...unit.silver]} />
          </div>
        )}
        {!hasStore && !hasCoach && <span className="text-muted text-sm">尚無人員</span>}
        {children}
      </div>
    </div>
  );
}

export default function HqPeopleTab({
  branches,
  staffList,
  trainers,
  onReload,
}: Pick<HqDataProps, 'branches' | 'staffList' | 'trainers' | 'onReload'>) {
  const { toast } = useToast();
  const { staff: me, patchStaff } = useStaffAuth();
  const submitInFlightRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const [scope, setScope] = useState<ScopeFilter>('ALL');
  const [listView, setListView] = useState<ListView>('staff');
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [createStaffOpen, setCreateStaffOpen] = useState(false);
  const [staffForm, setStaffForm] = useState<StaffFormState>(() => emptyStaffForm(''));
  const [editingStaff, setEditingStaff] = useState<StaffAccount | null>(null);
  const [editStaffForm, setEditStaffForm] = useState<StaffFormState>(() => emptyStaffForm(''));
  const [editStaffPassword, setEditStaffPassword] = useState('');

  const [createTrainerOpen, setCreateTrainerOpen] = useState(false);
  const [trainerForm, setTrainerForm] = useState<TrainerFormState>(() => emptyTrainerForm([]));
  const [editingTrainer, setEditingTrainer] = useState<Trainer | null>(null);
  const [editTrainerForm, setEditTrainerForm] = useState<TrainerFormState>(() => emptyTrainerForm([]));

  const activeBranches = useMemo(() => branches.filter((b) => b.isActive), [branches]);
  const activeStaff = useMemo(() => staffList.filter((s) => s.isActive), [staffList]);
  const activeTrainers = useMemo(() => trainers.filter((t) => t.isActive !== false), [trainers]);

  const org = useMemo(() => {
    const byPosition = (p: Position) => activeStaff.filter((s) => isPosition(s.role, p));
    const unitOf = (b: Branch): OrgUnit => {
      const inBranch = activeStaff.filter((s) => s.branchId === b.id && !isCrossBranchRole(s.role));
      const coaches = activeTrainers.filter((t) => (t.branches || []).some((x) => x.branchId === b.id));
      return {
        branch: b,
        type: branchTypeOf(b),
        managers: inBranch.filter((s) => isPosition(s.role, 'STORE_MANAGER')),
        duty: inBranch.filter((s) => isPosition(s.role, 'DUTY')),
        floor: inBranch.filter((s) => isPosition(s.role, 'STAFF')),
        gold: coaches.filter((t) => trainerLevelOf(t) === 'GOLD'),
        silver: coaches.filter((t) => trainerLevelOf(t) === 'SILVER'),
      };
    };
    const ids = new Set(activeBranches.map((b) => b.id));
    const units = activeBranches
      .filter((b) => !b.parentId || !ids.has(b.parentId))
      .map((b) => ({
        ...unitOf(b),
        children: activeBranches.filter((c) => c.parentId === b.id).map(unitOf),
      }));
    return { admins: byPosition('ADMIN'), gms: byPosition('GM'), fms: byPosition('FM'), units };
  }, [activeStaff, activeTrainers, activeBranches]);

  const stats = useMemo(
    () => ({
      staff: activeStaff.length,
      mgmt: org.gms.length + org.fms.length,
      managers: activeStaff.filter((s) => isPosition(s.role, 'STORE_MANAGER')).length,
      floor: activeStaff.filter((s) => departmentOf(s.role) === 'STORE').length,
      gold: activeTrainers.filter((t) => trainerLevelOf(t) === 'GOLD').length,
      silver: activeTrainers.filter((t) => trainerLevelOf(t) === 'SILVER').length,
    }),
    [activeStaff, activeTrainers, org],
  );

  const q = query.trim().toLowerCase();

  const filteredStaff = staffList.filter((s) => {
    if (!showInactive && !s.isActive) return false;
    if (scope === 'HQ' && !(isCrossBranchRole(s.role) || s.branchId == null)) return false;
    if (typeof scope === 'number' && (s.branchId !== scope || isCrossBranchRole(s.role))) return false;
    if (q && !`${s.account} ${s.name} ${s.displayName ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const filteredTrainers = trainers.filter((t) => {
    if (!showInactive && t.isActive === false) return false;
    if (scope === 'HQ') return false;
    if (typeof scope === 'number' && !(t.branches || []).some((b) => b.branchId === scope)) return false;
    if (q && !`${t.name} ${t.displayName ?? ''} ${t.phone ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const scopeLabel =
    scope === 'ALL'
      ? '全部'
      : scope === 'HQ'
        ? '總公司／管理層'
        : staffBranchLabel(branches.find((b) => b.id === scope)) || `分店 #${scope}`;

  function selectScope(next: ScopeFilter) {
    setScope((prev) => (prev === next ? 'ALL' : next));
  }

  async function runLocked(task: () => Promise<void>) {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setBusy(true);
    try {
      await task();
    } finally {
      submitInFlightRef.current = false;
      setBusy(false);
    }
  }

  function openCreateStaff() {
    setStaffForm(emptyStaffForm(typeof scope === 'number' ? scope : activeBranches[0]?.id ?? ''));
    setCreateStaffOpen(true);
  }

  function openEditStaff(s: StaffAccount) {
    setEditingStaff(s);
    setEditStaffForm({
      account: s.account,
      password: '',
      name: s.name,
      displayName: s.displayName || '匿名',
      role: s.role,
      branchId: s.branchId ?? '',
      permissions: s.permissions || [],
      isActive: s.isActive,
      employmentType: employmentTypeOf(s.employmentType),
      hireDate: s.hireDate ?? '',
      weeklyHours: s.weeklyHours != null ? String(s.weeklyHours) : '',
      laborActApplies: s.laborActApplies !== false,
    });
    setEditStaffPassword('');
  }

  function openCreateTrainer() {
    setTrainerForm(emptyTrainerForm(typeof scope === 'number' ? [scope] : []));
    setCreateTrainerOpen(true);
  }

  function openEditTrainer(t: Trainer) {
    setEditingTrainer(t);
    setEditTrainerForm({
      name: t.name,
      displayName: t.displayName || '匿名',
      phone: t.phone || '',
      role: trainerRoleOf(t),
      level: trainerLevelOf(t),
      branchIds: (t.branches || []).map((b) => b.branchId).filter(Boolean),
      isActive: t.isActive !== false,
      staffId: t.staffId ?? t.staff?.id ?? '',
    });
  }

  async function handleCreateStaff(e?: FormEvent) {
    e?.preventDefault();
    const err = validateStaffForm(staffForm, branches, 'create');
    if (err) return toast(err, 'error');
    await runLocked(async () => {
      try {
        const result = await createHqStaff({
          account: staffForm.account.trim(),
          password: staffForm.password,
          ...staffPayload(staffForm),
          hireDate: staffForm.hireDate,
        });
        toast(result.message || '員工已建立', 'success');
        setCreateStaffOpen(false);
        await onReload();
      } catch (error) {
        toast(getErrorMessage(error, '建立員工失敗'), 'error');
      }
    });
  }

  async function handleUpdateStaff(e?: FormEvent) {
    e?.preventDefault();
    if (!editingStaff) return;
    const err = validateStaffForm(editStaffForm, branches, 'edit');
    if (err) return toast(err, 'error');
    await runLocked(async () => {
      try {
        const payload: Parameters<typeof updateHqStaff>[1] = {
          ...staffPayload(editStaffForm),
          isActive: editStaffForm.isActive,
        };
        if (editStaffForm.hireDate) payload.hireDate = editStaffForm.hireDate;
        if (editStaffPassword.trim()) payload.password = editStaffPassword;
        const result = await updateHqStaff(editingStaff.id, payload);
        toast(result.message || '員工已更新', 'success');
        setEditingStaff(null);
        await onReload();
      } catch (error) {
        toast(getErrorMessage(error, '更新員工失敗'), 'error');
      }
    });
  }

  async function handleCreateTrainer(e?: FormEvent) {
    e?.preventDefault();
    const f = trainerForm;
    if (!f.name.trim() || !f.phone.trim()) return toast('請填寫教練姓名與電話', 'error');
    if (f.role === 'NORMAL' && f.branchIds.length === 0) {
      return toast('一般教練須至少指派一間分店', 'error');
    }
    await runLocked(async () => {
      try {
        const created = await createHqTrainer({
          name: f.name.trim(),
          displayName: f.displayName.trim() || '匿名',
          phone: f.phone.trim(),
          role: f.role,
          level: f.level,
        });
        const id = created.data?.id;
        if (!id) {
          toast(created.message || '建立教練失敗', 'error');
          return;
        }
        const result = await assignTrainer(id, f.role, f.branchIds, f.level);
        toast(result.message || '教練已建立並完成分店指派', 'success');
        setCreateTrainerOpen(false);
        await onReload();
      } catch (error) {
        toast(getErrorMessage(error, '建立教練失敗'), 'error');
      }
    });
  }

  async function handleUpdateTrainer(e?: FormEvent) {
    e?.preventDefault();
    if (!editingTrainer) return;
    const f = editTrainerForm;
    if (f.role === 'NORMAL' && f.branchIds.length === 0) {
      return toast('一般教練須至少指派一間分店', 'error');
    }
    await runLocked(async () => {
      try {
        const result = await updateHqTrainer(editingTrainer.id, {
          name: f.name.trim(),
          displayName: f.displayName.trim() || '匿名',
          phone: f.phone.trim(),
          role: f.role,
          level: f.level,
          isActive: f.isActive,
          staffId: f.staffId === '' ? null : Number(f.staffId),
        });
        if (f.isActive) await assignTrainer(editingTrainer.id, f.role, f.branchIds, f.level);
        toast(result.message || '教練已更新', 'success');
        setEditingTrainer(null);
        await onReload();
      } catch (error) {
        toast(getErrorMessage(error, '更新教練失敗'), 'error');
      }
    });
  }

  return (
    <PageSection
      title="員工管理"
      desc="依組織架構管理：總公司 → 管理（GM／FM）→ 各分店（健身房由店長督導、隸屬教室由上層店長督導；學院由 FM 督導）→ 場務與金／銀牌教練 · 點選節點篩選下方名單"
    >
      <div className="stat-pills">
        <div className="stat-pill"><span className="stat-pill__label">在職員工</span><span className="stat-pill__val">{stats.staff}</span></div>
        <div className="stat-pill"><span className="stat-pill__label">管理層</span><span className="stat-pill__val">{stats.mgmt}</span></div>
        <div className="stat-pill"><span className="stat-pill__label">店長</span><span className="stat-pill__val">{stats.managers}</span></div>
        <div className="stat-pill"><span className="stat-pill__label">場務</span><span className="stat-pill__val">{stats.floor}</span></div>
        <div className="stat-pill"><span className="stat-pill__label">金牌教練</span><span className="stat-pill__val">{stats.gold}</span></div>
        <div className="stat-pill"><span className="stat-pill__label">銀牌教練</span><span className="stat-pill__val">{stats.silver}</span></div>
      </div>

      <Card title="組織架構" subtitle={`目前篩選：${scopeLabel}（再點一次取消）`}>
        <div className="org-chart-container">
          <div className="org-chart-level">
            <div
              role="button"
              tabIndex={0}
              className={`org-chart-node org-chart-node--root ${scope === 'HQ' ? 'is-active' : ''}`}
              onClick={() => selectScope('HQ')}
              onKeyDown={(e) => e.key === 'Enter' && selectScope('HQ')}
            >
              <div className="org-chart-node__header">
                <h3 className="org-chart-node__title">總公司</h3>
                <span className="org-chart-node__role">ADMIN</span>
              </div>
              <PersonTags people={org.admins} />
            </div>
          </div>
          <div className="org-chart-connector-v" />
          <div className="org-chart-level">
            <div
              role="button"
              tabIndex={0}
              className={`org-chart-node org-chart-node--mgmt ${scope === 'HQ' ? 'is-active' : ''}`}
              onClick={() => selectScope('HQ')}
              onKeyDown={(e) => e.key === 'Enter' && selectScope('HQ')}
            >
              <div className="org-chart-node__header">
                <h3 className="org-chart-node__title">管理</h3>
                <span className="org-chart-node__role">GM · FM</span>
              </div>
              <div className="org-chart-node__subgroups">
                <div className="org-chart-subgroup">
                  <div className="org-chart-subgroup__title">GM 店務部主管 <span>{org.gms.length}</span></div>
                  <PersonTags people={org.gms} />
                </div>
                <div className="org-chart-subgroup">
                  <div className="org-chart-subgroup__title">FM 教練部主管 <span>{org.fms.length}</span></div>
                  <PersonTags people={org.fms} />
                </div>
              </div>
            </div>
          </div>
          <div className="org-chart-connector-v" />
          <div className="org-chart-level">
            {org.units.map((u) => (
              <OrgUnitNode key={u.branch.id} unit={u} scope={scope} onSelect={selectScope}>
                {u.children.map((c) => (
                  <OrgUnitNode key={c.branch.id} unit={c} parent={u} scope={scope} onSelect={selectScope} />
                ))}
              </OrgUnitNode>
            ))}
          </div>
        </div>
      </Card>

      <Card
        className="mt-lg"
        title={listView === 'staff' ? '員工帳號' : '教練'}
        subtitle={
          listView === 'staff'
            ? `${scopeLabel} · 顯示 ${filteredStaff.length}／${staffList.length} 人`
            : `${scopeLabel} · 顯示 ${filteredTrainers.length}／${trainers.length} 人`
        }
      >
        <div className="list-toolbar" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <nav className="hq-tabs" role="tablist">
            <button
              type="button"
              className={`hq-tabs__btn ${listView === 'staff' ? 'is-active' : ''}`}
              onClick={() => setListView('staff')}
            >
              員工帳號（{activeStaff.length}）
            </button>
            <button
              type="button"
              className={`hq-tabs__btn ${listView === 'trainers' ? 'is-active' : ''}`}
              onClick={() => setListView('trainers')}
            >
              教練（{activeTrainers.length}）
            </button>
          </nav>
          <Select
            value={String(scope)}
            onChange={(e) => {
              const v = e.target.value;
              setScope(v === 'ALL' || v === 'HQ' ? v : Number(v));
            }}
            aria-label="組織篩選"
          >
            <option value="ALL">全部</option>
            <option value="HQ">總公司／管理層</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{staffBranchLabel(b)}</option>
            ))}
          </Select>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={listView === 'staff' ? '搜尋帳號／姓名' : '搜尋姓名／電話'}
            aria-label="搜尋"
          />
          <label className="checkbox-item">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            含停權
          </label>
          <Button onClick={listView === 'staff' ? openCreateStaff : openCreateTrainer}>
            {listView === 'staff' ? '新增員工' : '新增教練'}
          </Button>
        </div>

        <div className="table-wrap mt-md">
          {listView === 'staff' ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th aria-label="頭像"></th>
                  <th>帳號</th>
                  <th>姓名</th>
                  <th>部門</th>
                  <th>職位</th>
                  <th>分店</th>
                  <th>工作型態</th>
                  <th>年資</th>
                  <th>特休<br /><span className="text-muted text-sm">已用／總</span></th>
                  <th>國休<br /><span className="text-muted text-sm">已用／總</span></th>
                  <th>模組權限</th>
                  <th>人臉</th>
                  <th>狀態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredStaff.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <StaffAvatar staffId={s.id} name={s.name} version={s.photoUpdatedAt} />
                    </td>
                    <td className="mono">{s.account}</td>
                    <td>
                      {s.name}
                      <div className="text-muted text-sm">{s.displayName || '匿名'}</div>
                    </td>
                    <td>{departmentLabel(s.role)}</td>
                    <td>{roleOptionLabel(s.role)}</td>
                    <td>{staffBranchLabel(s.branch) || (isCrossBranchRole(s.role) ? '全連鎖' : '—')}</td>
                    <StaffEmploymentCells staff={s} />
                    <td>
                      {isPosition(s.role, 'ADMIN')
                        ? '全部'
                        : (s.permissions || []).map((p) => STAFF_PERMISSION_LABELS[p]).join('、') || '—'}
                    </td>
                    <td>
                      <Badge tone={s.faceEnrolledAt ? 'info' : 'neutral'}>{s.faceEnrolledAt ? '已註冊' : '—'}</Badge>
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
                    <td colSpan={14} className="text-muted text-center">此範圍尚無員工</td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>真實姓名</th>
                  <th>顯示名稱</th>
                  <th>電話</th>
                  <th>等級</th>
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
                    <td>
                      <Badge tone={trainerLevelOf(t) === 'GOLD' ? 'warning' : 'neutral'}>
                        {levelLabel(trainerLevelOf(t))}
                      </Badge>
                    </td>
                    <td>{TRAINER_ROLE_LABELS[trainerRoleOf(t)]}</td>
                    <td>
                      {(t.branches || []).map((b) => staffBranchLabel(b.branch)).join('、') ||
                        (isManagerTrainer(t) ? '不限分店' : '—')}
                    </td>
                    <td className="text-sm">{t.staff ? `${t.staff.name}（${t.staff.account}）` : '—'}</td>
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
                    <td colSpan={9} className="text-muted text-center">
                      {scope === 'HQ' ? '教練依分店歸屬，請選擇分店' : '此範圍尚無教練'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <Modal
        open={createStaffOpen}
        title="新增員工"
        onClose={() => setCreateStaffOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateStaffOpen(false)}>取消</Button>
            <Button onClick={() => void handleCreateStaff()} disabled={busy}>建立員工</Button>
          </>
        }
      >
        <form onSubmit={handleCreateStaff} className="form-stack">
          <StaffFormFields form={staffForm} setForm={setStaffForm} branches={branches} mode="create" />
        </form>
      </Modal>

      <Modal
        open={editingStaff !== null}
        title={`編輯員工 · ${editingStaff?.account ?? ''}`}
        onClose={() => setEditingStaff(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingStaff(null)}>取消</Button>
            <Button onClick={() => void handleUpdateStaff()} disabled={busy}>儲存</Button>
          </>
        }
      >
        {editingStaff && (
          <StaffPhotoPanel
            key={editingStaff.id}
            staff={editingStaff}
            onChanged={async (status) => {
              setEditingStaff((prev) => (prev && prev.id === status.id ? { ...prev, ...status } : prev));
              if (me?.id === status.id) patchStaff({ photoUpdatedAt: status.photoUpdatedAt });
              await onReload();
            }}
          />
        )}
        <LeaveBalanceSummary balance={editingStaff?.leaveBalance} />
        <form onSubmit={handleUpdateStaff} className="form-stack">
          <StaffFormFields form={editStaffForm} setForm={setEditStaffForm} branches={branches} mode="edit" />
          <Field label="重設密碼（選填）">
            <Input
              type="password"
              value={editStaffPassword}
              onChange={(e) => setEditStaffPassword(e.target.value)}
              placeholder="留空則不變更"
            />
          </Field>
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editStaffForm.isActive}
              onChange={(e) => setEditStaffForm((p) => ({ ...p, isActive: e.target.checked }))}
            />
            帳號啟用
          </label>
        </form>
      </Modal>

      <Modal
        open={createTrainerOpen}
        title="新增教練"
        onClose={() => setCreateTrainerOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateTrainerOpen(false)}>取消</Button>
            <Button onClick={() => void handleCreateTrainer()} disabled={busy}>建立教練</Button>
          </>
        }
      >
        <form onSubmit={handleCreateTrainer} className="form-stack">
          <TrainerFormFields form={trainerForm} setForm={setTrainerForm} branches={branches} />
        </form>
      </Modal>

      <Modal
        open={editingTrainer !== null}
        title={`編輯教練 · ${editingTrainer?.name ?? ''}`}
        onClose={() => setEditingTrainer(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingTrainer(null)}>取消</Button>
            <Button onClick={() => void handleUpdateTrainer()} disabled={busy}>儲存</Button>
          </>
        }
      >
        <form onSubmit={handleUpdateTrainer} className="form-stack">
          <TrainerFormFields form={editTrainerForm} setForm={setEditTrainerForm} branches={branches} />
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editTrainerForm.isActive}
              onChange={(e) => setEditTrainerForm((p) => ({ ...p, isActive: e.target.checked }))}
            />
            教練啟用
          </label>
          <Field
            label="綁定員工帳號"
            hint="教練工作區僅顯示本人資料；需具備 trainer 模組權限。選「不綁定」可解除。"
          >
            <Select
              value={editTrainerForm.staffId === '' ? '' : String(editTrainerForm.staffId)}
              onChange={(e) =>
                setEditTrainerForm((p) => ({ ...p, staffId: e.target.value ? Number(e.target.value) : '' }))
              }
            >
              <option value="">— 不綁定 —</option>
              {activeStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.account}）
                  {isPosition(s.role, 'ADMIN') || (s.permissions || []).includes('trainer') ? '' : ' · 缺 trainer 權限'}
                </option>
              ))}
            </Select>
          </Field>
        </form>
      </Modal>
    </PageSection>
  );
}
