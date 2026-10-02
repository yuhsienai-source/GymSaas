import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, EmptyState } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  createMyLineBindUrl,
  fetchMyLineStatus,
  fetchMyNotifications,
  getErrorMessage,
  markMyNotificationsRead,
  sendMyLineTest,
  setMyLineNotify,
  unbindMyLine,
} from '../../lib/api';
import { shortDateTime } from '../../lib/hrFormat';
import type { StaffLineStatus, StaffNotificationInbox, StaffNotificationStatus } from '../../types/api';

const DELIVERY_LABEL: Record<StaffNotificationStatus, string> = {
  PENDING: '推播中',
  SENT: '已推播 LINE',
  SKIPPED: '僅站內',
  FAILED: '推播失敗（重試中）',
};

/** 員工本人：LINE 推播綁定（僅作通知，不可用於登入）＋站內通知匣 */
export default function StaffNotificationsCard() {
  const { toast } = useToast();
  const [line, setLine] = useState<StaffLineStatus | null>(null);
  const [inbox, setInbox] = useState<StaffNotificationInbox | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchMyLineStatus(), fetchMyNotifications()])
      .then(([l, n]) => {
        if (cancelled) return;
        setLine(l.data ?? null);
        setInbox(n.data ?? null);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入通知失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  async function run(action: () => Promise<{ message?: string }>, fallback: string) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await action();
      if (res.message) toast(res.message, 'success');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, fallback), 'error');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  async function startBind() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await createMyLineBindUrl();
      if (res.data?.url) window.location.assign(res.data.url);
    } catch (err) {
      toast(getErrorMessage(err, '無法開始 LINE 綁定'), 'error');
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  function onUnbind() {
    if (!window.confirm('解除 LINE 綁定後將不再收到推播（站內通知仍保留），確定？')) return;
    void run(unbindMyLine, '解除綁定失敗');
  }

  if (!line || !inbox) return <p className="text-muted">載入通知中…</p>;

  return (
    <Card title="通知與 LINE 推播" className="hr-panel__card">
      <div className="staff-notify__line">
        <div>
          {line.bound ? (
            <p className="my-hr__status">
              <Badge tone="success" dot>已綁定 LINE</Badge> {line.displayName ?? ''}
              {!line.notifyEnabled && <Badge tone="warning">推播已暫停</Badge>}
            </p>
          ) : (
            <p className="my-hr__status">
              <Badge>未綁定 LINE</Badge>
            </p>
          )}
          <p className="text-muted text-sm">
            排班發布／確認提醒、排假截止、週班表送審／審核結果、請假審核、假期衝突與薪資單發布會推播至 LINE；需先加入官方帳號好友。LINE
            僅作通知用途，不可用於登入。
          </p>
          {!line.loginConfigured && <Alert tone="warning">系統尚未設定 LINE Login，暫無法綁定。</Alert>}
          {line.bound && !line.pushConfigured && (
            <Alert tone="warning">系統尚未設定 LINE 推播 Token，目前僅提供站內通知。</Alert>
          )}
        </div>
        <div className="staff-notify__actions">
          {line.bound ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void run(() => setMyLineNotify(!line.notifyEnabled), '更新推播設定失敗')}
              >
                {line.notifyEnabled ? '暫停推播' : '恢復推播'}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy || !line.notifyEnabled} onClick={() => void run(sendMyLineTest, '測試推播失敗')}>
                測試推播
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onUnbind}>
                解除綁定
              </Button>
            </>
          ) : (
            <Button size="sm" loading={busy} disabled={!line.loginConfigured} onClick={() => void startBind()}>
              綁定 LINE
            </Button>
          )}
        </div>
      </div>

      <div className="staff-notify__head">
        <strong>通知匣</strong>
        {inbox.unread > 0 && <Badge tone="info">{inbox.unread} 則未讀</Badge>}
        {inbox.unread > 0 && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => markMyNotificationsRead(), '標記已讀失敗')}>
            全部已讀
          </Button>
        )}
      </div>
      {inbox.items.length === 0 ? (
        <EmptyState icon="🔔" title="目前沒有通知" />
      ) : (
        <ul className="staff-notify__list">
          {inbox.items.map((n) => (
            <li key={n.id} className={`staff-notify__item ${n.readAt ? '' : 'is-unread'}`}>
              <div className="staff-notify__title">
                <span>{n.title}</span>
                <span className="text-muted text-sm">{shortDateTime(n.createdAt)}</span>
              </div>
              <p className="staff-notify__body text-sm">{n.body}</p>
              <div className="staff-notify__meta text-sm">
                <span className="text-muted">{DELIVERY_LABEL[n.status]}</span>
                {n.link && <Link to={n.link}>前往查看</Link>}
                {!n.readAt && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => markMyNotificationsRead([n.id]), '標記已讀失敗')}>
                    已讀
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
