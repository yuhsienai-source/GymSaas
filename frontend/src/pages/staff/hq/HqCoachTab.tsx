import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  deleteHqCoachCommissionRule,
  fetchHqCoachCommissionRules,
  fetchHqCoachPerformance,
  getErrorMessage,
  putHqCoachCommissionRule,
} from '../../../lib/api';
import { formatMoney } from '../../../lib/hrFormat';
import { EMPLOYMENT_TYPE_LABELS, taipeiToday } from '../../../lib/laborLaw';
import type { CoachCommissionRule, CoachCourseKind, HqCoachPerformanceItem } from '../../../types/api';
import type { HqDataProps } from './types';

type TierRow = { minRevenue: string; ratePct: string };
const pct = (rate: number) => `${Math.round(rate * 10000) / 100}%`;
const prevMonth = () => {
  const [y, m] = taipeiToday().slice(0, 7).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

function ruleSummary(r: CoachCommissionRule) {
  const parts: string[] = [];
  if (r.tierRates?.length) {
    parts.push(`業績抽成 ${r.tierRates.map((t) => `≥${formatMoney(t.minRevenue)} ${pct(t.rate)}`).join('／')}`);
  }
  if (r.perHeadRate) parts.push(`每人次 ${formatMoney(r.perHeadRate)}`);
  if (r.sessionBonus) parts.push(`授課獎金每堂 ${formatMoney(r.sessionBonus)}`);
  return parts.join('；') || '—';
}

/** 教練為僱傭關係：底薪在薪資設定；此處維護業績獎金規則與月度試算（實發併入薪資批次） */
export default function HqCoachTab({ trainers }: Pick<HqDataProps, 'trainers'>) {
  const { toast } = useToast();
  const lockRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<CoachCommissionRule[]>([]);
  const [month, setMonth] = useState(prevMonth);
  const [perf, setPerf] = useState<HqCoachPerformanceItem[] | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [scope, setScope] = useState<string>('');
  const [kind, setKind] = useState<CoachCourseKind>('PRIVATE');
  const [tiers, setTiers] = useState<TierRow[]>([{ minRevenue: '0', ratePct: '10' }]);
  const [sessionBonus, setSessionBonus] = useState('');
  const [perHeadRate, setPerHeadRate] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchHqCoachCommissionRules(), fetchHqCoachPerformance(month)])
      .then(([ruleRes, perfRes]) => {
        if (cancelled) return;
        setRules(ruleRes.data ?? []);
        setPerf(perfRes.data?.items ?? []);
        setError('');
      })
      .catch((err) => !cancelled && setError(getErrorMessage(err, '讀取教練業績失敗')));
    return () => {
      cancelled = true;
    };
  }, [month, reloadKey]);

  async function run(task: () => Promise<{ message?: string }>, fallback: string) {
    if (lockRef.current) return false;
    lockRef.current = true;
    setBusy(true);
    try {
      const res = await task();
      toast(res.message || '已儲存', 'success');
      setReloadKey((k) => k + 1);
      return true;
    } catch (err) {
      toast(getErrorMessage(err, fallback), 'error');
      return false;
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }

  async function onSaveRule(e: FormEvent) {
    e.preventDefault();
    const tierRates =
      kind === 'PRIVATE'
        ? tiers
            .filter((t) => t.minRevenue !== '' && t.ratePct !== '')
            .map((t) => ({ minRevenue: Number(t.minRevenue), rate: Number(t.ratePct) / 100 }))
        : null;
    const ok = await run(
      () =>
        putHqCoachCommissionRule({
          trainerId: scope ? Number(scope) : null,
          courseKind: kind,
          tierRates: tierRates?.length ? tierRates : null,
          sessionBonus: sessionBonus === '' ? null : Number(sessionBonus),
          perHeadRate: kind === 'GROUP' && perHeadRate !== '' ? Number(perHeadRate) : null,
        }),
      '儲存獎金規則失敗',
    );
    if (ok) {
      setSessionBonus('');
      setPerHeadRate('');
    }
  }

  const flagged = (perf ?? []).filter((p) => p.flags.length > 0);

  return (
    <PageSection
      title="教練業績"
      desc="教練為僱傭關係：底薪於「薪資 → 薪資設定」維護（正職月薪 ≥ 基本工資、兼職時薪 ≥ 基本時薪，不因業績扣減）；業績獎金依下列規則由薪資批次自動計入工資，並計入加班費基數。"
    >
      {error && <Alert tone="error">{error}</Alert>}

      <Card title="月度業績獎金試算">
        <div className="roster__toolbar">
          <Field label="月份">
            <Input type="month" value={month} max={taipeiToday().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </Field>
          <p className="text-muted text-sm">
            私教以當月已執行堂數 × 合約單堂價（實付 ÷ 總堂數）計業績；團課以到課人次計。試算僅供檢視，實發以結算之薪資單為準。
          </p>
        </div>
        {flagged.length > 0 && (
          <Alert tone="warning">
            {flagged.length} 位教練有僱傭合規待處理（未綁定員工帳號者不得排課；未設定底薪者薪資批次會阻擋結算）。
          </Alert>
        )}
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>教練</th>
                <th>底薪（薪資設定）</th>
                <th className="payroll__num">私教堂數</th>
                <th className="payroll__num">私教業績</th>
                <th className="payroll__num">抽成</th>
                <th className="payroll__num">授課獎金</th>
                <th className="payroll__num">團課人次</th>
                <th className="payroll__num">團課獎金</th>
                <th className="payroll__num">獎金合計</th>
                <th>合規</th>
              </tr>
            </thead>
            <tbody>
              {perf === null ? (
                <tr>
                  <td colSpan={10} className="text-muted">載入中…</td>
                </tr>
              ) : perf.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-muted">無教練資料</td>
                </tr>
              ) : (
                perf.map((p) => {
                  const f = p.performance;
                  return (
                    <tr key={p.trainerId}>
                      <td>
                        <strong>{p.name}</strong>
                        <div className="text-muted text-sm">
                          {p.staff ? `${p.staff.name}・${EMPLOYMENT_TYPE_LABELS[p.staff.employmentType] ?? p.staff.employmentType}` : '未綁定員工'}
                        </div>
                      </td>
                      <td>
                        {p.basePay
                          ? p.basePay.payType === 'MONTHLY'
                            ? `月薪 ${formatMoney(p.basePay.monthlySalary)}`
                            : `時薪 ${formatMoney(p.basePay.hourlyWage)}`
                          : '—'}
                      </td>
                      <td className="payroll__num">{f.ptSessions}</td>
                      <td className="payroll__num">{formatMoney(f.ptRevenue)}</td>
                      <td className="payroll__num">
                        {formatMoney(f.ptCommission)}
                        {f.tierRate > 0 && <div className="text-muted text-sm">{pct(f.tierRate)}</div>}
                      </td>
                      <td className="payroll__num">{formatMoney(f.ptSessionBonus + f.groupSessionBonus)}</td>
                      <td className="payroll__num">
                        {f.groupHeads}
                        <div className="text-muted text-sm">{f.groupClasses} 堂</div>
                      </td>
                      <td className="payroll__num">{formatMoney(f.groupHeadBonus)}</td>
                      <td className="payroll__num">
                        <strong>{formatMoney(f.total)}</strong>
                      </td>
                      <td>
                        {p.flags.length === 0 ? (
                          <Badge tone="success">OK</Badge>
                        ) : (
                          p.flags.map((fl) => (
                            <Badge key={fl.code} tone={fl.code === 'NO_LABOR_INS' ? 'warning' : 'danger'}>
                              {fl.message}
                            </Badge>
                          ))
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="hq-grid-2 mt-md">
        <Card title="生效中獎金規則">
          <p className="text-muted text-sm">教練個別規則優先，無則套用全體預設；同教練同課型僅一筆生效（新增即取代）。</p>
          {rules.length === 0 ? (
            <p className="text-muted text-sm">尚未設定，教練僅領底薪。</p>
          ) : (
            <ul className="roster__requests">
              {rules.map((r) => (
                <li key={r.id}>
                  <Badge tone={r.scope === 'DEFAULT' ? 'info' : 'neutral'}>{r.scope === 'DEFAULT' ? '全體預設' : r.trainer?.name ?? `#${r.trainerId}`}</Badge>
                  <strong>{r.courseKindLabel}</strong>
                  <span className="text-sm">{ruleSummary(r)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void run(() => deleteHqCoachCommissionRule(r.id), '停用規則失敗')}
                  >
                    停用
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="新增／取代獎金規則">
          <form onSubmit={onSaveRule} className="my-roster__form">
            <Field label="適用對象">
              <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="">全體教練（預設）</option>
                {trainers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="課型">
              <Select value={kind} onChange={(e) => setKind(e.target.value as CoachCourseKind)}>
                <option value="PRIVATE">私教</option>
                <option value="GROUP">團課</option>
              </Select>
            </Field>
            {kind === 'PRIVATE' ? (
              <Field label="業績階梯（當月私教業績達門檻，全額適用該比例）">
                <div className="my-roster__form">
                  {tiers.map((t, i) => (
                    <div key={i} className="coach-plan__slot">
                      <Input
                        type="number"
                        min={0}
                        placeholder="門檻"
                        aria-label="業績門檻"
                        value={t.minRevenue}
                        onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, minRevenue: e.target.value } : x)))}
                      />
                      <span>元起</span>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={0.5}
                        placeholder="%"
                        aria-label="抽成比例"
                        value={t.ratePct}
                        onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, ratePct: e.target.value } : x)))}
                      />
                      <span>%</span>
                      {tiers.length > 1 && (
                        <Button size="sm" variant="ghost" aria-label="移除級距" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>
                          ✕
                        </Button>
                      )}
                    </div>
                  ))}
                  {tiers.length < 10 && (
                    <Button size="sm" variant="ghost" onClick={() => setTiers([...tiers, { minRevenue: '', ratePct: '' }])}>
                      ＋ 級距
                    </Button>
                  )}
                </div>
              </Field>
            ) : (
              <Field label="人頭獎金（每到課人次）">
                <Input type="number" min={0} value={perHeadRate} onChange={(e) => setPerHeadRate(e.target.value)} />
              </Field>
            )}
            <Field label={kind === 'PRIVATE' ? '授課獎金（每執行一堂）' : '授課獎金（每開課一堂，須有到課）'}>
              <Input type="number" min={0} value={sessionBonus} onChange={(e) => setSessionBonus(e.target.value)} />
            </Field>
            <p className="text-muted text-sm">
              獎金為工資之一部，不得為負、不得抵扣底薪或轉嫁刷卡手續費等營業成本；已廢除「僅付上課鐘點」制，兼職教練以薪資設定時薪計全部工時。
            </p>
            <Button type="submit" loading={busy}>
              儲存規則
            </Button>
          </form>
        </Card>
      </div>
    </PageSection>
  );
}
