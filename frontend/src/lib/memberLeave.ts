// 契約第十二條會員權暫停：事由標籤與表單提示（鏡像 backend/lib/memberLeaveRules.js，僅顯示用；審核與天數以後端為準）
import type { MemberLeaveCategory, MemberLeaveStatus } from '../types/api';

export const LEAVE_CATEGORY_OPTIONS: { value: MemberLeaveCategory; label: string; hint: string }[] = [
  { value: 'OVERSEAS', label: '出國逾一個月', hint: '須至少 31 日；附機票、出入境或派駐證明' },
  { value: 'MEDICAL', label: '傷害、疾病或身體不適', hint: '附診斷證明；可事後 30 日內補辦、先送件後補證明' },
  { value: 'FAMILY_CARE', label: '懷孕、育嬰、侍親', hint: '附孕婦健康手冊、出生證明或相關證明' },
  { value: 'MILITARY', label: '服兵役', hint: '附兵單或在營證明' },
  { value: 'RELOCATION', label: '職務異動或遷居', hint: '附調職或遷居證明' },
  { value: 'OTHER', label: '其他事由', hint: '附相關證明或釋明文件' },
  { value: 'EPIDEMIC', label: '疫情一級開設（準用）', hint: '可事後 30 日內補辦、先送件後補證明' },
];

export const LEAVE_STATUS_LABELS: Record<MemberLeaveStatus, string> = {
  PENDING: '待審核',
  APPROVED: '已核准（待生效）',
  ACTIVE: '暫停中',
  ENDED: '已結束',
  REJECTED: '已退回',
  CANCELLED: '已取消',
};

/** 傷病、疫情：可回溯 30 日、先送件後補證明 */
export function isDeferrableLeaveCategory(category: MemberLeaveCategory | '' | null | undefined) {
  return category === 'MEDICAL' || category === 'EPIDEMIC';
}

export function leaveStatusLabel(status: string) {
  return LEAVE_STATUS_LABELS[status as MemberLeaveStatus] || status;
}
