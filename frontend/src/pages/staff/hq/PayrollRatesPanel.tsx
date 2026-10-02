import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Field, Input } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import { fetchPayrollConfig, getErrorMessage, updatePayrollConfig } from '../../../lib/api';
import { shortDateTime } from '../../../lib/hrFormat';
import type { PayrollConfigData } from '../../../types/api';

/** 勞健保／勞退費率與基本工資（僅影響之後的計算；已建立批次重算時套用） */
export default function PayrollRatesPanel() {
  const { toast } = useToast();
  const [config, setConfig] = useState<PayrollConfigData | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchPayrollConfig()
      .then((res) => {
        if (cancelled || !res.data) return;
        setConfig(res.data);
        setForm(Object.fromEntries(Object.entries(res.data.rates).map(([k, v]) => [k, String(v)])));
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入費率失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await updatePayrollConfig(form);
      if (res.data) {
        setConfig(res.data);
        setForm(Object.fromEntries(Object.entries(res.data.rates).map(([k, v]) => [k, String(v)])));
      }
      toast(res.message || '已更新', 'success');
    } catch (err) {
      toast(getErrorMessage(err, '更新費率失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  if (!config) return <p className="text-muted">載入中…</p>;

  return (
    <Card title="費率設定" className="hr-panel__card">
      <Alert tone="warning">
        預設值僅供參考，請依勞保局、健保署與勞動部最新公告核對後再結算。比例以小數表示（例：11.5% 填 0.115）。
      </Alert>
      <form onSubmit={submit}>
        <div className="payroll__form">
          {Object.entries(config.meta).map(([key, meta]) => (
            <Field key={key} label={meta.label} hint={`預設 ${config.defaults[key]}`}>
              <Input
                type="number"
                inputMode="decimal"
                step="any"
                min={meta.min}
                max={meta.max}
                value={form[key] ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
        <div className="roster__toolbar">
          <Button type="submit" loading={busy}>儲存費率</Button>
          {config.updatedAt && <span className="text-muted text-sm">最後更新 {shortDateTime(config.updatedAt)}</span>}
        </div>
      </form>
      <p className="text-muted text-sm">變更僅套用於之後的計算；草稿批次請按「重新計算」，已結算批次不受影響（除非撤銷後重算）。</p>
    </Card>
  );
}
