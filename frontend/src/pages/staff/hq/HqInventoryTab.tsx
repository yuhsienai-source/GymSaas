import { useState } from 'react';
import { PageSection } from '../../../components/ui';
import BranchStockPanel from './inventory/BranchStockPanel';
import EInvoicePanel from './inventory/EInvoicePanel';
import LegalEntitiesPanel from './inventory/LegalEntitiesPanel';
import PayablesPanel from './inventory/PayablesPanel';
import ProductMasterPanel from './inventory/ProductMasterPanel';
import PurchasingPanel from './inventory/PurchasingPanel';
import SalesReconciliationPanel from './inventory/SalesReconciliationPanel';
import SuppliersPanel from './inventory/SuppliersPanel';
import type { HqDataProps } from './types';

const SECTION_LABELS = {
  products: '商品主檔',
  stocks: '分店庫存',
  purchasing: '採購驗收',
  payables: '應付帳款',
  suppliers: '供應商',
  entities: '營業人',
  einvoices: '電子發票',
  reconciliation: '發票對帳',
} as const;
type Section = keyof typeof SECTION_LABELS;

/** 總部進銷存與電子發票（ADMIN）：每間分店隸屬一個營業人（獨立統編／ezPay 商店） */
export default function HqInventoryTab({ branches, onReloadInventory }: Pick<HqDataProps, 'branches' | 'onReloadInventory'>) {
  const [section, setSection] = useState<Section>('products');

  return (
    <PageSection
      title="進銷存／電子發票"
      desc="商品主檔全公司共用；庫存、售價與成本在分店層。採購與應付依分店所屬營業人入帳，發票由提供服務之分店營業人開立。門市驗收／盤點在左側「進銷存」。"
    >
      <nav className="hq-tabs" role="tablist">
        {(Object.keys(SECTION_LABELS) as Section[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            className={`hq-tabs__btn ${section === key ? 'is-active' : ''}`}
            onClick={() => setSection(key)}
          >
            {SECTION_LABELS[key]}
          </button>
        ))}
      </nav>

      {section === 'products' && <ProductMasterPanel />}
      {section === 'stocks' && <BranchStockPanel branches={branches} onChanged={onReloadInventory} />}
      {section === 'purchasing' && <PurchasingPanel branches={branches} />}
      {section === 'payables' && <PayablesPanel />}
      {section === 'suppliers' && <SuppliersPanel />}
      {section === 'entities' && <LegalEntitiesPanel />}
      {section === 'einvoices' && <EInvoicePanel branches={branches} />}
      {section === 'reconciliation' && <SalesReconciliationPanel branches={branches} />}
    </PageSection>
  );
}
