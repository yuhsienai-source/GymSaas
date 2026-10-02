import { type FormEvent, useEffect, useRef, useState } from 'react';
import ReasonModal from '../../../../components/staff/ReasonModal';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select } from '../../../../components/ui';
import { useToast } from '../../../../contexts/ToastContext';
import {
  createHqPurchaseOrder,
  createHqPurchaseReceipt,
  fetchHqProducts,
  fetchHqPurchaseOrders,
  fetchHqPurchaseReceipts,
  fetchHqSuppliers,
  getErrorMessage,
  setHqReceiptSupplierInvoice,
  transitionHqPurchaseOrder,
} from '../../../../lib/api';
import { staffBranchLabel } from '../../../../lib/branchLabel';
import { fmtDate, fmtDateTime, money, PO_STATUS, TAX_TYPE_LABEL } from '../../../../lib/inventoryLabels';
import type { Branch, ProductMaster, PurchaseOrder, PurchaseReceipt, Supplier, TaxType } from '../../../../types/api';

type LineDraft = { productId: number; qty: string; unitCost: string; taxType: TaxType };
type ReceiveDraft = Record<number, { qty: string; unitCost: string }>;

function parseLines(lines: LineDraft[]) {
  const out: { productId: number; qty: number; unitCost: number; taxType: TaxType }[] = [];
  for (const l of lines) {
    const qty = Number(l.qty);
    const unitCost = Number(l.unitCost);
    if (!Number.isInteger(qty) || qty <= 0) return '採購數量須為正整數';
    if (!Number.isFinite(unitCost) || unitCost < 0) return '進價須為非負數字（未稅）';
    out.push({ productId: l.productId, qty, unitCost, taxType: l.taxType });
  }
  return out;
}

/** 採購單（草稿 → 送出 → 驗收／短交結案）；金額小計／稅額／總額一律由後端計算 */
export default function PurchasingPanel({ branches }: { branches: Branch[] }) {
  const { toast } = useToast();
  const activeBranches = branches.filter((b) => b.isActive && b.legalEntityId != null);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [receipts, setReceipts] = useState<PurchaseReceipt[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<ProductMaster[]>([]);
  const [statusFilter, setStatusFilter] = useState('');

  const [branchId, setBranchId] = useState<number | ''>('');
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [expectedAt, setExpectedAt] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [pickProductId, setPickProductId] = useState<number | ''>('');
  const [creating, setCreating] = useState(false);

  const [detail, setDetail] = useState<PurchaseOrder | null>(null);
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null);
  const [receiveDraft, setReceiveDraft] = useState<ReceiveDraft>({});
  const [receiveInvoiceNo, setReceiveInvoiceNo] = useState('');
  const [receiveInvoiceDate, setReceiveInvoiceDate] = useState('');
  const [receiveBusy, setReceiveBusy] = useState(false);
  const [reasonAction, setReasonAction] = useState<{ po: PurchaseOrder; action: 'cancel' | 'close' } | null>(null);
  const [invoiceFor, setInvoiceFor] = useState<PurchaseReceipt | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');

  const [adhocOpen, setAdhocOpen] = useState(false);
  const [adhocBranchId, setAdhocBranchId] = useState<number | ''>('');
  const [adhocSupplierId, setAdhocSupplierId] = useState<number | ''>('');
  const [adhocProductId, setAdhocProductId] = useState<number | ''>('');
  const [adhocQty, setAdhocQty] = useState('1');
  const [adhocCost, setAdhocCost] = useState('');
  const [adhocInvoiceNo, setAdhocInvoiceNo] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const physicalProducts = products.filter((p) => p.productKind !== 'SERVICE');
  const productById = new Map(products.map((p) => [p.id, p]));

  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchHqPurchaseOrders(statusFilter ? { status: statusFilter } : undefined),
      fetchHqPurchaseReceipts(),
      fetchHqSuppliers(true),
      fetchHqProducts({ activeOnly: true }),
    ])
      .then(([poRes, rcRes, supRes, prodRes]) => {
        if (cancelled) return;
        setOrders(poRes.data || []);
        setReceipts(rcRes.data || []);
        setSuppliers(supRes.data || []);
        setProducts(prodRes.data || []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入採購資料失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter, reloadKey, toast]);

  async function guard(id: string, fn: () => Promise<void>) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusyId(id);
    try {
      await fn();
    } finally {
      inFlightRef.current = false;
      setBusyId(null);
    }
  }

  function addLine() {
    const p = productById.get(Number(pickProductId));
    if (!p) return;
    if (lines.some((l) => l.productId === p.id)) {
      toast('此商品已在明細中', 'error');
      return;
    }
    setLines((prev) => [...prev, { productId: p.id, qty: '1', unitCost: '', taxType: p.taxType }]);
    setPickProductId('');
  }

  function updateLine(productId: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, ...patch } : l)));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!branchId || !supplierId || !lines.length) return;
    const items = parseLines(lines);
    if (typeof items === 'string') {
      toast(items, 'error');
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setCreating(true);
    try {
      const res = await createHqPurchaseOrder({
        branchId: Number(branchId),
        supplierId: Number(supplierId),
        items,
        expectedAt: expectedAt || null,
        note: note.trim() || null,
      });
      toast(res.message || '採購單已建立', 'success');
      setLines([]);
      setNote('');
      setExpectedAt('');
      load();
    } catch (err) {
      toast(getErrorMessage(err, '建立採購單失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setCreating(false);
    }
  }

  function openReceive(po: PurchaseOrder) {
    const draft: ReceiveDraft = {};
    for (const i of po.items) draft[i.id] = { qty: String(Math.max(0, i.qtyOrdered - i.qtyReceived)), unitCost: '' };
    setReceiveDraft(draft);
    setReceiveInvoiceNo('');
    setReceiveInvoiceDate('');
    setReceiving(po);
  }

  async function handleReceive() {
    if (!receiving || inFlightRef.current) return;
    const items: { poItemId: number; qty: number; unitCost?: number }[] = [];
    for (const i of receiving.items) {
      const d = receiveDraft[i.id];
      const qty = Number(d?.qty || 0);
      if (!qty) continue;
      if (!Number.isInteger(qty) || qty < 0) {
        toast('驗收數量須為非負整數', 'error');
        return;
      }
      const row: { poItemId: number; qty: number; unitCost?: number } = { poItemId: i.id, qty };
      if (d.unitCost.trim() !== '') {
        const c = Number(d.unitCost);
        if (!Number.isFinite(c) || c < 0) {
          toast('實際進價須為非負數字', 'error');
          return;
        }
        row.unitCost = c;
      }
      items.push(row);
    }
    if (!items.length) {
      toast('請至少輸入一項驗收數量', 'error');
      return;
    }
    inFlightRef.current = true;
    setReceiveBusy(true);
    try {
      const res = await createHqPurchaseReceipt({
        purchaseOrderId: receiving.id,
        items,
        ...(receiveInvoiceNo.trim() ? { supplierInvoiceNo: receiveInvoiceNo.trim() } : {}),
        ...(receiveInvoiceDate ? { supplierInvoiceDate: receiveInvoiceDate } : {}),
      });
      toast(res.message || '驗收完成', 'success');
      setReceiving(null);
      load();
    } catch (err) {
      toast(getErrorMessage(err, '驗收失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setReceiveBusy(false);
    }
  }

  async function handleAdhoc() {
    if (!adhocBranchId || !adhocSupplierId || !adhocProductId || inFlightRef.current) return;
    const qty = Number(adhocQty);
    const unitCost = Number(adhocCost);
    if (!Number.isInteger(qty) || qty <= 0 || adhocCost.trim() === '' || !Number.isFinite(unitCost) || unitCost < 0) {
      toast('數量須為正整數、進價須為非負數字', 'error');
      return;
    }
    inFlightRef.current = true;
    setReceiveBusy(true);
    try {
      const res = await createHqPurchaseReceipt({
        branchId: Number(adhocBranchId),
        supplierId: Number(adhocSupplierId),
        items: [{ productId: Number(adhocProductId), qty, unitCost }],
        ...(adhocInvoiceNo.trim() ? { supplierInvoiceNo: adhocInvoiceNo.trim() } : {}),
      });
      toast(res.message || '進貨完成', 'success');
      setAdhocOpen(false);
      setAdhocQty('1');
      setAdhocCost('');
      setAdhocInvoiceNo('');
      load();
    } catch (err) {
      toast(getErrorMessage(err, '無單進貨失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setReceiveBusy(false);
    }
  }

  async function handleInvoiceSave() {
    if (!invoiceFor || !invoiceNo.trim()) return;
    await guard(invoiceFor.id, async () => {
      try {
        const res = await setHqReceiptSupplierInvoice(invoiceFor.id, {
          supplierInvoiceNo: invoiceNo.trim(),
          ...(invoiceDate ? { supplierInvoiceDate: invoiceDate } : {}),
        });
        toast(res.message || '已登錄', 'success');
        setInvoiceFor(null);
        load();
      } catch (err) {
        toast(getErrorMessage(err, '登錄供應商發票失敗'), 'error');
      }
    });
  }

  return (
    <>
      <div className="staff-grid mt-lg">
        <Card title="新增採購單" subtitle="進價為未稅單價；小計、5% 進項稅額與總額由後端計算">
          {activeBranches.length < branches.filter((b) => b.isActive).length && (
            <Alert tone="warning">部分分店尚未綁定營業人，無法採購（至「分店場地」設定）</Alert>
          )}
          <form onSubmit={handleCreate} className="form-stack">
            <div className="bind-row">
              <Field label="進貨分店">
                <Select value={branchId === '' ? '' : String(branchId)} onChange={(e) => setBranchId(Number(e.target.value) || '')} required>
                  <option value="">— 選擇分店 —</option>
                  {activeBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {staffBranchLabel(b)}
                      {b.legalEntity ? ` · ${b.legalEntity.name}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="供應商">
                <Select value={supplierId === '' ? '' : String(supplierId)} onChange={(e) => setSupplierId(Number(e.target.value) || '')} required>
                  <option value="">— 選擇供應商 —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="bind-row">
              <Field label="預計到貨" hint="選填">
                <Input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} />
              </Field>
              <Field label="備註" hint="選填">
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              </Field>
            </div>
            <div className="bind-row">
              <Field label="加入商品">
                <Select value={pickProductId === '' ? '' : String(pickProductId)} onChange={(e) => setPickProductId(Number(e.target.value) || '')}>
                  <option value="">— 選擇實體商品 —</option>
                  {physicalProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="button" variant="secondary" onClick={addLine} disabled={!pickProductId}>
                加入明細
              </Button>
            </div>
            {lines.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>商品</th>
                      <th>數量</th>
                      <th>未稅進價</th>
                      <th>課稅別</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const p = productById.get(l.productId);
                      return (
                        <tr key={l.productId}>
                          <td>
                            <span className="mono">{p?.sku}</span> {p?.name}
                          </td>
                          <td style={{ minWidth: 80 }}>
                            <Input type="number" min={1} value={l.qty} onChange={(e) => updateLine(l.productId, { qty: e.target.value })} aria-label="數量" />
                          </td>
                          <td style={{ minWidth: 100 }}>
                            <Input type="number" min={0} step="0.01" value={l.unitCost} onChange={(e) => updateLine(l.productId, { unitCost: e.target.value })} aria-label="未稅進價" required />
                          </td>
                          <td>
                            <Select value={l.taxType} onChange={(e) => updateLine(l.productId, { taxType: e.target.value as TaxType })} aria-label="課稅別">
                              <option value="TAXABLE">應稅</option>
                              <option value="ZERO">零稅率</option>
                              <option value="FREE">免稅</option>
                            </Select>
                          </td>
                          <td>
                            <Button size="sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((x) => x.productId !== l.productId))}>
                              移除
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <Button type="submit" loading={creating} disabled={!branchId || !supplierId || !lines.length}>
              建立採購單（草稿）
            </Button>
          </form>
        </Card>

        <Card title="無單進貨" subtitle="臨時採購（無採購單）由總部登錄；門市僅能依採購單驗收">
          <Button variant="secondary" onClick={() => setAdhocOpen(true)}>
            登錄無單進貨
          </Button>
        </Card>
      </div>

      <Card title="採購單" className="mt-lg" subtitle={`共 ${orders.length} 張`}>
        <div className="list-toolbar">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="狀態">
            <option value="">全部狀態</option>
            {Object.entries(PO_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="table-wrap mt-md">
          <table className="data-table">
            <thead>
              <tr>
                <th>單號</th>
                <th>分店／營業人</th>
                <th>供應商</th>
                <th>未稅</th>
                <th>稅額</th>
                <th>總額</th>
                <th>狀態</th>
                <th>建立</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-muted text-center">
                    尚無採購單
                  </td>
                </tr>
              ) : (
                orders.map((po) => {
                  const st = PO_STATUS[po.status] || { label: po.status, tone: 'neutral' as const };
                  return (
                    <tr key={po.id}>
                      <td className="mono">
                        <Button size="sm" variant="ghost" onClick={() => setDetail(po)}>
                          {po.id}
                        </Button>
                      </td>
                      <td>
                        {po.branch?.name}
                        <div className="text-sm text-muted">{po.legalEntity?.name}</div>
                      </td>
                      <td>{po.supplier?.name}</td>
                      <td>{money(po.subtotal)}</td>
                      <td>{money(po.taxAmount)}</td>
                      <td>{money(po.total)}</td>
                      <td>
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </td>
                      <td>{fmtDate(po.createdAt)}</td>
                      <td>
                        <div className="btn-row">
                          {po.status === 'DRAFT' && (
                            <Button
                              size="sm"
                              loading={busyId === po.id}
                              onClick={() =>
                                void guard(po.id, async () => {
                                  try {
                                    const res = await transitionHqPurchaseOrder(po.id, 'order');
                                    toast(res.message || '已送出採購', 'success');
                                    load();
                                  } catch (err) {
                                    toast(getErrorMessage(err, '送出失敗'), 'error');
                                  }
                                })
                              }
                            >
                              送出採購
                            </Button>
                          )}
                          {(po.status === 'ORDERED' || po.status === 'PARTIAL') && (
                            <Button size="sm" variant="secondary" onClick={() => openReceive(po)}>
                              驗收
                            </Button>
                          )}
                          {po.status === 'PARTIAL' && (
                            <Button size="sm" variant="ghost" onClick={() => setReasonAction({ po, action: 'close' })}>
                              短交結案
                            </Button>
                          )}
                          {(po.status === 'DRAFT' || po.status === 'ORDERED') && (
                            <Button size="sm" variant="ghost" onClick={() => setReasonAction({ po, action: 'cancel' })}>
                              取消
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="驗收單" className="mt-lg" subtitle="每張驗收單自動立一筆應付帳款">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>驗收單</th>
                <th>採購單</th>
                <th>分店／營業人</th>
                <th>供應商</th>
                <th>總額</th>
                <th>供應商發票</th>
                <th>應付</th>
                <th>驗收時間</th>
              </tr>
            </thead>
            <tbody>
              {receipts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-muted text-center">
                    尚無驗收單
                  </td>
                </tr>
              ) : (
                receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td className="mono">{r.purchaseOrderId || <span className="text-muted">無單</span>}</td>
                    <td>
                      {r.branch?.name}
                      <div className="text-sm text-muted">{r.legalEntity?.name}</div>
                    </td>
                    <td>{r.supplier?.name}</td>
                    <td>{money(r.total)}</td>
                    <td>
                      {r.supplierInvoiceNo ? (
                        <span className="mono">{r.supplierInvoiceNo}</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setInvoiceFor(r);
                            setInvoiceNo('');
                            setInvoiceDate('');
                          }}
                        >
                          補登
                        </Button>
                      )}
                    </td>
                    <td className="mono">{r.payable?.id || '—'}</td>
                    <td>{fmtDateTime(r.receivedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={detail !== null} title={`採購單 ${detail?.id || ''}`} onClose={() => setDetail(null)}>
        {detail && (
          <div className="form-stack">
            <p className="text-sm text-muted">
              {detail.branch?.name} · {detail.legalEntity?.name} · {detail.supplier?.name}
              {detail.expectedAt ? ` · 預計 ${fmtDate(detail.expectedAt)}` : ''}
              {detail.cancelReason ? ` · 原因：${detail.cancelReason}` : ''}
            </p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>商品</th>
                    <th>訂購</th>
                    <th>已收</th>
                    <th>未稅進價</th>
                    <th>課稅別</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <span className="mono">{i.product?.sku}</span> {i.product?.name}
                      </td>
                      <td>{i.qtyOrdered}</td>
                      <td>{i.qtyReceived}</td>
                      <td>{money(i.unitCost)}</td>
                      <td>{TAX_TYPE_LABEL[i.taxType] || i.taxType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              未稅 {money(detail.subtotal)} · 稅額 {money(detail.taxAmount)} · <strong>總額 {money(detail.total)}</strong>
            </p>
            {detail.note && <p className="text-sm">備註：{detail.note}</p>}
          </div>
        )}
      </Modal>

      <Modal
        open={receiving !== null}
        title={`驗收 ${receiving?.id || ''}`}
        onClose={() => setReceiving(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReceiving(null)}>
              取消
            </Button>
            <Button loading={receiveBusy} onClick={() => void handleReceive()}>
              確認驗收入庫
            </Button>
          </>
        }
      >
        {receiving && (
          <div className="form-stack">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>商品</th>
                    <th>未收</th>
                    <th>本次實收</th>
                    <th>實際進價</th>
                  </tr>
                </thead>
                <tbody>
                  {receiving.items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.product?.name}</td>
                      <td>{i.qtyOrdered - i.qtyReceived}</td>
                      <td style={{ minWidth: 80 }}>
                        <Input
                          type="number"
                          min={0}
                          value={receiveDraft[i.id]?.qty ?? ''}
                          onChange={(e) => setReceiveDraft((prev) => ({ ...prev, [i.id]: { ...prev[i.id], qty: e.target.value } }))}
                          aria-label="本次實收"
                        />
                      </td>
                      <td style={{ minWidth: 100 }}>
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          placeholder={String(i.unitCost)}
                          value={receiveDraft[i.id]?.unitCost ?? ''}
                          onChange={(e) => setReceiveDraft((prev) => ({ ...prev, [i.id]: { ...prev[i.id], unitCost: e.target.value } }))}
                          aria-label="實際進價"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-muted">實際進價留空＝採購單進價；與採購單不同時以實際值計入移動平均成本與應付。</p>
            <div className="bind-row">
              <Field label="供應商發票號碼" hint="選填">
                <Input value={receiveInvoiceNo} onChange={(e) => setReceiveInvoiceNo(e.target.value.toUpperCase())} maxLength={20} />
              </Field>
              <Field label="發票日期" hint="選填">
                <Input type="date" value={receiveInvoiceDate} onChange={(e) => setReceiveInvoiceDate(e.target.value)} />
              </Field>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={adhocOpen}
        title="無單進貨"
        onClose={() => setAdhocOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdhocOpen(false)}>
              取消
            </Button>
            <Button loading={receiveBusy} onClick={() => void handleAdhoc()}>
              確認入庫
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleAdhoc();
          }}
          className="form-stack"
        >
          <Field label="進貨分店">
            <Select value={adhocBranchId === '' ? '' : String(adhocBranchId)} onChange={(e) => setAdhocBranchId(Number(e.target.value) || '')}>
              <option value="">— 選擇分店 —</option>
              {activeBranches.map((b) => (
                <option key={b.id} value={b.id}>
                  {staffBranchLabel(b)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="供應商">
            <Select value={adhocSupplierId === '' ? '' : String(adhocSupplierId)} onChange={(e) => setAdhocSupplierId(Number(e.target.value) || '')}>
              <option value="">— 選擇供應商 —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="商品">
            <Select value={adhocProductId === '' ? '' : String(adhocProductId)} onChange={(e) => setAdhocProductId(Number(e.target.value) || '')}>
              <option value="">— 選擇實體商品 —</option>
              {physicalProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="bind-row">
            <Field label="數量">
              <Input type="number" min={1} value={adhocQty} onChange={(e) => setAdhocQty(e.target.value)} />
            </Field>
            <Field label="未稅進價">
              <Input type="number" min={0} step="0.01" value={adhocCost} onChange={(e) => setAdhocCost(e.target.value)} />
            </Field>
          </div>
          <Field label="供應商發票號碼" hint="選填">
            <Input value={adhocInvoiceNo} onChange={(e) => setAdhocInvoiceNo(e.target.value.toUpperCase())} maxLength={20} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={invoiceFor !== null}
        title={`補登供應商發票 · ${invoiceFor?.id || ''}`}
        onClose={() => setInvoiceFor(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setInvoiceFor(null)}>
              取消
            </Button>
            <Button loading={busyId === invoiceFor?.id} disabled={!invoiceNo.trim()} onClick={() => void handleInvoiceSave()}>
              儲存
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <Field label="發票號碼">
            <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value.toUpperCase())} maxLength={20} />
          </Field>
          <Field label="發票日期" hint="選填">
            <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
        </div>
      </Modal>

      {reasonAction && (
        <ReasonModal
          title={reasonAction.action === 'cancel' ? `取消採購單 ${reasonAction.po.id}` : `短交結案 ${reasonAction.po.id}`}
          confirmLabel={reasonAction.action === 'cancel' ? '確認取消' : '確認結案'}
          danger={reasonAction.action === 'cancel'}
          onClose={() => setReasonAction(null)}
          onSubmit={async (reason) => {
            try {
              const res = await transitionHqPurchaseOrder(reasonAction.po.id, reasonAction.action, reason);
              toast(res.message || '已更新', 'success');
              load();
              return true;
            } catch (err) {
              toast(getErrorMessage(err, '操作失敗'), 'error');
              return false;
            }
          }}
        />
      )}
    </>
  );
}
