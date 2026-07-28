/** 員工／內部：關聯分店顯示代碼（無代碼則退回正式名稱） */
export function staffBranchLabel(branch: {
  code?: string | null;
  name?: string | null;
} | null | undefined): string {
  if (!branch) return '';
  const code = branch.code?.trim();
  if (code) return code;
  return branch.name?.trim() || '';
}

/** 會員／對外：一律正式名稱 */
export function memberBranchLabel(branch: {
  name?: string | null;
} | null | undefined): string {
  return branch?.name?.trim() || '';
}
