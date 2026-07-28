import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, EmptyState } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  fetchOpsActiveCheckIns,
  getErrorMessage,
  opsCancelGate,
  opsManualCheckOut,
} from '../../lib/api';
import { formatGateAccessNo } from '../../lib/gateAccessNo';
import type { OpsActiveCheckIn } from '../../types/api';

function formatDateTime(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

type Props = {
  branchId: number | '';
};

export default function OpsActiveCheckInsTab({ branchId }: Props) {
  const { toast } = useToast();
  const [rows, setRows] = useState<OpsActiveCheckIn[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyLogId, setBusyLogId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchOpsActiveCheckIns(branchId === '' ? undefined : branchId);
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      toast(getErrorMessage(err, '載入進場會員失敗'), 'error');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [branchId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCancel(row: OpsActiveCheckIn) {
    const accessNo =
      row.gateAccessNo || formatGateAccessNo(row.checkInAt, row.logId);
    if (
      !window.confirm(
        `確定取消 ${row.name}（${row.memberNo || `#${row.memberId}`}）的進場？\n不計費、單號 ${accessNo} 將標記為已取消。`,
      )
    ) {
      return;
    }
    setBusyLogId(row.logId);
    try {
      const result = await opsCancelGate(row.logId, '櫃檯取消進場');
      toast(result.message || '已取消進場', 'success');
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '取消進場失敗'), 'error');
    } finally {
      setBusyLogId(null);
    }
  }

  async function handleCheckOut(row: OpsActiveCheckIn) {
    if (
      !window.confirm(
        `確定為 ${row.name}（${row.memberNo || `#${row.memberId}`}）補登出場？\n將依進場快照計費（月費通行 0 元；計時 1.3 元／分）。`,
      )
    ) {
      return;
    }
    setBusyLogId(row.logId);
    try {
      const result = await opsManualCheckOut(row.logId);
      const fee = result.feeDetails?.totalFee;
      toast(
        result.message ||
          (fee != null ? `補登出場成功 · $${fee}` : '補登出場成功'),
        'success',
      );
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '補登出場失敗'), 'error');
    } finally {
      setBusyLogId(null);
    }
  }

  return (
    <Card
      title="進場會員列表"
      subtitle="目前在場（未出場且未取消）· 取消進場不計費；補登出場依快照結算"
    >
      <div className="table-toolbar" style={{ justifyContent: 'space-between' }}>
        <p className="text-sm text-muted" style={{ margin: 0 }}>
          {branchId === '' ? '全部分店' : `分店篩選中`} · 共 {rows.length} 人
        </p>
        <Button size="sm" variant="secondary" loading={loading} onClick={() => void load()}>
          重新整理
        </Button>
      </div>

      <Alert tone="info">
        「取消入場」＝誤刷／作廢（不扣費）。「補登出場」＝會員已離場但未掃碼，依進場方案結算後離場。
      </Alert>

      {loading && rows.length === 0 ? (
        <EmptyState icon="⏳" title="載入中…" />
      ) : rows.length === 0 ? (
        <EmptyState icon="🧍" title="目前無人在場" desc="閘機進場後會出現在此列表" />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>會員編號</th>
                <th>姓名</th>
                <th>進場時間</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const busy = busyLogId === row.logId;
                return (
                  <tr key={row.logId}>
                    <td>
                      <strong>{row.memberNo || '—'}</strong>
                      <div className="text-sm text-muted mono">
                        {row.gateAccessNo || formatGateAccessNo(row.checkInAt, row.logId)}
                      </div>
                    </td>
                    <td>
                      {row.name}
                      {row.billingMode ? (
                        <div className="text-sm text-muted">{row.billingMode}</div>
                      ) : null}
                    </td>
                    <td>{formatDateTime(row.checkInAt)}</td>
                    <td>
                      <div
                        className="btn-row"
                        style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}
                      >
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy}
                          disabled={busyLogId != null && !busy}
                          onClick={() => void handleCancel(row)}
                        >
                          取消入場
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy}
                          disabled={busyLogId != null && !busy}
                          onClick={() => void handleCheckOut(row)}
                        >
                          補登出場
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
