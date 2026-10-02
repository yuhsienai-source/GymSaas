import { useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import { fetchGroupClassCrm, getErrorMessage } from '../../../lib/api';
import type { Branch } from '../../../types/api';

type Props = { branches: Branch[] };

type CrmRow = {
  classId: number;
  title: string;
  startAt: string;
  capacity: number;
  branchName?: string | null;
  venueName?: string | null;
  trainerName?: string | null;
  reserved: number;
  attended: number;
  left: number;
  makeupRegistrations: number;
  attendanceRate: number;
  leaveRate: number;
  fillRate: number;
};

export default function HqCrmTab({ branches }: Props) {
  const { toast } = useToast();
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [branchId, setBranchId] = useState<number | ''>('');
  const [rows, setRows] = useState<CrmRow[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);
  const requestKey = `${from}|${to}|${branchId}|${reloadKey}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const busy = loadedKey !== requestKey;

  useEffect(() => {
    let cancelled = false;
    fetchGroupClassCrm({ from, to, branchId: branchId || undefined })
      .then((res) => {
        if (cancelled) return;
        if (res.status !== 'success' || !res.data) {
          toast(res.message || '載入失敗', 'error');
          return;
        }
        setRows((res.data.rows || []) as CrmRow[]);
        setSummary(res.data.summary || null);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入團課 CRM 失敗'), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, branchId, requestKey, toast]);

  const renew = (summary?.renewProxy || {}) as {
    membersWithClass?: number;
    membersWithNewPurchase?: number;
    rate?: number;
  };

  return (
    <PageSection
      title="團課 CRM"
      desc="到課率、請假率、補課與續課代理指標（依預約／簽到／請假資料彙總）"
      action={
        <Button onClick={() => void load()} loading={busy}>
          重新整理
        </Button>
      }
    >
      <div className="form-row" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Field label="起">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="迄">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="分店">
          <Select
            value={branchId === '' ? '' : String(branchId)}
            onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">全部分店</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {summary && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: '0.75rem',
            margin: '1rem 0',
          }}
        >
          <Card title="堂數">{String(summary.classCount ?? 0)}</Card>
          <Card title="預約人次">{String(summary.reserved ?? 0)}</Card>
          <Card title="平均到課率">{String(summary.avgAttendanceRate ?? 0)}%</Card>
          <Card title="平均請假率">{String(summary.avgLeaveRate ?? 0)}%</Card>
          <Card title="續課代理">
            {renew.rate ?? 0}%（{renew.membersWithNewPurchase ?? 0}/{renew.membersWithClass ?? 0}）
          </Card>
        </div>
      )}

      <Alert tone="info">
        續課代理＝區間內有團課預約的會員，是否另有購課／私教合約；非嚴格續班定義，供營運參考。
      </Alert>

      <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
        <table className="data-table" style={{ width: '100%', fontSize: '0.9rem' }}>
          <thead>
            <tr>
              <th>課程</th>
              <th>時間</th>
              <th>教練</th>
              <th>預約</th>
              <th>到課</th>
              <th>請假</th>
              <th>補課</th>
              <th>到課率</th>
              <th>滿班率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.classId}>
                <td>
                  {r.title}
                  <div style={{ opacity: 0.7, fontSize: '0.8rem' }}>
                    {[r.branchName, r.venueName].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td>{new Date(r.startAt).toLocaleString('zh-TW')}</td>
                <td>{r.trainerName || '—'}</td>
                <td>{r.reserved}</td>
                <td>{r.attended}</td>
                <td>{r.left}</td>
                <td>{r.makeupRegistrations}</td>
                <td>{r.attendanceRate}%</td>
                <td>{r.fillRate}%</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={9}>
                  <Alert tone="info">此區間尚無團課資料</Alert>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </PageSection>
  );
}
