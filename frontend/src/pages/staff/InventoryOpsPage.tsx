import { type FormEvent, useCallback, useEffect, useState } from 'react';
import BranchScopeBar from '../../components/staff/BranchScopeBar';
import { Alert, Badge, Button, Card, Field, Input, PageSection, Select } from '../../components/ui';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  createOpsPurchase,
  createOpsStockAdjustment,
  fetchOpsInventoryProducts,
  fetchOpsPurchases,
  fetchOpsStockMovements,
  fetchReportBranches,
  getErrorMessage,
} from '../../lib/api';
import { resolveBranchId } from '../../lib/resolveBranchId';
import type { Branch, Product, PurchaseOrder, StockMovement } from '../../types/api';

type AdjustReason = 'LOSS' | 'GAIN' | 'COUNT';

type PurchaseLineDraft = {
  productId: number;
  productName: string;
  sku: string;
  qty: number;
  unitCost: number;
};

const ADJUST_REASON_LABELS: Record<AdjustReason, string> = {
  LOSS: '盤損',
  GAIN: '盤盈',
  COUNT: '盤點校正（實盤數）',
};

function isServiceProduct(p: Pick<Product, 'productKind'> | null | undefined) {
  return String(p?.productKind || 'PHYSICAL').toUpperCase() === 'SERVICE';
}

function isLowStock(p: Product) {
  if (isServiceProduct(p)) return false;
  if (p.safetyStock == null) return false;
  return Number(p.stockQty) <= Number(p.safetyStock);
}

function movementReasonLabel(refType: string | null | undefined) {
  const t = String(refType || '').toUpperCase();
  if (t === 'LOSS') return '盤損';
  if (t === 'GAIN') return '盤盈';
  if (t === 'STOCKTAKE' || t === 'ADJUST') return '盤點校正';
  if (t === 'PURCHASE') return '進貨';
  if (t === 'SALE') return '銷貨';
  if (t === 'SALE_CANCEL') return '銷貨取消';
  return t || '異動';
}

/** DUTY 以上：進貨／盤點／庫存一覽。新品建立僅總部 ADMIN。 */
export default function InventoryOpsPage() {
  const { toast } = useToast();
  const { staff, isAdmin } = useStaffAuth();
  const branchLocked = !isAdmin && Boolean(staff?.branchId);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchIdDraft, setBranchIdDraft] = useState<number | ''>('');
  const branchId = resolveBranchId(branchLocked, staff?.branchId, branches, branchIdDraft);
  const setBranchId = setBranchIdDraft;
  const [products, setProducts] = useState<Product[]>([]);
  const [purchases, setPurchases] = useState<PurchaseOrder[]>([]);
  const [adjustments, setAdjustments] = useState<StockMovement[]>([]);

  const [orderSupplier, setOrderSupplier] = useState('');
  const [orderNote, setOrderNote] = useState('');
  const [orderProductId, setOrderProductId] = useState<number | ''>('');
  const [orderQty, setOrderQty] = useState('10');
  const [orderUnitCost, setOrderUnitCost] = useState('50');
  const [orderLines, setOrderLines] = useState<PurchaseLineDraft[]>([]);
  const [receiving, setReceiving] = useState(false);

  const [adjustProductId, setAdjustProductId] = useState<number | ''>('');
  const [adjustReason, setAdjustReason] = useState<AdjustReason>('LOSS');
  const [adjustQty, setAdjustQty] = useState('1');
  const [adjustNote, setAdjustNote] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [kindFilter, setKindFilter] = useState<'ALL' | 'PHYSICAL' | 'SERVICE'>('ALL');

  const physicalProducts = products.filter((p) => !isServiceProduct(p));
  const filteredProducts = products.filter((p) => {
    if (kindFilter === 'ALL') return true;
    if (kindFilter === 'SERVICE') return isServiceProduct(p);
    return !isServiceProduct(p);
  });
  const serviceCount = products.length - physicalProducts.length;
  const lowStockCount = physicalProducts.filter(isLowStock).length;
  const selectedAdjustProduct = physicalProducts.find((p) => p.id === adjustProductId);
  const orderTotal = orderLines.reduce((sum, l) => sum + l.qty * l.unitCost, 0);

  const loadData = useCallback(async () => {
    if (!branchId) return;
    try {
      const [prodRes, purchaseRes, moveRes] = await Promise.all([
        fetchOpsInventoryProducts(Number(branchId)),
        fetchOpsPurchases(Number(branchId)),
        fetchOpsStockMovements({ branchId: Number(branchId), refType: 'ADJUSTMENT' }),
      ]);
      if (prodRes.status === 'success' && prodRes.data) setProducts(prodRes.data);
      if (purchaseRes.status === 'success' && purchaseRes.data) setPurchases(purchaseRes.data);
      if (moveRes.status === 'success' && moveRes.data) setAdjustments(moveRes.data);
    } catch (err) {
      toast(getErrorMessage(err, '載入進銷存失敗'), 'error');
    }
  }, [branchId, toast]);

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!branchId) return;
      try {
        const [prodRes, purchaseRes, moveRes] = await Promise.all([
          fetchOpsInventoryProducts(Number(branchId)),
          fetchOpsPurchases(Number(branchId)),
          fetchOpsStockMovements({ branchId: Number(branchId), refType: 'ADJUSTMENT' }),
        ]);
        if (cancelled) return;
        if (prodRes.status === 'success' && prodRes.data) setProducts(prodRes.data);
        if (purchaseRes.status === 'success' && purchaseRes.data) setPurchases(purchaseRes.data);
        if (moveRes.status === 'success' && moveRes.data) setAdjustments(moveRes.data);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入進銷存失敗'), 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, toast]);

  function addOrderLine() {
    if (!orderProductId) return;
    const product = physicalProducts.find((p) => p.id === Number(orderProductId));
    if (!product) {
      toast('僅實體商品可進貨', 'error');
      return;
    }
    const qty = parseInt(orderQty, 10);
    const unitCost = parseFloat(orderUnitCost);
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isFinite(unitCost)) {
      toast('數量與單價無效', 'error');
      return;
    }
    setOrderLines((prev) => {
      const existing = prev.find((l) => l.productId === product.id);
      if (existing) {
        return prev.map((l) =>
          l.productId === product.id ? { ...l, qty, unitCost } : l,
        );
      }
      return [
        ...prev,
        {
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          qty,
          unitCost,
        },
      ];
    });
    setOrderProductId('');
  }

  async function handleReceiveStock(e: FormEvent) {
    e.preventDefault();
    if (!branchId || orderLines.length === 0) return;
    setReceiving(true);
    try {
      const result = await createOpsPurchase({
        branchId: Number(branchId),
        supplier: orderSupplier.trim() || undefined,
        note: orderNote.trim() || undefined,
        items: orderLines.map((l) => ({
          productId: l.productId,
          qty: l.qty,
          unitCost: l.unitCost,
        })),
      });
      toast(result.message || '進貨入庫成功', 'success');
      setOrderLines([]);
      setOrderSupplier('');
      setOrderNote('');
      await loadData();
    } catch (err) {
      toast(getErrorMessage(err, '進貨失敗'), 'error');
    } finally {
      setReceiving(false);
    }
  }

  async function handleStockAdjust(e: FormEvent) {
    e.preventDefault();
    if (!adjustProductId) {
      toast('請選擇商品', 'error');
      return;
    }
    const qty = parseInt(adjustQty, 10);
    if (adjustReason === 'COUNT') {
      if (!Number.isInteger(qty) || qty < 0) {
        toast('實盤數量須為非負整數', 'error');
        return;
      }
    } else if (!Number.isInteger(qty) || qty <= 0) {
      toast('數量須為正整數', 'error');
      return;
    }
    setAdjusting(true);
    try {
      const result = await createOpsStockAdjustment({
        productId: Number(adjustProductId),
        reason: adjustReason,
        qty,
        note: adjustNote.trim() || null,
      });
      toast(result.message || '庫存已調整', 'success');
      setAdjustQty(adjustReason === 'COUNT' ? '0' : '1');
      setAdjustNote('');
      await loadData();
    } catch (err) {
      toast(getErrorMessage(err, '盤點／盤損失敗'), 'error');
    } finally {
      setAdjusting(false);
    }
  }

  return (
    <div className="hq-dashboard">
      <BranchScopeBar
        branches={branches}
        branchId={branchId}
        locked={branchLocked}
        lockedLabel={staff?.branchName || (staff?.branchId ? `分店 #${staff.branchId}` : undefined)}
        hint="進銷存以此分店為範圍 · 新品請至總部建立"
        onChange={(id) => {
          setBranchId(id);
          setOrderLines([]);
          setAdjustProductId('');
        }}
      />

      <PageSection
        title="進銷存"
        desc="DUTY 以上可用 · 進貨／盤點／庫存一覽 · 新增商品僅總部"
      >
        {lowStockCount > 0 && (
          <div className="mt-md">
            <Alert tone="warning">
              安全庫存預警：本店有 {lowStockCount} 項實體商品庫存已達／低於安全水位
            </Alert>
          </div>
        )}

        <div className="staff-grid mt-lg">
          <Card title="新增訂貨單" subtitle="僅實體商品可進貨">
            <div className="form-stack">
              <Field label="供應商（選填）">
                <Input value={orderSupplier} onChange={(e) => setOrderSupplier(e.target.value)} />
              </Field>
              <Field label="備註（選填）">
                <Input value={orderNote} onChange={(e) => setOrderNote(e.target.value)} />
              </Field>
              <Field label="商品">
                <Select
                  value={orderProductId === '' ? '' : String(orderProductId)}
                  onChange={(e) => setOrderProductId(Number(e.target.value) || '')}
                >
                  <option value="">— 請選擇實體商品 —</option>
                  {physicalProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} {p.name}（庫存 {p.stockQty}）
                    </option>
                  ))}
                </Select>
                {physicalProducts.length === 0 && (
                  <p className="text-muted text-sm">尚無可進貨實體商品（請總部先建立新品）</p>
                )}
              </Field>
              <div className="bind-row">
                <Field label="數量">
                  <Input type="number" value={orderQty} onChange={(e) => setOrderQty(e.target.value)} />
                </Field>
                <Field label="進貨單價">
                  <Input
                    type="number"
                    value={orderUnitCost}
                    onChange={(e) => setOrderUnitCost(e.target.value)}
                  />
                </Field>
              </div>
              <Button type="button" variant="secondary" onClick={addOrderLine} disabled={!orderProductId}>
                加入訂貨明細
              </Button>
            </div>
          </Card>

          <Card title="進貨入庫" subtitle={`明細 ${orderLines.length} 項 · 預估 $${orderTotal}`}>
            <form onSubmit={handleReceiveStock} className="form-stack">
              <ul className="info-list">
                {orderLines.length === 0 ? (
                  <li className="text-muted">請先於「新增訂貨單」加入商品明細</li>
                ) : (
                  orderLines.map((l) => (
                    <li key={l.productId}>
                      {l.sku} {l.productName} × {l.qty} @ ${l.unitCost}
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() =>
                          setOrderLines((prev) => prev.filter((x) => x.productId !== l.productId))
                        }
                      >
                        移除
                      </Button>
                    </li>
                  ))
                )}
              </ul>
              <Button type="submit" loading={receiving} disabled={orderLines.length === 0}>
                確認進貨入庫
              </Button>
            </form>
          </Card>
        </div>

        <div className="staff-grid mt-lg">
          <Card title="盤點／盤損" subtitle="僅實體商品；服務類不適用">
            <form onSubmit={handleStockAdjust} className="form-stack">
              <Field label="商品">
                <Select
                  value={adjustProductId === '' ? '' : String(adjustProductId)}
                  onChange={(e) => {
                    const id = Number(e.target.value) || '';
                    setAdjustProductId(id);
                    if (id && adjustReason === 'COUNT') {
                      const p = physicalProducts.find((x) => x.id === id);
                      if (p) setAdjustQty(String(p.stockQty));
                    }
                  }}
                >
                  <option value="">— 請選擇實體商品 —</option>
                  {physicalProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} {p.name}（帳面 {p.stockQty}）
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="調整類型">
                <Select
                  value={adjustReason}
                  onChange={(e) => {
                    const r = e.target.value as AdjustReason;
                    setAdjustReason(r);
                    setAdjustQty(r === 'COUNT' ? String(selectedAdjustProduct?.stockQty ?? 0) : '1');
                  }}
                >
                  <option value="LOSS">盤損（報損／遺失／毀損）</option>
                  <option value="GAIN">盤盈（多出庫存）</option>
                  <option value="COUNT">盤點校正（輸入實盤數量）</option>
                </Select>
              </Field>
              <Field
                label={adjustReason === 'COUNT' ? '實盤數量' : '數量'}
                hint={
                  adjustReason === 'LOSS'
                    ? '將自帳面庫存扣減'
                    : adjustReason === 'GAIN'
                      ? '將加至帳面庫存'
                      : selectedAdjustProduct
                        ? `目前帳面 ${selectedAdjustProduct.stockQty}`
                        : undefined
                }
              >
                <Input
                  type="number"
                  min={adjustReason === 'COUNT' ? 0 : 1}
                  value={adjustQty}
                  onChange={(e) => setAdjustQty(e.target.value)}
                  required
                />
              </Field>
              <Field label="備註" hint="選填">
                <Input
                  value={adjustNote}
                  onChange={(e) => setAdjustNote(e.target.value)}
                  placeholder="例：過期報損、包裝破損"
                  maxLength={200}
                />
              </Field>
              <Button type="submit" loading={adjusting} disabled={!adjustProductId}>
                確認{ADJUST_REASON_LABELS[adjustReason]}
              </Button>
            </form>
          </Card>

          <Card title="最近盤點／盤損紀錄">
            <ul className="info-list">
              {adjustments.length === 0 ? (
                <li className="text-muted">尚無盤點／盤損紀錄</li>
              ) : (
                adjustments.slice(0, 12).map((m) => (
                  <li key={m.id}>
                    <Badge
                      tone={
                        m.refType === 'LOSS' ? 'warning' : m.refType === 'GAIN' ? 'success' : 'info'
                      }
                    >
                      {movementReasonLabel(m.refType)}
                    </Badge>{' '}
                    {m.product?.sku} {m.product?.name}
                    {m.refType === 'LOSS'
                      ? ` −${m.qty}`
                      : m.refType === 'GAIN'
                        ? ` +${m.qty}`
                        : ` Δ${m.qty}`}
                    {m.note ? ` · ${m.note}` : ''} ·{' '}
                    {new Date(m.createdAt).toLocaleString('zh-TW')}
                  </li>
                ))
              )}
            </ul>
          </Card>
        </div>

        <Card
          title="商品庫存一覽"
          className="mt-lg"
          subtitle={`顯示 ${filteredProducts.length}／${products.length} 筆 · 新品請至總部建立`}
        >
          <div className="list-toolbar">
            <span className="text-muted text-sm">類型快篩</span>
            <Select
              value={kindFilter}
              onChange={(e) =>
                setKindFilter(e.target.value as 'ALL' | 'PHYSICAL' | 'SERVICE')
              }
              aria-label="類型快篩"
            >
              <option value="ALL">全部（{products.length}）</option>
              <option value="PHYSICAL">實體（{physicalProducts.length}）</option>
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
                  <th>庫存</th>
                  <th>安全庫存</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-muted text-center">
                {products.length === 0 ? '此分店尚無商品（請至 總部 HQ → 商品主檔 建立）' : '此類型尚無商品'}
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map((p) => {
                    const service = isServiceProduct(p);
                    const low = isLowStock(p);
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
                        <td>{service ? '—' : p.stockQty}</td>
                        <td>
                          {service ? (
                            '—'
                          ) : p.safetyStock == null ? (
                            <span className="text-muted">關閉</span>
                          ) : (
                            <span>
                              {p.safetyStock}
                              {low ? (
                                <>
                                  {' '}
                                  <Badge tone="warning">預警</Badge>
                                </>
                              ) : null}
                            </span>
                          )}
                        </td>
                        <td>
                          <Badge tone={p.isActive !== false ? 'success' : 'neutral'}>
                            {p.isActive !== false ? '上架' : '停售'}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="最近進貨單" className="mt-lg">
          <ul className="info-list">
            {purchases.slice(0, 10).map((po) => (
              <li key={po.id}>
                <strong>{po.id}</strong> · ${po.totalCost}
                {po.supplier ? ` · ${po.supplier}` : ''} ·{' '}
                {new Date(po.createdAt).toLocaleString('zh-TW')}
              </li>
            ))}
            {purchases.length === 0 && <li className="text-muted">尚無進貨紀錄</li>}
          </ul>
        </Card>
      </PageSection>
    </div>
  );
}
