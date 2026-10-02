import { useEffect, useState } from 'react';
import { Badge, Card, EmptyState, Field, Select } from '../ui';
import PayslipLines from './PayslipLines';
import { useToast } from '../../contexts/ToastContext';
import { fetchMyPayslip, fetchMyPayslips, getErrorMessage } from '../../lib/api';
import { formatMinutes, shortDateTime } from '../../lib/hrFormat';
import type { MyPayslipDetail, MyPayslipSummary } from '../../types/api';

/** 本人薪資單（僅總部已結算之月份；身分取自員工 JWT） */
export default function MyPayslipCard() {
  const { toast } = useToast();
  const [list, setList] = useState<MyPayslipSummary[] | null>(null);
  const [picked, setPicked] = useState('');
  const [loaded, setLoaded] = useState<{ month: string; data: MyPayslipDetail } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMyPayslips()
      .then((res) => {
        if (!cancelled) setList(res.data?.items ?? []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入薪資單失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const month = picked || list?.[0]?.month || '';

  useEffect(() => {
    if (!month) return;
    let cancelled = false;
    fetchMyPayslip(month)
      .then((res) => {
        if (!cancelled && res.data) setLoaded({ month, data: res.data });
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入薪資單失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [month, toast]);

  const slip = loaded?.month === month ? loaded.data : null;
  const a = slip?.attendance;
  const leaveText = a ? Object.entries(a.leaveHours).map(([k, h]) => `${k} ${h}h`).join('、') : '';

  return (
    <Card title="薪資單" className="hr-panel__card">
      {!list ? (
        <p className="text-muted">載入中…</p>
      ) : list.length === 0 ? (
        <EmptyState icon="💰" title="尚無已發布的薪資單" desc="總部結算後會通知您" />
      ) : (
        <>
          <div className="roster__toolbar">
            <Field label="月份">
              <Select value={month} onChange={(e) => setPicked(e.target.value)}>
                {list.map((s) => (
                  <option key={s.month} value={s.month}>{s.month}</option>
                ))}
              </Select>
            </Field>
            {slip && (
              <span className="text-muted text-sm">
                {slip.payTypeLabel}｜發布於 {shortDateTime(slip.finalizedAt)}
              </span>
            )}
          </div>
          {!slip || !a ? (
            <p className="text-muted">載入中…</p>
          ) : (
            <>
              <div className="hr-panel__chips">
                <Badge>在職 {a.employedDays}/{a.daysInMonth} 日</Badge>
                <Badge>排班 {a.scheduledShifts} 班</Badge>
                <Badge>工時 {formatMinutes(a.workedMinutes)}</Badge>
                <Badge tone={a.lateCount + a.earlyCount ? 'warning' : 'neutral'}>
                  遲到早退 {a.lateCount + a.earlyCount} 次／{a.lateMinutes + a.earlyMinutes} 分
                </Badge>
                <Badge tone={a.absentShifts ? 'danger' : 'neutral'}>曠職 {a.absentShifts} 班</Badge>
              </div>
              {leaveText && <p className="text-sm">請假：{leaveText}</p>}
              {slip.overtime.length > 0 && (
                <p className="text-sm">
                  核定加班：{slip.overtime.map((o) => `${o.date} ${o.kindLabel} ${formatMinutes(o.approvedMinutes)}`).join('、')}
                </p>
              )}
              <PayslipLines lines={slip.lines} grossPay={slip.grossPay} deductionTotal={slip.deductionTotal} netPay={slip.netPay} />
              <p className="text-muted text-sm">如對薪資有疑問，請洽總部人資。</p>
            </>
          )}
        </>
      )}
    </Card>
  );
}
