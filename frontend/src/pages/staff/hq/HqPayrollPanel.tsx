import { useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import { fetchHqPayrollExport, getErrorMessage } from '../../../lib/api';
import { downloadCsv } from '../../../lib/csv';
import { shortDateTime } from '../../../lib/hrFormat';
import { taipeiToday } from '../../../lib/laborLaw';
import type { PayrollExport } from '../../../types/api';
import type { HqDataProps } from './types';

type Props = Pick<HqDataProps, 'branches'>;

/** 預覽表只列核薪常用欄；完整欄位見 CSV */
const PREVIEW_KEYS = [
  'name',
  'branch',
  'employmentType',
  'scheduledHours',
  'workedHours',
  'lateCount',
  'earlyCount',
  'absentShifts',
  'missedPunchOut',
  'unscheduledHours',
  'holidayWorkedHours',
  'restDayWorkedHours',
  'leaveHours',
];

function previousMonth() {
  const [y, m] = taipeiToday().split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** 工資核算匯出：月度考勤標記／總數＋請假時數（後端彙整事實、不計薪資金額），CSV 由前端組檔 */
export default function HqPayrollPanel({ branches }: Props) {
  const { toast } = useToast();
  const [month, setMonth] = useState(previousMonth);
  const [branchId, setBranchId] = useState<number | ''>('');
  const [data, setData] = useState<PayrollExport | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  const maxMonth = taipeiToday().slice(0, 7);
  const branchCode = useMemo(() => new Map(branches.map((b) => [b.id, b.code ?? String(b.id)])), [branches]);

  async function generate() {
    if (inFlightRef.current || !month) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await fetchHqPayrollExport({ month, branchId: branchId || undefined });
      setData(res.data ?? null);
    } catch (err) {
      setData(null);
      toast(getErrorMessage(err, '產生工資核算資料失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  function download(kind: 'summary' | 'detail') {
    if (!data) return;
    const scope = data.branchId ? branchCode.get(data.branchId) ?? data.branchId : 'ALL';
    const table = data[kind];
    downloadCsv(`payroll-${kind}-${data.month}-${scope}.csv`, table.columns, table.rows);
  }

  const previewColumns = useMemo(
    () => (data ? PREVIEW_KEYS.map((k) => data.summary.columns.find((c) => c.key === k)).filter((c) => !!c) : []),
    [data],
  );

  return (
    <Card title="工資匯出" className="hr-panel__card">
      <p className="text-muted text-sm">
        彙整當月考勤標記（遲到／早退／曠職／未打下班卡／未排班出勤）、排定與實際工時、國定假日／休息日／例假出勤與各假別時數，
        供外部薪資系統核算；本功能不計算薪資金額（系統內計薪請至總部「薪資」分頁）。每次產生皆留存匯出紀錄。
      </p>
      <div className="roster__toolbar">
        <Field label="月份">
          <Input type="month" value={month} max={maxMonth} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </Field>
        <Field label="所屬分店">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">全部分店</option>
            {branches
              .filter((b) => b.type !== 'CLASS')
              .map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
          </Select>
        </Field>
        <Button onClick={() => void generate()} loading={busy}>產生</Button>
      </div>

      {!data ? (
        <EmptyState icon="🧾" title="選擇月份與分店後按「產生」" />
      ) : (
        <>
          <div className="payroll__head">
            <span>
              {data.from} ～ {data.to}｜{data.branchName ?? '全部分店'}｜{data.summary.rows.length} 人｜明細 {data.detail.rows.length} 筆
            </span>
            <span className="text-muted text-sm">產生於 {shortDateTime(data.generatedAt)}｜寬限 {data.graceMinutes} 分鐘</span>
            <span className="payroll__actions">
              <Button size="sm" variant="secondary" onClick={() => download('summary')}>下載彙總 CSV</Button>
              <Button size="sm" variant="secondary" onClick={() => download('detail')} disabled={!data.detail.rows.length}>
                下載明細 CSV
              </Button>
            </span>
          </div>
          {data.warnings.map((w) => (
            <Alert key={w} tone="warning">{w}</Alert>
          ))}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {previewColumns.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                  <th>需確認</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.rows.map((r) => (
                  <tr key={String(r.staffId)}>
                    {previewColumns.map((c) => (
                      <td key={c.key} className={c.numeric ? 'mono' : undefined}>{r[c.key] ?? ''}</td>
                    ))}
                    <td>{r.needsReview ? <Badge tone="danger">需確認</Badge> : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  {previewColumns.map((c, i) => (
                    <td key={c.key} className={c.numeric ? 'mono' : undefined}>
                      {i === 0 ? '合計' : c.numeric ? data.totals[c.key] ?? '' : ''}
                    </td>
                  ))}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
