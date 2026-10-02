import { formatMoney } from '../../lib/hrFormat';
import type { PayrollLine } from '../../types/api';

const GROUPS: { kind: PayrollLine['kind']; title: string; totalLabel?: string }[] = [
  { kind: 'EARNING', title: '應發項目', totalLabel: '應發合計' },
  { kind: 'DEDUCTION', title: '應扣項目', totalLabel: '應扣合計' },
  { kind: 'EMPLOYER', title: '雇主負擔（不自薪資扣除）' },
];

/** 薪資單明細（金額全數來自後端計算結果，前端僅分組顯示） */
export default function PayslipLines({
  lines,
  grossPay,
  deductionTotal,
  netPay,
  showEmployer = true,
}: {
  lines: PayrollLine[];
  grossPay: number;
  deductionTotal: number;
  netPay: number;
  showEmployer?: boolean;
}) {
  const totals: Partial<Record<PayrollLine['kind'], number>> = { EARNING: grossPay, DEDUCTION: deductionTotal };
  return (
    <>
      <div className="payslip__groups">
        {GROUPS.filter((g) => showEmployer || g.kind !== 'EMPLOYER').map((g) => {
          const rows = lines.filter((l) => l.kind === g.kind);
          if (!rows.length && g.kind === 'EMPLOYER') return null;
          return (
            <section key={g.kind} className="payslip__group">
              <h4>{g.title}</h4>
              {rows.length === 0 && <p className="text-muted text-sm">無</p>}
              {rows.map((l, i) => (
                <div key={`${l.code}-${i}`} className="payslip__row">
                  <span>{l.label}</span>
                  <span className="payroll__num">{formatMoney(l.amount)}</span>
                </div>
              ))}
              {g.totalLabel && (
                <div className="payslip__row payslip__row--total">
                  <span>{g.totalLabel}</span>
                  <span className="payroll__num">{formatMoney(totals[g.kind])}</span>
                </div>
              )}
            </section>
          );
        })}
      </div>
      <div className="payslip__row payslip__row--total">
        <span>實發金額</span>
        <span className="payroll__num payslip__net">{formatMoney(netPay)}</span>
      </div>
    </>
  );
}
