import { useEffect, useState } from 'react';
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

type GateAlertEvent = {
  type?: string;
  code?: string;
  title?: string;
  message?: string;
  memberId?: number | null;
  memberName?: string | null;
  branchId?: number | null;
  severity?: string;
  at?: string;
};

function gateAlertWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws/gate-alert`;
}

type Props = {
  branchId: number | '';
};

export default function OpsActiveCheckInsTab({ branchId }: Props) {
  const { toast } = useToast();
  const [rows, setRows] = useState<OpsActiveCheckIn[]>([]);
  const [busyLogId, setBusyLogId] = useState<number | null>(null);
  const [alerts, setAlerts] = useState<GateAlertEvent[]>([]);
  const [wsStatus, setWsStatus] = useState('連線中…');

  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);
  const requestKey = `${branchId}|${reloadKey}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    let cancelled = false;
    fetchOpsActiveCheckIns(branchId === '' ? undefined : branchId)
      .then((res) => {
        if (!cancelled) setRows(Array.isArray(res.data) ? res.data : []);
      })
      .catch((err) => {
        if (cancelled) return;
        toast(getErrorMessage(err, '載入進場會員失敗'), 'error');
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, requestKey, toast]);

  useEffect(() => {
    let closed = false;
    let timer: number | undefined;
    let socket: WebSocket | null = null;

    function pushAlert(ev: GateAlertEvent) {
      if (branchId !== '' && ev.branchId != null && Number(ev.branchId) !== Number(branchId)) {
        return;
      }
      setAlerts((prev) => [ev, ...prev].slice(0, 12));
      toast(
        ev.title ? `${ev.title}：${ev.message || ''}` : ev.message || '閘機異常',
        'error',
      );
      setReloadKey((k) => k + 1);
    }

    function connect() {
      socket = new WebSocket(gateAlertWsUrl());
      socket.onopen = () => {
        if (!closed) setWsStatus('異常推播已連線');
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as GateAlertEvent & { recent?: GateAlertEvent[] };
          if (msg.type === 'gate-alert-hello' && Array.isArray(msg.recent)) {
            const filtered = msg.recent.filter(
              (r) =>
                branchId === '' ||
                r.branchId == null ||
                Number(r.branchId) === Number(branchId),
            );
            setAlerts(filtered.slice(0, 12));
            return;
          }
          if (msg.type === 'gate-alert' || msg.code === 'NO_ACTIVE_CHECKIN') {
            pushAlert(msg);
          }
        } catch {
          /* ignore */
        }
      };
      socket.onclose = () => {
        if (closed) return;
        setWsStatus('推播中斷，3 秒後重連…');
        timer = window.setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    }

    connect();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, [branchId, toast]);

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
          {branchId === '' ? '全部分店' : `分店篩選中`} · 共 {rows.length} 人 · {wsStatus}
        </p>
        <Button size="sm" variant="secondary" loading={loading} onClick={() => void load()}>
          重新整理
        </Button>
      </div>

      {alerts.length > 0 && (
        <div className="gate-alert-stack" style={{ marginBottom: '0.75rem' }}>
          {alerts.slice(0, 3).map((a, i) => (
            <Alert key={`${a.at}-${i}`} tone="error">
              <strong>{a.title || '閘機異常'}</strong>
              {a.memberName ? ` · ${a.memberName}` : ''}
              {a.memberId != null ? `（#${a.memberId}）` : ''}
              ：{a.message}
              {a.at ? (
                <span className="text-sm text-muted"> · {formatDateTime(a.at)}</span>
              ) : null}
            </Alert>
          ))}
          {alerts.length > 3 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAlerts([])}
              style={{ marginTop: '0.35rem' }}
            >
              清除異常標記（{alerts.length}）
            </Button>
          )}
        </div>
      )}

      <Alert tone="info">
        「取消入場」＝誤刷／作廢（不扣費）。「補登出場」＝會員已離場但未掃碼，依進場方案結算後離場。出場無在場紀錄會推播「異常滯留」。
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
