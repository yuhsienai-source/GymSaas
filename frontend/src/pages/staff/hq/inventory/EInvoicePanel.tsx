import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Input, Select } from '../../../../components/ui';
import { useToast } from '../../../../contexts/ToastContext';
import { fetchHqEInvoices, fetchHqLegalEntities, getErrorMessage, retryHqEInvoice } from '../../../../lib/api';
import { staffBranchLabel } from '../../../../lib/branchLabel';
import { CARRIER_LABEL, EINVOICE_STATUS, fmtDateTime, money } from '../../../../lib/inventoryLabels';
import type { Branch, EInvoiceRow, LegalEntity } from '../../../../types/api';
import EInvoiceLogModal from './EInvoiceLogModal';

function buyerLabel(r: EInvoiceRow) {
  if (r.category === 'B2B') return `統編 ${r.buyerUbn || '—'}${r.buyerName ? ` ${r.buyerName}` : ''}`;
  if (r.carrierType) return CARRIER_LABEL[r.carrierType] || `載具 ${r.carrierType}`;
  if (r.printFlag === 'Y') return '紙本';
  return '捐贈／其他';
}

/** 跨營業人電子發票監控：失敗可手動補開（已收款不沖回） */
export default function EInvoicePanel({ branches }: { branches: Branch[] }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<EInvoiceRow[]>([]);
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [legalEntityId, setLegalEntityId] = useState<number | ''>('');
  const [branchId, setBranchId] = useState<number | ''>('');
  const [category, setCategory] = useState<'' | 'B2B' | 'B2C'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [logTarget, setLogTarget] = useState<{ id: string | null; title: string } | null>(null);
  const inFlightRef = useRef(false);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchHqEInvoices({
        ...(query ? { q: query } : {}),
        ...(status ? { status } : {}),
        ...(legalEntityId ? { legalEntityId: Number(legalEntityId) } : {}),
        ...(branchId ? { branchId: Number(branchId) } : {}),
        ...(category ? { category } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }),
      fetchHqLegalEntities(),
    ])
      .then(([invRes, entRes]) => {
        if (cancelled) return;
        setRows(invRes.data || []);
        setEntities(entRes.data || []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入電子發票失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [query, status, legalEntityId, branchId, category, from, to, reloadKey, toast]);

  async function retry(id: string) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusyId(id);
    try {
      const res = await retryHqEInvoice(id);
      toast(res.message || '已重新送出開立', res.data?.status === 'SUCCESS' ? 'success' : 'info');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '補開失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setBusyId(null);
    }
  }

  const failedCount = rows.filter((r) => r.einvoiceStatus === 'FAILED').length;

  return (
    <Card title="電子發票" className="mt-lg" subtitle={`顯示 ${rows.length} 筆（最多 200）${failedCount ? ` · 失敗 ${failedCount} 筆待補開` : ''}`}>
      <form
        className="list-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="發票號／單號／統編" aria-label="搜尋" style={{ maxWidth: 200 }} />
        <Button type="submit" variant="secondary" size="sm">
          搜尋
        </Button>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="狀態">
          <option value="">全部狀態</option>
          {Object.entries(EINVOICE_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        <Select value={legalEntityId === '' ? '' : String(legalEntityId)} onChange={(e) => setLegalEntityId(Number(e.target.value) || '')} aria-label="營業人">
          <option value="">全部營業人</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        <Select value={branchId === '' ? '' : String(branchId)} onChange={(e) => setBranchId(Number(e.target.value) || '')} aria-label="分店">
          <option value="">全部分店</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {staffBranchLabel(b)}
            </option>
          ))}
        </Select>
        <Select value={category} onChange={(e) => setCategory(e.target.value as '' | 'B2B' | 'B2C')} aria-label="類別">
          <option value="">B2B＋B2C</option>
          <option value="B2B">B2B（三聯式）</option>
          <option value="B2C">B2C（二聯式）</option>
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="起日" style={{ maxWidth: 160 }} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="迄日" style={{ maxWidth: 160 }} />
        <Button type="button" variant="secondary" size="sm" onClick={() => setLogTarget({ id: null, title: 'ezPay 錯誤紀錄（最近 200 筆）' })}>
          ezPay 錯誤紀錄
        </Button>
      </form>
      <div className="table-wrap mt-md">
        <table className="data-table">
          <thead>
            <tr>
              <th>發票號碼</th>
              <th>營業人</th>
              <th>來源單據</th>
              <th>買受人</th>
              <th>銷售額</th>
              <th>稅額</th>
              <th>總計</th>
              <th>狀態</th>
              <th>時間</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-muted text-center">
                  沒有符合的發票
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const st = EINVOICE_STATUS[r.einvoiceStatus] || { label: r.einvoiceStatus, tone: 'neutral' as const };
                const retryable = r.einvoiceStatus === 'FAILED' || r.einvoiceStatus === 'PENDING';
                return (
                  <tr key={r.id}>
                    <td className="mono">
                      {r.invoiceNumber || '—'}
                      <div className="text-sm text-muted">{r.category}</div>
                    </td>
                    <td>{r.legalEntity?.name || '—'}</td>
                    <td className="mono">
                      {r.refId}
                      {r.leg ? <div className="text-sm text-muted">{r.leg}</div> : null}
                    </td>
                    <td className="text-sm">{buyerLabel(r)}</td>
                    <td>{money(r.salesAmount)}</td>
                    <td>{money(r.taxAmount)}</td>
                    <td>
                      {money(r.amount)}
                      {r.allowanceTotal > 0 ? <div className="text-sm text-muted">折讓 {money(r.allowanceTotal)}</div> : null}
                    </td>
                    <td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {r.lastError && r.einvoiceStatus === 'FAILED' ? (
                        <div className="text-sm text-muted" style={{ maxWidth: 220 }}>
                          {r.lastError}
                        </div>
                      ) : null}
                      {r.voidReason ? <div className="text-sm text-muted">{r.voidReason}</div> : null}
                    </td>
                    <td className="text-sm">{fmtDateTime(r.issuedAt || r.createdAt)}</td>
                    <td>
                      <div className="btn-row">
                        {retryable && (
                          <Button size="sm" loading={busyId === r.id} onClick={() => void retry(r.id)}>
                            補開
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setLogTarget({ id: r.id, title: `ezPay 呼叫紀錄 · ${r.invoiceNumber || r.merchantOrderNo}` })}
                        >
                          紀錄
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {logTarget ? (
        <EInvoiceLogModal
          key={logTarget.id ?? 'all'}
          einvoiceId={logTarget.id}
          title={logTarget.title}
          onClose={() => setLogTarget(null)}
        />
      ) : null}
    </Card>
  );
}
