import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Button, Card, Field, Input, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createHqCoachCommissionRule,
  fetchHqCoachCommissionLedger,
  fetchHqCoachCommissionRules,
  getErrorMessage,
  runHqCoachCommissionLedger,
} from '../../../lib/api';
import type { CoachCommissionLedger, CoachCommissionRule } from '../../../types/api';
import type { HqDataProps } from './types';

export default function HqCoachTab({ trainers }: Pick<HqDataProps, 'trainers'>) {
  const { toast } = useToast();
  const [rules, setRules] = useState<CoachCommissionRule[]>([]);
  const [ledger, setLedger] = useState<CoachCommissionLedger[]>([]);
  const [trainerId, setTrainerId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [baseSalary, setBaseSalary] = useState('0');

  const load = useCallback(async () => {
    try {
      const [ruleRes, ledgerRes] = await Promise.all([
        fetchHqCoachCommissionRules(trainerId === '' ? undefined : Number(trainerId)),
        fetchHqCoachCommissionLedger(
          trainerId === '' ? undefined : { trainerId: Number(trainerId), take: 50 },
        ),
      ]);
      if (ruleRes.status === 'success' && ruleRes.data) setRules(ruleRes.data);
      if (ledgerRes.status === 'success' && ledgerRes.data) setLedger(ledgerRes.data);
    } catch (err) {
      toast(getErrorMessage(err, '載入拆帳資料失敗'), 'error');
    }
  }, [trainerId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!trainerId && trainers[0]) setTrainerId(trainers[0].id);
  }, [trainers, trainerId]);

  async function onCreateRule(e: FormEvent) {
    e.preventDefault();
    if (trainerId === '') return;
    setBusy(true);
    try {
      const res = await createHqCoachCommissionRule({
        trainerId: Number(trainerId),
        courseKind: 'PRIVATE',
        payModel: 'PERFORMANCE',
        baseSalary: Number(baseSalary) || 0,
      });
      toast(res.message || '已建立', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') void load();
    } catch (err) {
      toast(getErrorMessage(err, '建立失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onRunLedger(e: FormEvent) {
    e.preventDefault();
    if (trainerId === '' || !periodStart || !periodEnd) return;
    setBusy(true);
    try {
      const res = await runHqCoachCommissionLedger({
        trainerId: Number(trainerId),
        periodStart: new Date(periodStart).toISOString(),
        periodEnd: new Date(periodEnd).toISOString(),
      });
      toast(res.message || '試算完成', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') void load();
    } catch (err) {
      toast(getErrorMessage(err, '試算失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageSection title="教練拆帳" desc="抽成規則與帳冊試算">
      <Field label="教練">
        <Select
          value={trainerId === '' ? '' : String(trainerId)}
          onChange={(e) => setTrainerId(e.target.value ? Number(e.target.value) : '')}
        >
          {trainers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="hq-grid-2 mt-md">
        <Card title="新增拆帳規則">
          <form onSubmit={onCreateRule}>
            <Field label="底薪">
              <Input
                type="number"
                value={baseSalary}
                onChange={(e) => setBaseSalary(e.target.value)}
                min={0}
              />
            </Field>
            <Button type="submit" loading={busy}>
              建立規則
            </Button>
          </form>
        </Card>
        <Card title="執行試算">
          <form onSubmit={onRunLedger}>
            <Field label="期間起">
              <Input
                type="datetime-local"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                required
              />
            </Field>
            <Field label="期間訖">
              <Input
                type="datetime-local"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" loading={busy}>
              試算拆帳
            </Button>
          </form>
        </Card>
      </div>

      <Card title="規則列表" className="mt-lg">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>教練</th>
                <th>課型</th>
                <th>模式</th>
                <th>底薪</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.trainer?.name || r.trainerId}</td>
                  <td>{r.courseKind}</td>
                  <td>{r.payModel}</td>
                  <td>{r.baseSalary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="帳冊" className="mt-lg">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>教練</th>
                <th>期間</th>
                <th>毛額</th>
                <th>淨額</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.id}>
                  <td>{l.trainer?.name}</td>
                  <td>
                    {new Date(l.periodStart).toLocaleDateString('zh-TW')} –{' '}
                    {new Date(l.periodEnd).toLocaleDateString('zh-TW')}
                  </td>
                  <td>${l.grossAmount}</td>
                  <td>${l.netAmount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </PageSection>
  );
}
