import { Field, Input, Select } from '../ui';
import { staffBranchLabel } from '../../lib/branchLabel';
import type { Branch } from '../../types/api';

type Props = {
  branches: Branch[];
  branchId: number | '';
  onChange: (id: number | '') => void;
  /** 非 ADMIN 綁定分店時鎖定 */
  locked?: boolean;
  lockedLabel?: string;
  hint?: string;
  allowAll?: boolean;
  allLabel?: string;
  className?: string;
};

/** 櫃檯／交易異動等頁面頂部分店範圍列 */
export default function BranchScopeBar({
  branches,
  branchId,
  onChange,
  locked = false,
  lockedLabel,
  hint = '作業與查詢皆以此分店為範圍',
  allowAll = false,
  allLabel = '全部分店',
  className = '',
}: Props) {
  return (
    <div className={`branch-scope-bar ${className}`.trim()}>
      <Field label="作業分店" hint={hint}>
        {locked ? (
          <Input
            value={lockedLabel || (branchId ? `分店 #${branchId}` : '—')}
            readOnly
            disabled
          />
        ) : (
          <Select
            value={branchId === '' ? '' : String(branchId)}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}
            disabled={!allowAll && branches.length === 0}
          >
            {allowAll ? <option value="">{allLabel}</option> : null}
            {!allowAll && branches.length === 0 ? (
              <option value="">尚無可選分店</option>
            ) : null}
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {staffBranchLabel(b)}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </div>
  );
}
