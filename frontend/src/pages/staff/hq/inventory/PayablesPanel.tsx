import { type FormEvent, useEffect, useRef, useState } from 'react';
import ReasonModal from '../../../../components/staff/ReasonModal';
import { Badge, Button, Card, Field, Input, Select } from '../../../../components/ui';
import { useToast } from '../../../../contexts/ToastContext';
import {
  createHqSupplierPayment,
  fetchHqLegalEntities,
  fetchHqPayableAging,
  fetchHqPayables,
  fetchHqSupplierPayments,
  fetchHqSuppliers,
  getErrorMessage,
  voidHqPayable,
} from '../../../../lib/api';
import { fmtDate, money, PAYABLE_STATUS, PAYMENT_METHOD_LABEL } from '../../../../lib/inventoryLabels';
import type {
  LegalEntity,
  PayableAgingRow,
  Supplier,
  SupplierPayable,
  SupplierPayment,
  SupplierPaymentMethod,
} from '../../../../types/api';

/** 應付帳款（依營業人＋供應商）、帳齡、付款沖銷；餘額與帳齡由後端計算 */
export default function PayablesPanel() {
  const { toast } = useToast();
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [payables, setPayables] = useState<SupplierPayable[]>([]);
  const [aging, setAging] = useState<PayableAgingRow[]>([]);
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [entityFilter, setEntityFilter] = useState<number | ''>('');
  const [statusFilter, setStatusFilter] = useState('UNPAID');

  const [payEntityId, setPayEntityId] = useState<number | ''>('');
  const [paySupplierId, setPaySupplierId] = useState<number | ''>('');
  const [openForPay, setOpenForPay] = useState<SupplierPayable[]>([]);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<SupplierPaymentMethod>('TRANSFER');
  const [paidAt, setPaidAt] = useState('');
  const [reference, setReference] = useState('');
  const [paying, setPaying] = useState(false);
  const payInFlightRef = useRef(false);
  const [voiding, setVoiding] = useState<SupplierPayable | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    const legalEntityId = entityFilter === '' ? undefined : Number(entityFilter);
    let cancelled = false;
    Promise.all([
      fetchHqLegalEntities(),
      fetchHqSuppliers(),
      fetchHqPayables({ ...(statusFilter ? { status: statusFilter } : {}), ...(legalEntityId ? { legalEntityId } : {}) }),
      fetchHqPayableAging(legalEntityId),
      fetchHqSupplierPayments(legalEntityId ? { legalEntityId } : undefined),
    ])
      .then(([entRes, supRes, payRes, agingRes, pmRes]) => {
        if (cancelled) return;
        setEntities(entRes.data || []);
        setSuppliers(supRes.data || []);
        setPayables(payRes.data || []);
        setAging(agingRes.data || []);
        setPayments(pmRes.data || []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入應付帳款失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [entityFilter, statusFilter, reloadKey, toast]);

  useEffect(() => {
    if (!payEntityId || !paySupplierId) return;
    let cancelled = false;
    fetchHqPayables({ status: 'UNPAID', legalEntityId: Number(payEntityId), supplierId: Number(paySupplierId) })
      .then((res) => {
        if (cancelled) return;
        setOpenForPay(res.data || []);
        setAlloc({});
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入未付帳款失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [payEntityId, paySupplierId, reloadKey, toast]);

  const payablesForPay = payEntityId && paySupplierId ? openForPay : [];

  async function handlePay(e: FormEvent) {
    e.preventDefault();
    if (!payEntityId || !paySupplierId || payInFlightRef.current) return;
    const amount = Number(payAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      toast('付款金額須為正整數（元）', 'error');
      return;
    }
    const allocations: { payableId: string; amount: number }[] = [];
    for (const [payableId, raw] of Object.entries(alloc)) {
      if (!raw.trim()) continue;
      const a = Number(raw);
      if (!Number.isInteger(a) || a === 0) {
        toast('沖銷金額須為非零整數', 'error');
        return;
      }
      allocations.push({ payableId, amount: a });
    }
    if (!allocations.length) {
      toast('請至少沖銷一筆應付', 'error');
      return;
    }
    payInFlightRef.current = true;
    setPaying(true);
    try {
      const res = await createHqSupplierPayment({
        legalEntityId: Number(payEntityId),
        supplierId: Number(paySupplierId),
        amount,
        method: payMethod,
        ...(paidAt ? { paidAt } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        allocations,
      });
      toast(res.message || '付款已登錄', 'success');
      setPayAmount('');
      setReference('');
      reload();
    } catch (err) {
      toast(getErrorMessage(err, '登錄付款失敗'), 'error');
    } finally {
      payInFlightRef.current = false;
      setPaying(false);
    }
  }

  return (
    <>
      <div className="list-toolbar mt-lg">
        <Select value={entityFilter === '' ? '' : String(entityFilter)} onChange={(e) => setEntityFilter(Number(e.target.value) || '')} aria-label="營業人">
          <option value="">全部營業人</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}（{e.ubn}）
            </option>
          ))}
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="狀態">
          <option value="UNPAID">未結清（未付＋部分付）</option>
          <option value="">全部</option>
          {Object.entries(PAYABLE_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>

      <Card title="應付帳款" className="mt-md" subtitle={`共 ${payables.length} 筆 · 驗收即立帳，到期日依供應商付款條件`}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>應付單</th>
                <th>營業人</th>
                <th>供應商</th>
                <th>供應商發票</th>
                <th>應付</th>
                <th>已付</th>
                <th>未付</th>
                <th>到期日</th>
                <th>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {payables.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-muted text-center">
                    沒有符合的應付帳款
                  </td>
                </tr>
              ) : (
                payables.map((p) => {
                  const st = PAYABLE_STATUS[p.status] || { label: p.status, tone: 'neutral' as const };
                  return (
                    <tr key={p.id}>
                      <td className="mono">
                        {p.id}
                        {p.receiptId ? <div className="text-sm text-muted">{p.receiptId}</div> : null}
                      </td>
                      <td>{p.legalEntity?.name}</td>
                      <td>{p.supplier?.name}</td>
                      <td className="mono">{p.supplierInvoiceNo || '—'}</td>
                      <td>{money(p.amount)}</td>
                      <td>{money(p.paidAmount)}</td>
                      <td>{money(p.openAmount)}</td>
                      <td>
                        {fmtDate(p.dueDate)}
                        {p.overdueDays > 0 ? (
                          <div>
                            <Badge tone="danger">逾期 {p.overdueDays} 天</Badge>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </td>
                      <td>
                        {p.status === 'OPEN' && (
                          <Button size="sm" variant="ghost" onClick={() => setVoiding(p)}>
                            作廢
                          </Button>
                        )}
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
        <Card title="登錄付款" subtitle="同一營業人＋供應商；沖銷合計須等於付款金額（後端驗證）">
          <form onSubmit={handlePay} className="form-stack">
            <div className="bind-row">
              <Field label="付款營業人">
                <Select value={payEntityId === '' ? '' : String(payEntityId)} onChange={(e) => setPayEntityId(Number(e.target.value) || '')}>
                  <option value="">— 選擇營業人 —</option>
                  {entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="供應商">
                <Select value={paySupplierId === '' ? '' : String(paySupplierId)} onChange={(e) => setPaySupplierId(Number(e.target.value) || '')}>
                  <option value="">— 選擇供應商 —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {payEntityId && paySupplierId ? (
              payablesForPay.length === 0 ? (
                <p className="text-muted text-sm">此營業人與供應商之間沒有未結清應付</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>應付單</th>
                        <th>到期</th>
                        <th>未付</th>
                        <th>本次沖銷</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payablesForPay.map((p) => (
                        <tr key={p.id}>
                          <td className="mono">{p.id}</td>
                          <td>{fmtDate(p.dueDate)}</td>
                          <td>{money(p.openAmount)}</td>
                          <td style={{ minWidth: 110 }}>
                            <Input
                              type="number"
                              step={1}
                              value={alloc[p.id] ?? ''}
                              onChange={(e) => setAlloc((prev) => ({ ...prev, [p.id]: e.target.value }))}
                              aria-label={`${p.id} 本次沖銷`}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}
            <div className="bind-row">
              <Field label="付款金額">
                <Input type="number" min={1} step={1} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
              </Field>
              <Field label="付款方式">
                <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value as SupplierPaymentMethod)}>
                  {Object.entries(PAYMENT_METHOD_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="bind-row">
              <Field label="付款日" hint="選填；預設今天">
                <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
              </Field>
              <Field label="參考號" hint="匯款末五碼／支票號">
                <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
              </Field>
            </div>
            <Button type="submit" loading={paying} disabled={!payablesForPay.length}>
              確認付款
            </Button>
          </form>
        </Card>

        <Card title="應付帳齡" subtitle="依到期日計算（後端）">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>營業人／供應商</th>
                  <th>未到期</th>
                  <th>1–30</th>
                  <th>31–60</th>
                  <th>61–90</th>
                  <th>&gt;90</th>
                  <th>合計</th>
                </tr>
              </thead>
              <tbody>
                {aging.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-muted text-center">
                      無未結清應付
                    </td>
                  </tr>
                ) : (
                  aging.map((a) => (
                    <tr key={`${a.legalEntity.id}-${a.supplier.id}`}>
                      <td>
                        {a.supplier.name}
                        <div className="text-sm text-muted">{a.legalEntity.name}</div>
                      </td>
                      <td>{money(a.notDue)}</td>
                      <td>{money(a.d30)}</td>
                      <td>{money(a.d60)}</td>
                      <td>{money(a.d90)}</td>
                      <td>{money(a.over90)}</td>
                      <td>
                        <strong>{money(a.total)}</strong>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card title="付款紀錄" className="mt-lg">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>付款單</th>
                <th>營業人</th>
                <th>供應商</th>
                <th>金額</th>
                <th>方式</th>
                <th>付款日</th>
                <th>沖銷</th>
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-muted text-center">
                    尚無付款紀錄
                  </td>
                </tr>
              ) : (
                payments.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">
                      {p.id}
                      {p.reference ? <div className="text-sm text-muted">{p.reference}</div> : null}
                    </td>
                    <td>{p.legalEntity?.name}</td>
                    <td>{p.supplier?.name}</td>
                    <td>{money(p.amount)}</td>
                    <td>{PAYMENT_METHOD_LABEL[p.method] || p.method}</td>
                    <td>{fmtDate(p.paidAt)}</td>
                    <td className="text-sm">{p.allocations.map((a) => `${a.payableId} ${money(a.amount)}`).join('、')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {voiding && (
        <ReasonModal
          title={`作廢應付 ${voiding.id}`}
          confirmLabel="確認作廢"
          danger
          onClose={() => setVoiding(null)}
          onSubmit={async (reason) => {
            try {
              const res = await voidHqPayable(voiding.id, reason);
              toast(res.message || '已作廢', 'success');
              reload();
              return true;
            } catch (err) {
              toast(getErrorMessage(err, '作廢失敗'), 'error');
              return false;
            }
          }}
        />
      )}
    </>
  );
}
