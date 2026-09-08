import { useCallback, useEffect, useState } from 'react';
import {
  fetchBranches,
  fetchHqCoursePlans,
  fetchHqProducts,
  fetchHqPromotions,
  fetchHqStaff,
  fetchHqTrainers,
  fetchHqVenues,
  getErrorMessage,
} from '../../lib/api';
import { useToast } from '../../contexts/ToastContext';
import type {
  Branch,
  CoursePlan,
  Product,
  Promotion,
  StaffAccount,
  Trainer,
  Venue,
} from '../../types/api';
import HqBranchesTab from './hq/HqBranchesTab';
import HqCoachTab from './hq/HqCoachTab';
import HqCmsTab from './hq/HqCmsTab';
import HqCompensationTab from './hq/HqCompensationTab';
import HqContractsTab from './hq/HqContractsTab';
import HqCoursePlansTab from './hq/HqCoursePlansTab';
import HqCrmTab from './hq/HqCrmTab';
import HqGateDevicesTab from './hq/HqGateDevicesTab';
import HqHrTab from './hq/HqHrTab';
import HqInventoryTab from './hq/HqInventoryTab';
import HqMarketingTab from './hq/HqMarketingTab';
import HqPeopleTab from './hq/HqPeopleTab';
import HqPromotionsTab from './hq/HqPromotionsTab';
import HqSalesAnalyticsTab from './hq/HqSalesAnalyticsTab';
import PtDashboardPage from './PtDashboardPage';
import { HQ_TABS, type HqTab } from './hq/types';

export default function HqDashboardPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<HqTab>(() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    return HQ_TABS.some((t) => t.key === q) ? (q as HqTab) : 'branches';
  });

  const [branches, setBranches] = useState<Branch[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [coursePlans, setCoursePlans] = useState<CoursePlan[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [staffList, setStaffList] = useState<StaffAccount[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [inventoryBranchId, setInventoryBranchId] = useState<number | ''>('');

  const loadCore = useCallback(async () => {
    try {
      const [branchRes, venueRes, promoRes, courseRes, staffRes, trainerRes] = await Promise.all([
        fetchBranches(),
        fetchHqVenues(),
        fetchHqPromotions(),
        fetchHqCoursePlans(),
        fetchHqStaff(),
        fetchHqTrainers(),
      ]);
      if (branchRes.status === 'success' && branchRes.data) {
        setBranches(branchRes.data);
        setInventoryBranchId((prev) => prev || branchRes.data?.[0]?.id || '');
      }
      if (venueRes.status === 'success' && venueRes.data) setVenues(venueRes.data);
      if (promoRes.status === 'success' && promoRes.data) setPromotions(promoRes.data);
      if (courseRes.status === 'success' && courseRes.data) setCoursePlans(courseRes.data);
      if (staffRes.status === 'success' && staffRes.data) setStaffList(staffRes.data);
      if (trainerRes.status === 'success' && trainerRes.data) setTrainers(trainerRes.data);
    } catch (err) {
      toast(getErrorMessage(err, '載入 HQ 資料失敗'), 'error');
    }
  }, [toast]);

  const loadInventory = useCallback(async () => {
    if (!inventoryBranchId) return;
    try {
      const prodRes = await fetchHqProducts(Number(inventoryBranchId));
      if (prodRes.status === 'success' && prodRes.data) setProducts(prodRes.data);
    } catch (err) {
      toast(getErrorMessage(err, '載入商品主檔失敗'), 'error');
    }
  }, [inventoryBranchId, toast]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const [branchRes, venueRes, promoRes, courseRes, staffRes, trainerRes] = await Promise.all([
          fetchBranches(),
          fetchHqVenues(),
          fetchHqPromotions(),
          fetchHqCoursePlans(),
          fetchHqStaff(),
          fetchHqTrainers(),
        ]);
        if (cancelled) return;
        if (branchRes.status === 'success' && branchRes.data) {
          setBranches(branchRes.data);
          setInventoryBranchId((prev) => prev || branchRes.data?.[0]?.id || '');
        }
        if (venueRes.status === 'success' && venueRes.data) setVenues(venueRes.data);
        if (promoRes.status === 'success' && promoRes.data) setPromotions(promoRes.data);
        if (courseRes.status === 'success' && courseRes.data) setCoursePlans(courseRes.data);
        if (staffRes.status === 'success' && staffRes.data) setStaffList(staffRes.data);
        if (trainerRes.status === 'success' && trainerRes.data) setTrainers(trainerRes.data);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入 HQ 資料失敗'), 'error');
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  useEffect(() => {
    if (!inventoryBranchId) return;
    let cancelled = false;
    async function run() {
      try {
        const prodRes = await fetchHqProducts(Number(inventoryBranchId));
        if (cancelled) return;
        if (prodRes.status === 'success' && prodRes.data) setProducts(prodRes.data);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入商品主檔失敗'), 'error');
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [inventoryBranchId, toast]);

  const sharedProps = {
    branches,
    venues,
    promotions,
    coursePlans,
    products,
    staffList,
    trainers,
    inventoryBranchId,
    setInventoryBranchId,
    onReload: loadCore,
    onReloadInventory: loadInventory,
  };

  return (
    <div className="hq-dashboard">
      <nav className="hq-tabs" role="tablist" aria-label="總部 HQ 功能">
        {HQ_TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={`hq-tabs__btn ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="hq-tab-panel" role="tabpanel">
        {tab === 'branches' && <HqBranchesTab {...sharedProps} />}
        {tab === 'inventory' && <HqInventoryTab {...sharedProps} />}
        {tab === 'promotions' && <HqPromotionsTab {...sharedProps} />}
        {tab === 'coursePlans' && <HqCoursePlansTab {...sharedProps} />}
        {tab === 'groupClasses' && <PtDashboardPage />}
        {tab === 'contracts' && <HqContractsTab />}
        {tab === 'compensation' && (
          <HqCompensationTab branches={branches} trainers={trainers} />
        )}
        {tab === 'cms' && <HqCmsTab {...sharedProps} />}
        {tab === 'marketing' && <HqMarketingTab />}
        {tab === 'crm' && <HqCrmTab branches={branches} />}
        {tab === 'hr' && <HqHrTab {...sharedProps} />}
        {tab === 'coach' && <HqCoachTab trainers={trainers} />}
        {tab === 'people' && <HqPeopleTab {...sharedProps} />}
        {tab === 'gateDevices' && <HqGateDevicesTab branches={branches} />}
        {tab === 'salesAnalytics' && (
          <HqSalesAnalyticsTab branches={branches} trainers={trainers} />
        )}
      </div>
    </div>
  );
}
