import { type FormEvent, useEffect, useRef, useState } from 'react';
import BranchScopeBar from '../../components/staff/BranchScopeBar';
import { Alert, Badge, Button, Card, Field, Input, PageSection, Select } from '../../components/ui';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  createOpsReceipt,
  createOpsStockAdjustment,
  createOpsTransfer,
  fetchOpsPendingPurchaseOrders,
  fetchOpsReceipts,
  fetchOpsStockMovements,
  fetchOpsStocks,
  fetchReportBranches,
  getErrorMessage,
} from '../../lib/api';
import { staffBranchLabel } from '../../lib/branchLabel';
import { fmtDateTime, MOVEMENT_LABEL, PO_STATUS, PRODUCT_KIND_LABEL } from '../../lib/inventoryLabels';
import { resolveBranchId } from '../../lib/resolveBranchId';
import type { Branch, BranchStockRow, OpsReceiptRow, PurchaseOrder, StockMovement } from '../../types/api';

type AdjustReason = 'LOSS' | 'GAIN' | 'COUNT';

const ADJUST_REASON_LABELS: Record<AdjustReason, string> = {
  LOSS: '盤損',
  GAIN: '盤盈',
  COUNT: '盤點校正',
};

function isPhysical(s: Pick<BranchStockRow, 'productKind'>) {
  return s.productKind !== 'SERVICE';
}

/** DUTY 以上：依採購單驗收、盤點／盤損、同營業人調撥、庫存與流水。商品主檔／採購／應付僅總部。 */
export default function InventoryOpsPage() {
  const { toast } = useToast();
  const { staff, isAdmin } = useStaffAuth();
  const branchLocked = !isAdmin && Boolean(staff?.branchId);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchIdDraft, setBranchIdDraft] = useState<number | ''>('');
  const branchId = resolveBranchId(branchLocked, staff?.branchId, branches, branchIdDraft);
  const [stocks, setStocks] = useState<BranchStockRow[]>([]);
  const [pendingPos, setPendingPos] = useState<PurchaseOrder[]>([]);
  const [receipts, setReceipts] = useState<OpsReceiptRow[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);

  const [poId, setPoId] = useState('');
  const [receiveQty, setReceiveQty] = useState<Record<number, string>>({});
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState('');
  const [receiveNote, setReceiveNote] = useState('');
  const [receiving, setReceiving] = useState(false);
  const receiveInFlightRef = useRef(false);

  const [adjustProductId, setAdjustProductId] = useState<number | ''>('');
  const [adjustReason, setAdjustReason] = useState<AdjustReason>('LOSS');
  const [adjustQty, setAdjustQty] = useState('1');
  const [adjustNote, setAdjustNote] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const adjustInFlightRef = useRef(false);

  const [transferTo, setTransferTo] = useState<number | ''>('');
  const [transferProductId, setTransferProductId] = useState<number | ''>('');
  const [transferQty, setTransferQty] = useState('1');
  const [transferNote, setTransferNote] = useState('');
  const [transferring, setTransferring] = useState(false);
  const transferInFlightRef = useRef(false);

  const [kindFilter, setKindFilter] = useState<'ALL' | 'PHYSICAL' | 'SERVICE'>('ALL');
  const [q, setQ] = useState('');

  const physicalStocks = stocks.filter(isPhysical);
  const lowStockCount = physicalStocks.filter((s) => s.lowStock).length;
  const term = q.trim().toLowerCase();
  const filteredStocks = stocks.filter((s) => {
    if (kindFilter === 'PHYSICAL' && !isPhysical(s)) return false;
    if (kindFilter === 'SERVICE' && isPhysical(s)) return false;
    if (!term) return true;
    return [s.sku, s.name, s.barcode || ''].some((v) => v.toLowerCase().includes(term));
  });
  const selectedPo = pendingPos.find((p) => p.id === poId) || null;
  const adjustStock = physicalStocks.find((s) => s.productId === adjustProductId);
  const transferStock = physicalStocks.find((s) => s.productId === transferProductId);

  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchReportBranches();
        if (!cancelled && res.status === 'success' && res.data) setBranches(res.data);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入分店失敗'), 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  useEffect(() => {
    if (!branchId) return;
    const bid = Number(branchId);
    let cancelled = false;
    Promise.all([
      fetchOpsStocks({ branchId: bid }),
      fetchOpsPendingPurchaseOrders(bid),
      fetchOpsReceipts(bid),
      fetchOpsStockMovements({ branchId: bid }),
    ])
      .then(([stockRes, poRes, receiptRes, moveRes]) => {
        if (cancelled) return;
        setStocks(stockRes.data || []);
        setPendingPos(poRes.data || []);
        setReceipts(receiptRes.data || []);
        setMovements(moveRes.data || []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入進銷存失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, reloadKey, toast]);

  function selectPo(id: string) {
    setPoId(id);
    const po = pendingPos.find((p) => p.id === id);
    const draft: Record<number, string> = {};
    for (const item of po?.items || []) {
      draft[item.id] = String(Math.max(0, item.qtyOrdered - item.qtyReceived));
    }
    setReceiveQty(draft);
  }

  async function handleReceive(e: FormEvent) {
    e.preventDefault();
    if (!selectedPo || receiveInFlightRef.current) return;
    const items: { poItemId: number; qty: number }[] = [];
    for (const item of selectedPo.items) {
      const raw = (receiveQty[item.id] || '').trim();
      if (!raw || raw === '0') continue;
      const qty = parseInt(raw, 10);
      if (!Number.isInteger(qty) || qty < 0) {
        toast(`${item.product?.name || item.productId} 驗收數量須為非負整數`, 'error');
        return;
      }
      items.push({ poItemId: item.id, qty });
    }
    if (!items.length) {
      toast('請至少輸入一項驗收數量', 'error');
      return;
    }
    receiveInFlightRef.current = true;
    setReceiving(true);
    try {
      const res = await createOpsReceipt({
        purchaseOrderId: selectedPo.id,
        items,
        ...(supplierInvoiceNo.trim() ? { supplierInvoiceNo: supplierInvoiceNo.trim() } : {}),
        ...(receiveNote.trim() ? { note: receiveNote.trim() } : {}),
      });
      toast(res.message || '驗收入庫完成', 'success');
      setPoId('');
      setReceiveQty({});
      setSupplierInvoiceNo('');
      setReceiveNote('');
      reload();
    } catch (err) {
      toast(getErrorMessage(err, '驗收失敗'), 'error');
    } finally {
      receiveInFlightRef.current = false;
      setReceiving(false);
    }
  }

  async function handleStockAdjust(e: FormEvent) {
    e.preventDefault();
    if (!branchId || !adjustProductId || adjustInFlightRef.current) return;
    const qty = parseInt(adjustQty, 10);
    if (adjustReason === 'COUNT' ? !Number.isInteger(qty) || qty < 0 : !Number.isInteger(qty) || qty <= 0) {
      toast(adjustReason === 'COUNT' ? '實盤數量須為非負整數' : '數量須為正整數', 'error');
      return;
    }
    adjustInFlightRef.current = true;
    setAdjusting(true);
    try {
      const res = await createOpsStockAdjustment({
        branchId: Number(branchId),
        productId: Number(adjustProductId),
        reason: adjustReason,
        qty,
        note: adjustNote.trim() || null,
      });
      toast(res.message || '庫存已調整', 'success');
      setAdjustQty(adjustReason === 'COUNT' ? '0' : '1');
      setAdjustNote('');
      reload();
    } catch (err) {
      toast(getErrorMessage(err, '盤點／盤損失敗'), 'error');
    } finally {
      adjustInFlightRef.current = false;
      setAdjusting(false);
    }
  }

  async function handleTransfer(e: FormEvent) {
    e.preventDefault();
    if (!branchId || !transferTo || !transferProductId || transferInFlightRef.current) return;
    const qty = parseInt(transferQty, 10);
    if (!Number.isInteger(qty) || qty <= 0) {
      toast('調撥數量須為正整數', 'error');
      return;
    }
    transferInFlightRef.current = true;
    setTransferring(true);
    try {
      const res = await createOpsTransfer({
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
      transferInFlightRef.current = false;
      setTransferring(false);
    }
  }

  return (
    <div className="hq-dashboard">
      <BranchScopeBar
        branches={branches}
        branchId={branchId}
        locked={branchLocked}
        lockedLabel={staff?.branchName || (staff?.branchId ? `分店 #${staff.branchId}` : undefined)}
        hint="進銷存以此分店為範圍 · 商品主檔／採購單／應付帳款由總部管理"
        onChange={(id) => {
          setBranchIdDraft(id);
          setPoId('');
          setAdjustProductId('');
          setTransferProductId('');
          setTransferTo('');
        }}
      />

      <PageSection
        title="進銷存"
        desc="DUTY 以上可用 · 依採購單驗收入庫、盤點／盤損、同營業人分店調撥 · 庫存只能經進貨／盤點／調撥／銷貨異動"
      >
        {lowStockCount > 0 && (
          <div className="mt-md">
            <Alert tone="warning">安全庫存預警：本店有 {lowStockCount} 項實體商品已達／低於安全水位</Alert>
          </div>
        )}

        <div className="staff-grid mt-lg">
          <Card title="依採購單驗收" subtitle={`待驗收 ${pendingPos.length} 張 · 只填實收數量，進價以採購單為準`}>
            <form onSubmit={handleReceive} className="form-stack">
              <Field label="採購單">
                <Select value={poId} onChange={(e) => selectPo(e.target.value)}>
                  <option value="">— 選擇待驗收採購單 —</option>
                  {pendingPos.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.id} · {po.supplier?.name || `供應商 #${po.supplierId}`} · {PO_STATUS[po.status]?.label || po.status}
                    </option>
                  ))}
                </Select>
                {pendingPos.length === 0 && <p className="text-muted text-sm">目前沒有待驗收的採購單（採購單由總部建立並送出）</p>}
              </Field>
              {selectedPo && (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>商品</th>
                        <th>訂購</th>
                        <th>已收</th>
                        <th>本次實收</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedPo.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <span className="mono">{item.product?.sku}</span> {item.product?.name}
                          </td>
                          <td>{item.qtyOrdered}</td>
                          <td>{item.qtyReceived}</td>
                          <td style={{ minWidth: 96 }}>
                            <Input
                              type="number"
                              min={0}
                              value={receiveQty[item.id] ?? ''}
                              onChange={(e) => setReceiveQty((prev) => ({ ...prev, [item.id]: e.target.value }))}
                              aria-label={`${item.product?.name || item.productId} 本次實收`}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Field label="供應商發票號碼" hint="選填；可由總部事後補登">
                <Input
                  value={supplierInvoiceNo}
                  onChange={(e) => setSupplierInvoiceNo(e.target.value.toUpperCase())}
                  placeholder="例：AB12345678"
                  maxLength={20}
                />
              </Field>
              <Field label="備註" hint="選填">
                <Input value={receiveNote} onChange={(e) => setReceiveNote(e.target.value)} maxLength={200} />
              </Field>
              <Button type="submit" loading={receiving} disabled={!selectedPo}>
                確認驗收入庫
              </Button>
            </form>
          </Card>

          <Card title="盤點／盤損" subtitle="僅實體商品 · 留存異動紀錄">
            <form onSubmit={handleStockAdjust} className="form-stack">
              <Field label="商品">
                <Select
                  value={adjustProductId === '' ? '' : String(adjustProductId)}
                  onChange={(e) => {
                    const id = Number(e.target.value) || '';
                    setAdjustProductId(id);
                    if (id && adjustReason === 'COUNT') {
                      const s = physicalStocks.find((x) => x.productId === id);
                      if (s) setAdjustQty(String(s.onHand));
                    }
                  }}
                >
                  <option value="">— 請選擇實體商品 —</option>
                  {physicalStocks.map((s) => (
                    <option key={s.productId} value={s.productId}>
                      {s.sku} {s.name}（帳面 {s.onHand}）
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
                    setAdjustQty(r === 'COUNT' ? String(adjustStock?.onHand ?? 0) : '1');
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
                    ? '自帳面扣減；不可扣成負數'
                    : adjustReason === 'GAIN'
                      ? '加至帳面庫存'
                      : adjustStock
                        ? `目前帳面 ${adjustStock.onHand}`
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

          <Card title="分店調撥" subtitle="僅限同一營業人（同統編）分店；跨統編須走進銷貨">
            <form onSubmit={handleTransfer} className="form-stack">
              <Field label="調入分店">
                <Select
                  value={transferTo === '' ? '' : String(transferTo)}
                  onChange={(e) => setTransferTo(Number(e.target.value) || '')}
                >
                  <option value="">— 選擇調入分店 —</option>
                  {branches
                    .filter((b) => b.id !== branchId)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {staffBranchLabel(b)}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="商品">
                <Select
                  value={transferProductId === '' ? '' : String(transferProductId)}
                  onChange={(e) => setTransferProductId(Number(e.target.value) || '')}
                >
                  <option value="">— 請選擇實體商品 —</option>
                  {physicalStocks
                    .filter((s) => s.onHand > 0)
                    .map((s) => (
                      <option key={s.productId} value={s.productId}>
                        {s.sku} {s.name}（可調 {s.onHand}）
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="數量" hint={transferStock ? `本店帳面 ${transferStock.onHand}` : undefined}>
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
        </div>

        <Card title="分店庫存" className="mt-lg" subtitle={`顯示 ${filteredStocks.length}／${stocks.length} 筆 · 上架與售價由總部設定`}>
          <div className="list-toolbar">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜尋 SKU／名稱／條碼"
              aria-label="搜尋商品"
              style={{ maxWidth: 260 }}
            />
            <Select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as 'ALL' | 'PHYSICAL' | 'SERVICE')}
              aria-label="類型快篩"
            >
              <option value="ALL">全部類型</option>
              <option value="PHYSICAL">實體</option>
              <option value="SERVICE">服務類</option>
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
                  <th>上架</th>
                </tr>
              </thead>
              <tbody>
                {filteredStocks.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-muted text-center">
                      {stocks.length === 0 ? '此分店尚無商品（由總部於「進銷存」上架）' : '沒有符合的商品'}
                    </td>
                  </tr>
                ) : (
                  filteredStocks.map((s) => {
                    const physical = isPhysical(s);
                    return (
                      <tr key={s.id}>
                        <td className="mono">{s.sku}</td>
                        <td>
                          <Badge tone={physical ? 'neutral' : 'info'}>{PRODUCT_KIND_LABEL[s.productKind] || s.productKind}</Badge>
                        </td>
                        <td>{s.name}</td>
                        <td>${s.price}</td>
                        <td>{physical ? s.onHand : '—'}</td>
                        <td>
                          {!physical ? (
                            '—'
                          ) : s.safetyStock == null ? (
                            <span className="text-muted">關閉</span>
                          ) : (
                            <span>
                              {s.safetyStock} {s.lowStock ? <Badge tone="warning">預警</Badge> : null}
                            </span>
                          )}
                        </td>
                        <td>
                          <Badge tone={s.isListed && s.productActive ? 'success' : 'neutral'}>
                            {!s.productActive ? '停售' : s.isListed ? '上架' : '下架'}
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

        <div className="staff-grid mt-lg">
          <Card title="庫存流水" subtitle="最近 200 筆（進貨／銷貨／盤點／調撥）">
            <ul className="info-list">
              {movements.length === 0 ? (
                <li className="text-muted">尚無庫存異動</li>
              ) : (
                movements.slice(0, 30).map((m) => (
                  <li key={m.id}>
                    <Badge tone={m.qtyDelta < 0 ? 'warning' : 'success'}>{MOVEMENT_LABEL[m.refType] || m.refType}</Badge>{' '}
                    {m.product?.sku} {m.product?.name} {m.qtyDelta > 0 ? `+${m.qtyDelta}` : m.qtyDelta} → {m.balanceAfter}
                    {m.reason ? ` · ${m.reason}` : ''} · {fmtDateTime(m.createdAt)}
                  </li>
                ))
              )}
            </ul>
          </Card>

          <Card title="最近驗收">
            <ul className="info-list">
              {receipts.length === 0 ? (
                <li className="text-muted">尚無驗收紀錄</li>
              ) : (
                receipts.slice(0, 15).map((r) => (
                  <li key={r.id}>
                    <strong className="mono">{r.id}</strong>
                    {r.purchaseOrderId ? ` · ${r.purchaseOrderId}` : ''} · {r.supplier?.name} ·{' '}
                    {r.items.map((i) => `${i.product?.name}×${i.qty}`).join('、')}
                    {r.supplierInvoiceNo ? ` · 發票 ${r.supplierInvoiceNo}` : ''} · {fmtDateTime(r.receivedAt)}
                  </li>
                ))
              )}
            </ul>
          </Card>
        </div>
      </PageSection>
    </div>
  );
}
