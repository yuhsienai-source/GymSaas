import type { Branch, BranchStockRow, CoursePlan, Promotion, StaffAccount, Trainer, Venue } from '../../../types/api';

export type HqTab =
  | 'branches'
  | 'inventory'
  | 'promotions'
  | 'coursePlans'
  | 'groupClasses'
  | 'contracts'
  | 'compensation'
  | 'people'
  | 'gateDevices'
  | 'salesAnalytics'
  | 'cms'
  | 'marketing'
  | 'hr'
  | 'payroll'
  | 'coach'
  | 'crm';

export const HQ_TABS: { key: HqTab; label: string }[] = [
  { key: 'branches', label: '分店場地' },
  { key: 'inventory', label: '進銷存／發票' },
  { key: 'promotions', label: '儲值方案' },
  { key: 'coursePlans', label: '課程方案' },
  { key: 'groupClasses', label: '團課管理' },
  { key: 'contracts', label: '電子合約' },
  { key: 'compensation', label: '合規補償' },
  { key: 'cms', label: '內容 CMS' },
  { key: 'marketing', label: '行銷 CRM' },
  { key: 'crm', label: '團課 CRM' },
  { key: 'hr', label: '員工 HR' },
  { key: 'payroll', label: '薪資' },
  { key: 'coach', label: '教練業績' },
  { key: 'people', label: '員工管理' },
  { key: 'gateDevices', label: '進出場裝置' },
  { key: 'salesAnalytics', label: '銷售分析' },
];

export interface HqDataProps {
  branches: Branch[];
  venues: Venue[];
  promotions: Promotion[];
  coursePlans: CoursePlan[];
  /** 全分店庫存／上架列（課程方案加贈禮選單用） */
  branchStocks: BranchStockRow[];
  staffList: StaffAccount[];
  trainers: Trainer[];
  onReload: () => Promise<void>;
  onReloadInventory: () => Promise<void>;
}
