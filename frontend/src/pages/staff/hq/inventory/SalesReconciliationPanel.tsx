import { type FormEvent, useRef, useState } from 'react';
import { Button, Card, Field, Input, Select, StatCard } from '../../../../components/ui';
import { useToast } from '../../../../contexts/ToastContext';
import { fetchSalesReconciliation, getErrorMessage } from '../../../../lib/api';
import { staffBranchLabel } from '../../../../lib/branchLabel';
import { money } from '../../../../lib/inventoryLabels';
import { downloadReconCsv, downloadReconXlsx, RECON_DATASETS, type ReconDatasetKey } from '../../../../lib/reconExport';
import type { Branch, ReconCell, ReconColumn, SalesReconciliation } from '../../../../types/api';

const PREVIEW_ROWS = 100;

function twToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 近 6 個發票期別（雙月）供快速帶入日期區間 */
function recentInvoicePeriods() {
  const today = twToday();
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  if (m % 2 === 0) m -= 1;
  const out: Array<{ key: string; label: string; from: string; to: string }> = [];
  for (let i = 0; i < 6; i += 1) {
    const end = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
    const mm = String(m).padStart(2, '0');
    out.push({ key: `${y}${mm}`, label: `${y - 1911}年 ${mm}-${String(m + 1).padStart(2, '0')}月`, from: `${y}-${mm}-01`, to: end });
    m -= 2;
    if (m < 1) {
      m += 12;
      y -= 1;
    }
  }
  return out;
}

function cellText(col: ReconColumn, v: ReconCell) {
  if (v === null || v === undefined || v === '') return '—';
  if (col.type === 'money') return money(Number(v));
  return String(v);
}

function rowKey(r: Record<string, ReconCell>, i: number) {
  return String(r.rowKey ?? r.lineId ?? r.einvoiceId ?? r.allowanceId ?? i);
}

/** 門市發票對帳（會計師沖帳／申報）：金額、稅額分攤與彙總皆由後端計算，本頁只預覽與匯出 Excel／CSV */
export default function SalesReconciliationPanel({ branches }: { branches: Branch[] }) {
  const { toast } = useToast();
  const today = twToday();
  const [periods] = useState(recentInvoicePeriods);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState<number | ''>('');
  const [includeCancelled, setIncludeCancelled] = useState(true);
  const [data, setData] = useState<SalesReconciliation | null>(null);
  const [view, setView] = useState<ReconDatasetKey>('invoices');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportInFlightRef = useRef(false);

  async function load(e?: FormEvent) {
    e?.preventDefault();
    if (!from || !to) {
      toast('請選擇日期區間', 'error');
      return;
    }
    setLoading(true);
    try {
      const res = await fetchSalesReconciliation({
        from,
        to,
        ...(branchId ? { branchId: Number(branchId) } : {}),
        includeCancelled,
      });
      setData(res.data ?? null);
    } catch (err) {
      setData(null);
      toast(getErrorMessage(err, '載入發票對帳失敗'), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function exportXlsx() {
    if (!data || exportInFlightRef.current) return;
    exportInFlightRef.current = true;
    setExporting(true);
    try {
      await downloadReconXlsx(data);
    } catch (err) {
      toast(getErrorMessage(err, 'Excel 產生失敗'), 'error');
    } finally {
      exportInFlightRef.current = false;
      setExporting(false);
    }
  }

  const s = data?.summary;
  const inv = s?.invoices;
  const ds = RECON_DATASETS.find((d) => d.key === view) || RECON_DATASETS[0];
  const columns = data ? ds.columns(data) : [];
  const rows = data ? ds.rows(data) : [];
  const hasAny = Boolean(data && (data.invoices.length || data.rows.length || data.allowances.length));

  return (
    <Card
      title="門市發票對帳"
      className="mt-lg"
      subtitle="門市所有發票（商品、會籍／儲值、月卡、私教、團課）依開立日期彙總，含作廢、折讓與待補開；另附商品銷貨明細。匯出 Excel／CSV 交付會計師。"
    >
      <form className="list-toolbar" onSubmit={(e) => void load(e)}>
        <Field label="發票期別">
          <Select
            value={periods.find((p) => p.from === from && p.to === to)?.key || ''}
            onChange={(e) => {
              const p = periods.find((x) => x.key === e.target.value);
              if (p) {
                setFrom(p.from);
                setTo(p.to);
              }
            }}
          >
            <option value="">自訂區間</option>
            {periods.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="起日">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to || undefined} required />
        </Field>
        <Field label="迄日">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from || undefined} required />
        </Field>
        <Field label="門市">
          <Select value={branchId === '' ? '' : String(branchId)} onChange={(e) => setBranchId(Number(e.target.value) || '')}>
            <option value="">全部門市</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {staffBranchLabel(b)}
              </option>
            ))}
          </Select>
        </Field>
        <label className="checkbox-item">
          <input type="checkbox" checked={includeCancelled} onChange={(e) => setIncludeCancelled(e.target.checked)} />
          商品銷貨列示已取消單據
        </label>
        <Button type="submit" size="sm" loading={loading}>
          查詢
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={!hasAny} loading={exporting} onClick={() => void exportXlsx()}>
          匯出 Excel（全部分頁）
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={!data || !rows.length} onClick={() => data && downloadReconCsv(data, view)}>
          匯出 CSV（{ds.label}）
        </Button>
      </form>

      {data && s && inv ? (
        <>
          <p className="text-sm text-muted mt-md">
            {data.legalEntities.map((e) => `${e.name}（統編 ${e.ubn}）`).join('、') || '—'} · {data.branch?.name || '全部門市'} · {data.range.from} ～{' '}
            {data.range.to}
          </p>
          <div className="bento-grid bento-grid--stats" style={{ margin: '0.75rem 0' }}>
            <StatCard label={`有效發票 ${inv.effective.count} 張｜銷售額`} value={money(inv.effective.salesAmount)} />
            <StatCard label="稅額" value={money(inv.effective.taxAmount)} />
            <StatCard label={`折讓 ${inv.allowance.count} 張`} value={money(inv.allowance.totalAmount)} />
            <StatCard label="發票淨額（含稅）" value={money(inv.net.totalAmount)} />
            <StatCard label={`本期作廢 ${inv.voided.count} 張`} value={money(inv.voided.totalAmount)} />
            <StatCard label={`待補開 ${inv.pending.count} 張`} value={money(inv.pending.totalAmount)} tone={inv.pending.count ? 'cash' : 'default'} />
          </div>
          {inv.bySource.length ? (
            <p className="text-sm text-muted">
              依來源：{inv.bySource.map((src) => `${src.label} ${src.count} 張 ${money(src.totalAmount)}`).join(' · ')}
            </p>
          ) : null}
          {inv.pending.count || s.uninvoiced.count ? (
            <p className="text-sm">⚠ 有尚未取得發票號碼之交易（待補開），請至「電子發票」補開後再交付會計師。</p>
          ) : null}
          {s.orderAmountMismatch ? <p className="text-sm">⚠ {s.orderAmountMismatch} 張銷貨單金額與明細合計不符，請洽系統管理員。</p> : null}

          <nav className="hq-tabs mt-md" role="tablist">
            {RECON_DATASETS.map((d) => (
              <button
                key={d.key}
                type="button"
                role="tab"
                aria-selected={view === d.key}
                className={`hq-tabs__btn ${view === d.key ? 'is-active' : ''}`}
                onClick={() => setView(d.key)}
              >
                {d.label}（{d.rows(data).length}）
              </button>
            ))}
          </nav>

          <div className="table-wrap mt-md">
            <table className="data-table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length} className="text-muted text-center">
                      此區間沒有資料
                    </td>
                  </tr>
                ) : (
                  rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                    <tr key={rowKey(r, i)} className={ds.tone?.(r) ? 'text-muted' : undefined}>
                      {columns.map((c) => (
                        <td key={c.key} className={c.type === 'text' ? (/Id|Number|No$|sku/.test(c.key) ? 'mono text-sm' : 'text-sm') : undefined}>
                          {cellText(c, r[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {rows.length > PREVIEW_ROWS ? (
            <p className="text-sm text-muted mt-md">
              預覽前 {PREVIEW_ROWS} 筆，共 {rows.length} 筆；完整資料請匯出。
            </p>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
