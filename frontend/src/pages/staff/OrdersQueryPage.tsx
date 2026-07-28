import { useEffect, useState } from 'react';
import BranchScopeBar from '../../components/staff/BranchScopeBar';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { useToast } from '../../contexts/ToastContext';
import { fetchReportBranches, getErrorMessage } from '../../lib/api';
import { resolveBranchId } from '../../lib/resolveBranchId';
import type { Branch } from '../../types/api';
import HqReportsTab from './hq/HqReportsTab';

/** 左側主選單「訂單查詢」— 櫃檯 ops 可用；教練無權限 */
export default function OrdersQueryPage() {
  const { toast } = useToast();
  const { staff, isAdmin } = useStaffAuth();
  const branchLocked = !isAdmin && Boolean(staff?.branchId);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchIdDraft, setBranchIdDraft] = useState<number | ''>('');
  const branchId = resolveBranchId(branchLocked, staff?.branchId, branches, branchIdDraft);
  const setBranchId = setBranchIdDraft;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchReportBranches();
        if (cancelled) return;
        if (res.status === 'success' && res.data) setBranches(res.data);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入分店失敗'), 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  return (
    <div className="hq-dashboard">
      <BranchScopeBar
        branches={branches}
        branchId={branchId}
        locked={branchLocked}
        lockedLabel={staff?.branchName || (staff?.branchId ? `分店 #${staff.branchId}` : undefined)}
        hint="訂單查詢以此分店為範圍"
        onChange={setBranchId}
      />
      <HqReportsTab
        branches={branches}
        branchId={branchId}
        onBranchIdChange={setBranchId}
        hideBranchField
        fixedKind="orders"
        pageTitle="訂單查詢"
        pageDesc="櫃檯可用 · 合併結帳／獨立訂單 · 含狀態篩選與詳情"
      />
    </div>
  );
}
