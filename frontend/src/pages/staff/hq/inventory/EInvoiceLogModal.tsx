import { useEffect, useState } from 'react';
import { Badge, Modal } from '../../../../components/ui';
import { fetchHqEInvoiceCallLogs, fetchHqEInvoiceLogs, getErrorMessage } from '../../../../lib/api';
import { fmtDateTime, money } from '../../../../lib/inventoryLabels';
import type { EInvoiceLogRow } from '../../../../types/api';

const ACTION_LABEL: Record<EInvoiceLogRow['action'], string> = {
  ISSUE: '開立',
  RECOVER: '查詢補登',
  VOID: '作廢',
  ALLOWANCE: '折讓',
};

const RESULT_BADGE: Record<EInvoiceLogRow['result'], { label: string; tone: 'success' | 'danger' | 'neutral' }> = {
  SUCCESS: { label: '成功', tone: 'success' },
  FAILED: { label: '失敗', tone: 'danger' },
  NOT_FOUND: { label: '查無', tone: 'neutral' },
};

/** ezPay 呼叫紀錄（唯讀）：指定 einvoiceId 看單張全部嘗試，否則看跨營業人失敗紀錄 */
export default function EInvoiceLogModal({
  einvoiceId,
  title,
  onClose,
}: {
  einvoiceId: string | null;
  title: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<EInvoiceLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (einvoiceId ? fetchHqEInvoiceLogs(einvoiceId) : fetchHqEInvoiceCallLogs())
      .then((res) => {
        if (!cancelled) setRows(res.data || []);
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err, '載入 ezPay 呼叫紀錄失敗'));
      });
    return () => {
      cancelled = true;
    };
  }, [einvoiceId]);

  return (
    <Modal open title={title} onClose={onClose} wide>
      {error ? (
        <p className="text-muted">{error}</p>
      ) : rows === null ? (
        <p className="text-muted">載入中…</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>時間</th>
                {einvoiceId ? null : <th>單據／自訂編號</th>}
                <th>動作</th>
                <th>結果</th>
                <th>ezPay 代碼</th>
                <th>訊息</th>
                <th>MerchantID</th>
                <th>耗時</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={einvoiceId ? 7 : 8} className="text-muted text-center">
                    沒有紀錄
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const badge = RESULT_BADGE[r.result] || { label: r.result, tone: 'neutral' as const };
                  return (
                    <tr key={r.id}>
                      <td className="text-sm">{fmtDateTime(r.createdAt)}</td>
                      {einvoiceId ? null : (
                        <td className="mono text-sm">
                          {r.refId || '—'}
                          {r.merchantOrderNo ? <div className="text-muted">{r.merchantOrderNo}</div> : null}
                          {r.totalAmount != null ? <div className="text-muted">{money(r.totalAmount)}</div> : null}
                        </td>
                      )}
                      <td className="text-sm">
                        {ACTION_LABEL[r.action] || r.action}
                        {r.attempt ? <div className="text-muted">第 {r.attempt} 次{r.manual ? '・手動' : ''}</div> : null}
                      </td>
                      <td>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                        {r.invoiceNumber ? <div className="mono text-sm">{r.invoiceNumber}</div> : null}
                      </td>
                      <td className="mono text-sm">
                        {r.ezpayStatus || '—'}
                        {r.errorCode ? <div className="text-muted">{r.errorCode}</div> : null}
                      </td>
                      <td className="text-sm" style={{ maxWidth: 280 }}>
                        {r.message || '—'}
                      </td>
                      <td className="mono text-sm">{r.merchantId || '—'}</td>
                      <td className="text-sm">{r.durationMs != null ? `${r.durationMs} ms` : '—'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
