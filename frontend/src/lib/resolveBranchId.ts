/** 報表／櫃檯分店選擇：鎖定帳號分店，否則保留有效選取或回退第一間 */
export function resolveBranchId(
  locked: boolean,
  staffBranchId: number | null | undefined,
  branches: { id: number }[],
  selected: number | '',
): number | '' {
  if (locked && staffBranchId) return staffBranchId;
  if (selected !== '' && branches.some((b) => b.id === selected)) return selected;
  return branches[0]?.id ?? '';
}
