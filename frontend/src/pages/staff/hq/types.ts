import type { Branch, CoursePlan, Product, Promotion, StaffAccount, Trainer, Venue } from '../../../types/api';

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
  | 'salesAnalytics';

export const HQ_TABS: { key: HqTab; label: string }[] = [
  { key: 'branches', label: '分店場地' },
  { key: 'inventory', label: '商品主檔' },
  { key: 'promotions', label: '儲值方案' },
  { key: 'coursePlans', label: '課程方案' },
  { key: 'groupClasses', label: '團課管理' },
  { key: 'contracts', label: '電子合約' },
  { key: 'compensation', label: '合規補償' },
  { key: 'people', label: '員工管理' },
  { key: 'gateDevices', label: '進出場裝置' },
  { key: 'salesAnalytics', label: '銷售分析' },
];

export interface HqDataProps {
  branches: Branch[];
  venues: Venue[];
  promotions: Promotion[];
  coursePlans: CoursePlan[];
  products: Product[];
  staffList: StaffAccount[];
  trainers: Trainer[];
  inventoryBranchId: number | '';
  setInventoryBranchId: (id: number | '') => void;
  onReload: () => Promise<void>;
  onReloadInventory: () => Promise<void>;
}
