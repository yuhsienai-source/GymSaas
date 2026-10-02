import { useEffect, useState } from 'react';
import { Alert, Button, EmptyState } from '../../ui';
import { fetchTrainerMyPerformance, getErrorMessage } from '../../../lib/api';
import { formatMoney } from '../../../lib/hrFormat';
import { taipeiToday } from '../../../lib/laborLaw';
import type { CoachCommissionRule, TrainerMyPerformance } from '../../../types/api';

const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};
const pct = (rate: number) => `${Math.round(rate * 10000) / 100}%`;

function ruleText(r: CoachCommissionRule | null) {
  if (!r) return '未設定';
  const parts: string[] = [];
  if (r.tierRates?.length) parts.push(r.tierRates.map((t) => `≥${formatMoney(t.minRevenue)} ${pct(t.rate)}`).join('／'));
  if (r.perHeadRate) parts.push(`每人次 ${formatMoney(r.perHeadRate)}`);
  if (r.sessionBonus) parts.push(`每堂 ${formatMoney(r.sessionBonus)}`);
  return parts.join('；') || '未設定';
}

/** 教練本人當月業績獎金試算（後端計算；實發以結算之薪資單為準，底薪另計） */
export default function TrainerPerformanceCard({ viewAsTrainerId }: { viewAsTrainerId?: number }) {
  const thisMonth = taipeiToday().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState<TrainerMyPerformance | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchTrainerMyPerformance(month, viewAsTrainerId)
      .then((res) => {
        if (cancelled) return;
        setData(res.data ?? null);
        setError('');
      })
      .catch((err) => !cancelled && setError(getErrorMessage(err, '讀取業績失敗')));
    return () => {
      cancelled = true;
    };
  }, [month, viewAsTrainerId]);

  const p = data?.performance;
  return (
    <div className="form-stack">
      <div className="coach-desk__cta-row">
        <Button size="sm" variant="ghost" onClick={() => setMonth(shiftMonth(month, -1))}>
          ← 上月
        </Button>
        <strong className="mono">{month}</strong>
        <Button size="sm" variant="ghost" disabled={month >= thisMonth} onClick={() => setMonth(shiftMonth(month, 1))}>
          下月 →
        </Button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!p ? (
        !error && <EmptyState icon="⏳" title="載入中" />
      ) : (
        <>
          <ul className="roster__requests">
            <li>
              私教已執行 <strong>{p.ptSessions}</strong> 堂・業績 {formatMoney(p.ptRevenue)}
              {p.tierRate > 0 ? `・抽成 ${pct(p.tierRate)} = ${formatMoney(p.ptCommission)}` : ''}
            </li>
            <li>授課獎金 {formatMoney(p.ptSessionBonus + p.groupSessionBonus)}</li>
            <li>
              團課 {p.groupClasses} 堂・{p.groupHeads} 人次・人頭獎金 {formatMoney(p.groupHeadBonus)}
            </li>
            <li>
              <strong>獎金合計 {formatMoney(p.total)}</strong>
            </li>
          </ul>
          <p className="text-muted text-sm">
            私教：{ruleText(data.rules.PRIVATE)}｜團課：{ruleText(data.rules.GROUP)}。獎金另加於底薪、併入月薪資單並計入加班費基數；
            實發以總部結算之薪資單為準（「我的出勤 → 薪資單」）。
          </p>
        </>
      )}
    </div>
  );
}
