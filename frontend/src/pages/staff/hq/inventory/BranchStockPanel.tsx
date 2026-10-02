import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, Select } from '../../../../components/ui';
import { useToast } from '../../../../contexts/ToastContext';
import {
  createHqStockTransfer,
  fetchHqBranchStocks,
  fetchHqProducts,
  fetchHqStockMovements,
  getErrorMessage,
  upsertHqBranchStock,
} from '../../../../lib/api';
import { staffBranchLabel } from '../../../../lib/branchLabel';
import { fmtDateTime, money, MOVEMENT_LABEL, PRODUCT_KIND_LABEL } from '../../../../lib/inventoryLabels';
import type { Branch, BranchStockRow, ProductMaster, StockMovement } from '../../../../types/api';

type ListingRow = { product: ProductMaster; stock: BranchStockRow | null };

/** 分店上架（售價／安全庫存）、庫存與成本（後端移動平均）、同營業人調撥與流水 */
export default function BranchStockPanel({ branches, onChanged }: { branches: Branch[]; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const activeBranches = branches.filter((b) => b.isActive);
  const [branchIdDraft, setBranchIdDraft] = useState<number | ''>('');
  const branchId: number | '' =
    branchIdDraft !== '' && activeBranches.some((b) => b.id === branchIdDraft)
      ? branchIdDraft
      : activeBranches.length
        ? activeBranches[0].id
        : '';
  const branch = activeBranches.find((b) => b.id === branchId) || null;

  const [products, setProducts] = useState<ProductMaster[]>([]);
  const [stocks, setStocks] = useState<BranchStockRow[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [q, setQ] = useState('');

  const [editing, setEditing] = useState<ListingRow | null>(null);
  const [salePrice, setSalePrice] = useState('');
  const [safetyStock, setSafetyStock] = useState('');
  const [isListed, setIsListed] = useState(true);
  const [saving, setSaving] = useState(false);

  const [transferTo, setTransferTo] = useState<number | ''>('');
  const [transferProductId, setTransferProductId] = useState<number | ''>('');
  const [transferQty, setTransferQty] = useState('1');
  const [transferNote, setTransferNote] = useState('');
  const [transferring, setTransferring] = useState(false);
  const inFlightRef = useRef(false);

  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    Promise.all([
      fetchHqProducts({ activeOnly: true }),
      fetchHqBranchStocks({ branchId: Number(branchId) }),
      fetchHqStockMovements({ branchId: Number(branchId) }),
    ])
      .then(([prodRes, stockRes, moveRes]) => {
        if (cancelled) return;
        setProducts(prodRes.data || []);
        setStocks(stockRes.data || []);
        setMovements(moveRes.data || []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入分店庫存失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, reloadKey, toast]);

  const stockByProduct = new Map(stocks.map((s) => [s.productId, s]));
  const term = q.trim().toLowerCase();
  const rows: ListingRow[] = products
    .filter((p) => !term || [p.sku, p.name, p.barcode || ''].some((v) => v.toLowerCase().includes(term)))
    .map((p) => ({ product: p, stock: stockByProduct.get(p.id) || null }));
  const sameEntityTargets = activeBranches.filter(
    (b) => b.id !== branchId && branch?.legalEntityId != null && b.legalEntityId === branch.legalEntityId,
  );
  const transferable = stocks.filter((s) => s.productKind !== 'SERVICE' && s.onHand > 0);

  function openEdit(row: ListingRow) {
    setEditing(row);
    setSalePrice(row.stock?.salePrice != null ? String(row.stock.salePrice) : '');
    setSafetyStock(row.stock?.safetyStock != null ? String(row.stock.safetyStock) : '');
    setIsListed(row.stock ? row.stock.isListed : true);
  }

  async function handleSave() {
    if (!editing || !branchId || inFlightRef.current) return;
    const sp = salePrice.trim() === '' ? null : Number(salePrice);
    if (sp !== null && (!Number.isInteger(sp) || sp < 0)) {
      toast('分店售價須為非負整數或留空', 'error');
      return;
    }
    const physical = editing.product.productKind !== 'SERVICE';
    const ss = !physical || safetyStock.trim() === '' ? null : Number(safetyStock);
    if (ss !== null && (!Number.isInteger(ss) || ss < 0)) {
      toast('安全庫存須為非負整數或留空', 'error');
      return;
    }
    inFlightRef.current = true;
    setSaving(true);
    try {
      const res = await upsertHqBranchStock({
        branchId: Number(branchId),
        productId: editing.product.id,
        salePrice: sp,
        safetyStock: ss,
        isListed,
      });
      toast(res.message || '已更新', 'success');
      setEditing(null);
      reload();
      await onChanged();
    } catch (err) {
      toast(getErrorMessage(err, '更新上架設定失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  }

  async function handleTransfer(e: FormEvent) {
    e.preventDefault();
    if (!branchId || !transferTo || !transferProductId || inFlightRef.current) return;
    const qty = parseInt(transferQty, 10);
    if (!Number.isInteger(qty) || qty <= 0) {
      toast('調撥數量須為正整數', 'error');
      return;
    }
    inFlightRef.current = true;
    setTransferring(true);
    try {
      const res = await createHqStockTransfer({
        fromBranchId: Number(branchId),
        toBranchId: Number(transferTo),
        items: [{ productId: Number(transferProductId), qty }],
        ...(transferNote.trim() ? { note: transferNote.trim() } : {}),
      });
      toast(res.message || '調撥完成', 'success');
      setTransferQty('1');
      setTransferNote('');
      reload();
    } catch (err) {
      toast(getErrorMessage(err, '調撥失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setTransferring(false);
    }
  }

  return (
    <>
      <div className="list-toolbar mt-lg">
        <Select
          value={branchId === '' ? '' : String(branchId)}
          onChange={(e) => {
            setBranchIdDraft(Number(e.target.value) || '');
            setTransferTo('');
            setTransferProductId('');
          }}
          aria-label="分店"
          style={{ maxWidth: 280 }}
        >
          {activeBranches.map((b) => (
            <option key={b.id} value={b.id}>
              {staffBranchLabel(b)}
            </option>
          ))}
        </Select>
        <span className="text-muted text-sm">
          營業人：{branch?.legalEntity ? `${branch.legalEntity.name}（${branch.legalEntity.ubn || branch.legalEntity.code}）` : '未綁定'}
        </span>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜尋 SKU／名稱／條碼"
          aria-label="搜尋商品"
          style={{ maxWidth: 240 }}
        />
      </div>

      <Card title="上架與庫存" className="mt-md" subtitle="庫存只能經驗收／盤點／調撥／銷貨異動；平均成本由驗收移動平均計算">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>名稱</th>
                <th>類型</th>
                <th>售價</th>
                <th>庫存</th>
                <th>平均成本</th>
                <th>庫存金額</th>
                <th>安全庫存</th>
                <th>上架</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-muted text-center">
                    尚無啟用中商品
                  </td>
                </tr>
              ) : (
                rows.map(({ product: p, stock: s }) => {
                  const physical = p.productKind !== 'SERVICE';
                  return (
                    <tr key={p.id}>
                      <td className="mono">{p.sku}</td>
                      <td>{p.name}</td>
                      <td>{PRODUCT_KIND_LABEL[p.productKind] || p.productKind}</td>
                      <td>
                        {s ? `$${s.price}` : `$${p.listPrice}`}
                        {s?.salePrice != null ? <div className="text-sm text-muted">分店價</div> : null}
                      </td>
                      <td>{!physical ? '—' : s ? s.onHand : 0}</td>
                      <td>{physical && s ? money(s.avgCost) : '—'}</td>
                      <td>{physical && s ? money(s.stockValue) : '—'}</td>
                      <td>
                        {!physical ? '—' : s?.safetyStock == null ? <span className="text-muted">關閉</span> : (
                          <span>
                            {s.safetyStock} {s.lowStock ? <Badge tone="warning">預警</Badge> : null}
                          </span>
                        )}
                      </td>
                      <td>
                        <Badge tone={s?.isListed ? 'success' : 'neutral'}>{!s ? '未上架' : s.isListed ? '上架' : '下架'}</Badge>
                      </td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => openEdit({ product: p, stock: s })}>
                          {s ? '設定' : '上架'}
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

      <div className="staff-grid mt-lg">
        <Card title="分店調撥" subtitle="僅同營業人（同統編）分店；跨統編後端 409 拒絕">
          <form onSubmit={handleTransfer} className="form-stack">
            <Field label="調入分店">
              <Select value={transferTo === '' ? '' : String(transferTo)} onChange={(e) => setTransferTo(Number(e.target.value) || '')}>
                <option value="">— 選擇同營業人分店 —</option>
                {sameEntityTargets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {staffBranchLabel(b)}
                  </option>
                ))}
              </Select>
              {sameEntityTargets.length === 0 && <p className="text-muted text-sm">此營業人沒有其他分店可調撥</p>}
            </Field>
            <Field label="商品">
              <Select
                value={transferProductId === '' ? '' : String(transferProductId)}
                onChange={(e) => setTransferProductId(Number(e.target.value) || '')}
              >
                <option value="">— 選擇商品 —</option>
                {transferable.map((s) => (
                  <option key={s.productId} value={s.productId}>
                    {s.sku} {s.name}（可調 {s.onHand}）
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="數量">
              <Input type="number" min={1} value={transferQty} onChange={(e) => setTransferQty(e.target.value)} />
            </Field>
            <Field label="備註" hint="選填">
              <Input value={transferNote} onChange={(e) => setTransferNote(e.target.value)} maxLength={200} />
            </Field>
            <Button type="submit" loading={transferring} disabled={!transferTo || !transferProductId}>
              確認調撥
            </Button>
          </form>
        </Card>

        <Card title="庫存流水" subtitle="最近 200 筆">
          <ul className="info-list">
            {movements.length === 0 ? (
              <li className="text-muted">尚無庫存異動</li>
            ) : (
              movements.slice(0, 40).map((m) => (
                <li key={m.id}>
                  <Badge tone={m.qtyDelta < 0 ? 'warning' : 'success'}>{MOVEMENT_LABEL[m.refType] || m.refType}</Badge>{' '}
                  {m.product?.sku} {m.product?.name} {m.qtyDelta > 0 ? `+${m.qtyDelta}` : m.qtyDelta} → {m.balanceAfter}
                  {m.unitCost != null ? ` @ ${money(m.unitCost)}` : ''}
                  {m.refId ? ` · ${m.refId}` : ''}
                  {m.reason ? ` · ${m.reason}` : ''} · {fmtDateTime(m.createdAt)}
                </li>
              ))
            )}
          </ul>
        </Card>
      </div>

      <Modal
        open={editing !== null}
        title={`分店上架 · ${editing?.product.name || ''}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button loading={saving} onClick={() => void handleSave()}>
              儲存
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <Field label="分店售價（含稅）" hint={`留空＝使用建議售價 $${editing?.product.listPrice ?? 0}`}>
            <Input type="number" min={0} step={1} value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
          </Field>
          {editing?.product.productKind !== 'SERVICE' && (
            <Field label="安全庫存" hint="留空＝關閉預警">
              <Input type="number" min={0} value={safetyStock} onChange={(e) => setSafetyStock(e.target.value)} />
            </Field>
          )}
          <label className="checkbox-item">
            <input type="checkbox" checked={isListed} onChange={(e) => setIsListed(e.target.checked)} />
            於此分店 POS 上架
          </label>
        </div>
      </Modal>
    </>
  );
}
