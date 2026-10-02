import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import {
  fetchOpsInvoiceJobs,
  getErrorMessage,
  retryOpsInvoiceJob,
  type InvoiceIssueJobRow,
} from '../../lib/api';

function money(n: number | null | undefined) {
  return `$${Math.round(Number(n) || 0).toLocaleString('zh-TW')}`;
}

export default function OpsInvoiceFailBanner() {
  const { toast } = useToast();
  const [failed, setFailed] = useState<InvoiceIssueJobRow[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [retryAllBusy, setRetryAllBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchOpsInvoiceJobs({ status: 'FAILED', take: 100 });
      setFailed(res.data?.items || []);
    } catch {
      /* 靜默：頂部警示非阻斷 */
    }
  }, []);

  useEffect(() => {
    let t: number | undefined;
    const start = () => {
      if (t !== undefined) return;
      void load();
      t = window.setInterval(() => void load(), 60_000);
    };
    const stop = () => {
      if (t === undefined) return;
      window.clearInterval(t);
      t = undefined;
    };
    // 背景分頁不輪詢：否則 DB（Neon）永遠無法休眠
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [load]);

  async function retryOne(id: string) {
    setBusyId(id);
    try {
      await retryOpsInvoiceJob(id);
      toast('已重新排隊開立發票', 'success');
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '重試失敗'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function retryAll() {
    if (!failed.length || retryAllBusy) return;
    setRetryAllBusy(true);
    let ok = 0;
    try {
      for (const job of failed) {
        try {
          await retryOpsInvoiceJob(job.id);
          ok += 1;
        } catch {
          /* continue */
        }
      }
      toast(`已送出 ${ok}/${failed.length} 筆重試`, ok === failed.length ? 'success' : 'info');
      await load();
    } finally {
      setRetryAllBusy(false);
    }
  }

  if (!failed.length) return null;

  return (
    <>
      <Alert tone="warning">
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.75rem',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <strong>發票開立失敗待重試：{failed.length} 筆</strong>
            <div className="text-sm text-muted">
              已收款未開票屬漏稅風險，請於交班前處理完畢。
            </div>
          </div>
          <Button size="sm" onClick={() => setOpen(true)}>
            查看並重試
          </Button>
        </div>
      </Alert>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`待重試發票（${failed.length}）`}
        footer={
          <div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              關閉
            </Button>
            <Button loading={retryAllBusy} onClick={() => void retryAll()}>
              🔄 全部重試開立
            </Button>
          </div>
        }
      >
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>子單</th>
                <th>腿／營業人</th>
                <th>金額</th>
                <th>失敗原因</th>
                <th>重試</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {failed.map((job) => (
                <tr key={job.id}>
                  <td>
                    <code>{job.refId}</code>
                    {job.checkoutId ? (
                      <div className="text-sm text-muted">{job.checkoutId}</div>
                    ) : null}
                    <div className="text-sm text-muted">{job.itemDesc}</div>
                  </td>
                  <td>
                    {job.leg}
                    {job.legalEntity ? (
                      <div className="text-sm text-muted">{job.legalEntity.name}</div>
                    ) : null}
                  </td>
                  <td>{money(job.amount)}</td>
                  <td className="text-sm" style={{ maxWidth: 240 }}>
                    {job.lastError || '—'}
                  </td>
                  <td>{job.retryCount}</td>
                  <td>
                    <Button
                      size="sm"
                      loading={busyId === job.id}
                      onClick={() => void retryOne(job.id)}
                    >
                      🔄 重試開立發票
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </>
  );
}
