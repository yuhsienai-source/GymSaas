import { type FormEvent, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import { staffBranchLabel } from '../../../lib/branchLabel';
import { createHqProduct, getErrorMessage, updateHqProduct } from '../../../lib/api';
import type { Product } from '../../../types/api';
import type { HqDataProps } from './types';

type ProductKind = 'PHYSICAL' | 'SERVICE';

function isServiceProduct(p: Pick<Product, 'productKind'> | null | undefined) {
  return String(p?.productKind || 'PHYSICAL').toUpperCase() === 'SERVICE';
}

/** 總部專用：新增／編輯商品主檔。進貨／盤點請至左側「進銷存」（DUTY+）。 */
export default function HqInventoryTab({
  branches,
  products,
  inventoryBranchId,
  setInventoryBranchId,
  onReloadInventory,
}: Pick<
  HqDataProps,
  'branches' | 'products' | 'inventoryBranchId' | 'setInventoryBranchId' | 'onReloadInventory'
>) {
  const { toast } = useToast();
  const [productSku, setProductSku] = useState('');
  const [productName, setProductName] = useState('');
  const [productKind, setProductKind] = useState<ProductKind>('PHYSICAL');
  const [productPrice, setProductPrice] = useState('100');
  const [productCost, setProductCost] = useState('50');
  const [productSafetyStock, setProductSafetyStock] = useState('');

  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editSku, setEditSku] = useState('');
  const [editName, setEditName] = useState('');
  const [editKind, setEditKind] = useState<ProductKind>('PHYSICAL');
  const [editPrice, setEditPrice] = useState('');
  const [editCost, setEditCost] = useState('');
  const [editSafetyStock, setEditSafetyStock] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [kindFilter, setKindFilter] = useState<'ALL' | ProductKind>('ALL');

  const branchProducts = products.filter((p) => p.branchId === inventoryBranchId);
  const filteredProducts = branchProducts.filter((p) => {
    if (kindFilter === 'ALL') return true;
    if (kindFilter === 'SERVICE') return isServiceProduct(p);
    return !isServiceProduct(p);
  });
  const physicalCount = branchProducts.filter((p) => !isServiceProduct(p)).length;
  const serviceCount = branchProducts.length - physicalCount;

  async function handleCreateProduct(e: FormEvent) {
    e.preventDefault();
    if (!inventoryBranchId) return;
    try {
      const safety =
        productKind === 'PHYSICAL' && productSafetyStock.trim() !== ''
          ? parseInt(productSafetyStock, 10)
          : null;
      if (
        productKind === 'PHYSICAL' &&
        productSafetyStock.trim() !== '' &&
        (!Number.isInteger(safety) || (safety as number) < 0)
      ) {
        toast('安全庫存須為非負整數，或留空', 'error');
        return;
      }
      const result = await createHqProduct({
        branchId: Number(inventoryBranchId),
        sku: productSku.trim(),
        name: productName.trim(),
        productKind,
        price: parseFloat(productPrice),
        cost: parseFloat(productCost) || 0,
        safetyStock: safety,
      });
      toast(result.message || '商品已建立', 'success');
      setProductSku('');
      setProductName('');
      setProductKind('PHYSICAL');
      setProductSafetyStock('');
      await onReloadInventory();
    } catch (err) {
      toast(getErrorMessage(err, '建立商品失敗'), 'error');
    }
  }

  function openEditProduct(p: Product) {
    setEditingProduct(p);
    setEditSku(p.sku);
    setEditName(p.name);
    setEditKind(isServiceProduct(p) ? 'SERVICE' : 'PHYSICAL');
    setEditPrice(String(p.price));
    setEditCost(String(p.cost ?? 0));
    setEditSafetyStock(p.safetyStock != null ? String(p.safetyStock) : '');
    setEditActive(p.isActive !== false);
  }

  async function handleUpdateProduct(e: FormEvent) {
    e.preventDefault();
    if (!editingProduct) return;
    try {
      const safety =
        editKind === 'PHYSICAL' && editSafetyStock.trim() !== ''
          ? parseInt(editSafetyStock, 10)
          : null;
      if (
        editKind === 'PHYSICAL' &&
        editSafetyStock.trim() !== '' &&
        (!Number.isInteger(safety) || (safety as number) < 0)
      ) {
        toast('安全庫存須為非負整數，或留空', 'error');
        return;
      }
      const result = await updateHqProduct(editingProduct.id, {
        sku: editSku,
        name: editName,
        productKind: editKind,
        price: parseFloat(editPrice),
        cost: parseFloat(editCost) || 0,
        safetyStock: safety,
        isActive: editActive,
      });
      toast(result.message || '商品已更新', 'success');
      setEditingProduct(null);
      await onReloadInventory();
    } catch (err) {
      toast(getErrorMessage(err, '更新商品失敗'), 'error');
    }
  }

  return (
    <PageSection
      title="商品主檔"
      desc="僅總部可新增／編輯商品。進貨、盤點、庫存請至左側「進銷存」（DUTY 以上）"
    >
      <Field label="檢視分店">
        <Select
          value={inventoryBranchId === '' ? '' : String(inventoryBranchId)}
          onChange={(e) => setInventoryBranchId(Number(e.target.value) || '')}
          style={{ maxWidth: 280 }}
        >
          {branches.filter((b) => b.isActive).map((b) => (
            <option key={b.id} value={b.id}>
              {staffBranchLabel(b)}
            </option>
          ))}
        </Select>
      </Field>

      <div className="staff-grid mt-lg">
        <Card title="新增商品">
          <form onSubmit={handleCreateProduct} className="form-stack">
            <Field label="商品類型">
              <Select
                value={productKind}
                onChange={(e) => {
                  const kind = e.target.value as ProductKind;
                  setProductKind(kind);
                  if (kind === 'SERVICE') setProductSafetyStock('');
                }}
              >
                <option value="PHYSICAL">實體商品（控管庫存）</option>
                <option value="SERVICE">服務類／不控管庫存</option>
              </Select>
            </Field>
            <Field label="SKU">
              <Input value={productSku} onChange={(e) => setProductSku(e.target.value)} required />
            </Field>
            <Field label="商品名稱">
              <Input value={productName} onChange={(e) => setProductName(e.target.value)} required />
            </Field>
            <Field label="售價">
              <Input
                type="number"
                value={productPrice}
                onChange={(e) => setProductPrice(e.target.value)}
                required
              />
            </Field>
            <Field label="參考成本">
              <Input
                type="number"
                value={productCost}
                onChange={(e) => setProductCost(e.target.value)}
              />
            </Field>
            {productKind === 'PHYSICAL' ? (
              <Field label="安全庫存" hint="選填；庫存≦此值時於進銷存頁預警">
                <Input
                  type="number"
                  min={0}
                  value={productSafetyStock}
                  onChange={(e) => setProductSafetyStock(e.target.value)}
                  placeholder="例如 5"
                />
              </Field>
            ) : (
              <Alert tone="info">
                服務類不控管庫存：關閉進貨／盤點／安全庫存預警，僅定價與銷售統計。
              </Alert>
            )}
            <Button type="submit" disabled={!inventoryBranchId}>
              {productKind === 'SERVICE' ? '建立服務類商品' : '建立商品（庫存 0）'}
            </Button>
          </form>
        </Card>

        <Card
          title="商品一覽"
          subtitle={`顯示 ${filteredProducts.length}／${branchProducts.length} 筆 · 點編輯可改主檔`}
        >
          <div className="list-toolbar">
            <span className="text-muted text-sm">類型快篩</span>
            <Select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as 'ALL' | ProductKind)}
              aria-label="類型快篩"
            >
              <option value="ALL">全部（{branchProducts.length}）</option>
              <option value="PHYSICAL">實體（{physicalCount}）</option>
              <option value="SERVICE">服務類（{serviceCount}）</option>
            </Select>
          </div>
          <div className="table-wrap mt-md">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>類型</th>
                  <th>名稱</th>
                  <th>售價</th>
                  <th>成本</th>
                  <th>庫存</th>
                  <th>安全庫存</th>
                  <th>狀態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-muted text-center">
                      {branchProducts.length === 0 ? '此分店尚無商品' : '此類型尚無商品'}
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map((p) => {
                    const service = isServiceProduct(p);
                    return (
                      <tr key={p.id}>
                        <td className="mono">{p.sku}</td>
                        <td>
                          <Badge tone={service ? 'info' : 'neutral'}>
                            {service ? '服務類' : '實體'}
                          </Badge>
                        </td>
                        <td>{p.name}</td>
                        <td>${p.price}</td>
                        <td>${p.cost ?? 0}</td>
                        <td>{service ? '—' : p.stockQty}</td>
                        <td>
                          {service ? (
                            '—'
                          ) : p.safetyStock == null ? (
                            <span className="text-muted">關閉</span>
                          ) : (
                            p.safetyStock
                          )}
                        </td>
                        <td>
                          <Badge tone={p.isActive !== false ? 'success' : 'neutral'}>
                            {p.isActive !== false ? '上架' : '停售'}
                          </Badge>
                        </td>
                        <td>
                          <Button size="sm" variant="secondary" onClick={() => openEditProduct(p)}>
                            編輯
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Modal
        open={editingProduct !== null}
        title={`編輯商品 · ${editingProduct?.sku}`}
        onClose={() => setEditingProduct(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingProduct(null)}>
              取消
            </Button>
            <Button onClick={handleUpdateProduct}>儲存</Button>
          </>
        }
      >
        <form onSubmit={handleUpdateProduct} className="form-stack">
          <Field label="商品類型">
            <Select
              value={editKind}
              onChange={(e) => {
                const kind = e.target.value as ProductKind;
                setEditKind(kind);
                if (kind === 'SERVICE') setEditSafetyStock('');
              }}
            >
              <option value="PHYSICAL">實體商品（控管庫存）</option>
              <option value="SERVICE">服務類／不控管庫存</option>
            </Select>
          </Field>
          <Field label="SKU">
            <Input value={editSku} onChange={(e) => setEditSku(e.target.value)} required />
          </Field>
          <Field label="名稱">
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} required />
          </Field>
          <Field label="售價">
            <Input
              type="number"
              value={editPrice}
              onChange={(e) => setEditPrice(e.target.value)}
              required
            />
          </Field>
          <Field label="成本">
            <Input type="number" value={editCost} onChange={(e) => setEditCost(e.target.value)} />
          </Field>
          {editKind === 'PHYSICAL' ? (
            <Field label="安全庫存" hint="留空＝關閉預警">
              <Input
                type="number"
                min={0}
                value={editSafetyStock}
                onChange={(e) => setEditSafetyStock(e.target.value)}
              />
            </Field>
          ) : (
            <Alert tone="info">改為服務類後：庫存歸零、安全庫存關閉，且無法進貨／盤點。</Alert>
          )}
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editActive}
              onChange={(e) => setEditActive(e.target.checked)}
            />
            商品上架中
          </label>
        </form>
      </Modal>
    </PageSection>
  );
}
