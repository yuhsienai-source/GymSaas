import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '../../../components/ui';
import PayslipLines from '../../../components/staff/PayslipLines';
import ReasonModal from '../../../components/staff/ReasonModal';
import { useToast } from '../../../contexts/ToastContext';
import {
  addPayrollAdjustment,
  createPayrollRun,
  decideItemOvertime,
  decideRunOvertime,
  deletePayrollRun,
  fetchPayrollRun,
  fetchPayrollRuns,
  getErrorMessage,
  payrollRunAction,
  removePayrollAdjustment,
  reopenPayrollRun,
} from '../../../lib/api';
import { downloadCsv } from '../../../lib/csv';
import { formatMinutes, formatMoney, shortDateTime, weekdayLabel } from '../../../lib/hrFormat';
import { taipeiToday } from '../../../lib/laborLaw';
import type {
  ApiResponse,
  PayrollAdjustmentType,
  PayrollItemData,
  PayrollRunDetail,
  PayrollRunSummary,
  PayrollWarning,
} from '../../../types/api';

function previousMonth() {
  const [y, m] = taipeiToday().split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const pendingOt = (item: PayrollItemData) => item.overtime.filter((o) => o.approvedMinutes === null).length;

function WarningBadges({ warnings }: { warnings: PayrollWarning[] }) {
  if (!warnings.length) return <Badge tone="success">正常</Badge>;
  return (
    <span className="attendance__flags">
      {warnings.map((w) => (
        <Badge key={w.code + w.message} tone={w.blocking ? 'danger' : 'warning'}>{w.message}</Badge>
      ))}
    </span>
  );
}

/** 月薪資結算：建立／重算批次、加班核定、手動項、結算（通知員工）與撤銷；金額一律後端計算 */
export default function PayrollRunPanel() {
  const { toast } = useToast();
  const [month, setMonth] = useState(previousMonth);
  const [runs, setRuns] = useState<PayrollRunSummary[]>([]);
  const [runsKey, setRunsKey] = useState(0);
  const [detail, setDetail] = useState<PayrollRunDetail | null>(null);
  const [version, setVersion] = useState(0);
  const [openItemId, setOpenItemId] = useState<number | null>(null);
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);
  const maxMonth = taipeiToday().slice(0, 7);

  useEffect(() => {
    let cancelled = false;
    fetchPayrollRuns()
      .then((res) => {
        if (!cancelled) setRuns(res.data?.items ?? []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入薪資批次失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [runsKey, toast]);

  /** 執行會回傳整批明細的動作；成功後刷新畫面 */
  async function run(action: () => Promise<ApiResponse<PayrollRunDetail>>, fallback: string, silent = false) {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await action();
      if (res.data) {
        setDetail(res.data);
        setMonth(res.data.run.month);
        setVersion((v) => v + 1);
      }
      if (res.message && !silent) toast(res.message, 'success');
      setRunsKey((k) => k + 1);
      return true;
    } catch (err) {
      toast(getErrorMessage(err, fallback), 'error');
      return false;
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  function openMonth(target = month) {
    const existing = runs.find((r) => r.month === target);
    void run(() => (existing ? fetchPayrollRun(existing.id) : createPayrollRun(target)), '開啟薪資批次失敗', !!existing);
  }

  async function onDelete() {
    if (!detail || !window.confirm(`刪除 ${detail.run.month} 薪資草稿？（手動項與加班核定將一併刪除）`)) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await deletePayrollRun(detail.run.id);
      toast(res.message || '已刪除', 'success');
      setDetail(null);
      setRunsKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '刪除失敗'), 'error');
    } finally {
      inFlightRef.current = false;
    }
  }

  const r = detail?.run;
  const draft = r?.status === 'DRAFT';
  const openItem = detail?.items.find((i) => i.id === openItemId) ?? null;
  const pendingTotal = detail ? detail.items.reduce((n, i) => n + pendingOt(i), 0) : 0;

  return (
    <Card title="薪資結算" className="hr-panel__card">
      <p className="text-muted text-sm">
        依當月考勤、已核准請假、教練業績獎金與薪資設定由系統計算（加班費基數含固定津貼與業績獎金）；加班須逐筆核定後才計入。結算前系統會以最新考勤重算，
        月份未結束、加班未核定、有未打下班卡或有出勤員工未設定薪資時不可結算。結算後員工可於「我的出勤」查看薪資單並收到通知。
      </p>
      <div className="roster__toolbar">
        <Field label="月份">
          <Input type="month" value={month} max={maxMonth} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </Field>
        <Button onClick={() => openMonth()} loading={busy && !detail}>
          {runs.some((x) => x.month === month) ? '開啟' : '建立並計算'}
        </Button>
      </div>
      {runs.length > 0 && (
        <div className="payroll__runs">
          {runs.slice(0, 12).map((x) => (
            <Button key={x.id} size="sm" variant={detail?.run.id === x.id ? 'primary' : 'secondary'} onClick={() => openMonth(x.month)}>
              {x.month} {x.status === 'FINALIZED' ? '✓ 已結算' : '草稿'}
            </Button>
          ))}
        </div>
      )}

      {!detail || !r ? (
        <EmptyState icon="💰" title="選擇月份後建立或開啟薪資批次" />
      ) : (
        <>
          <div className="payroll__head">
            <span>
              <strong>{r.month}</strong>{' '}
              <Badge tone={draft ? 'warning' : 'success'} dot>{draft ? '草稿' : '已結算'}</Badge>{' '}
              {r.itemCount} 人
            </span>
            <span className="text-muted text-sm">
              計算於 {shortDateTime(r.calculatedAt)}
              {r.finalizedAt && `｜結算於 ${shortDateTime(r.finalizedAt)}`}
            </span>
            <span className="payroll__actions">
              {draft && (
                <>
                  <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(() => payrollRunAction(r.id, 'recalculate'), '重新計算失敗')}>
                    重新計算
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || !pendingTotal}
                    onClick={() => void run(() => decideRunOvertime(r.id, 'SUGGESTED'), '核定失敗')}
                  >
                    未核定加班全依建議（{pendingTotal}）
                  </Button>
                  <Button
                    size="sm"
                    loading={busy}
                    onClick={() => {
                      if (window.confirm(`結算 ${r.month} 薪資並通知 ${r.itemCount} 位員工？`)) {
                        void run(() => payrollRunAction(r.id, 'finalize'), '結算失敗');
                      }
                    }}
                  >
                    結算並通知
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void onDelete()}>刪除草稿</Button>
                </>
              )}
              {!draft && (
                <Button size="sm" variant="secondary" onClick={() => setReopening(true)}>撤銷結算</Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={!detail.table.rows.length}
                onClick={() => downloadCsv(`payroll-${r.month}.csv`, detail.table.columns, detail.table.rows)}
              >
                下載 CSV
              </Button>
            </span>
          </div>

          <div className="payroll__totals">
            <div className="payroll__total"><span>應發合計</span><strong>{formatMoney(r.grossPay)}</strong></div>
            <div className="payroll__total"><span>應扣合計</span><strong>{formatMoney(r.deductionTotal)}</strong></div>
            <div className="payroll__total"><span>實發合計</span><strong>{formatMoney(r.netPay)}</strong></div>
            <div className="payroll__total"><span>雇主總成本</span><strong>{formatMoney(r.employerCost)}</strong></div>
          </div>

          {r.warnings.map((w) => (
            <Alert key={w.code + w.message} tone={w.blocking ? 'error' : 'warning'}>{w.message}</Alert>
          ))}

          {detail.items.length === 0 ? (
            <EmptyState icon="🧾" title="本月沒有薪資單" desc="請先至「薪資設定」為員工設定薪資後重新計算" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>員工</th>
                    <th>分店</th>
                    <th>計薪</th>
                    <th className="payroll__num">應發</th>
                    <th className="payroll__num">應扣</th>
                    <th className="payroll__num">實發</th>
                    <th className="payroll__num">雇主成本</th>
                    <th>提醒</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.name}
                        <div className="text-muted text-sm">{i.position}</div>
                      </td>
                      <td className="text-sm">{i.branchName ?? '跨店'}</td>
                      <td className="text-sm">{detail.meta.payTypes[i.profile.payType]}</td>
                      <td className="payroll__num">{formatMoney(i.grossPay)}</td>
                      <td className="payroll__num">{formatMoney(i.deductionTotal)}</td>
                      <td className="payroll__num"><strong>{formatMoney(i.netPay)}</strong></td>
                      <td className="payroll__num">{formatMoney(i.employerCost)}</td>
                      <td><WarningBadges warnings={i.warnings} /></td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => setOpenItemId(i.id)}>
                          {draft && pendingOt(i) ? '核定' : '明細'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {r.history.length > 0 && (
            <details className="text-sm">
              <summary>批次紀錄（{r.history.length}）</summary>
              <ul>
                {r.history.map((h, idx) => (
                  <li key={idx}>
                    {shortDateTime(h.at)}｜{{ RECALCULATE: '計算', FINALIZE: '結算', REOPEN: '撤銷結算' }[h.action] ?? h.action}
                    {h.byStaffId ? `｜經辦 #${h.byStaffId}` : ''}
                    {h.reason ? `｜原因：${h.reason}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {detail && openItem && (
        <PayrollItemModal
          key={`${openItem.id}-${version}`}
          detail={detail}
          item={openItem}
          busy={busy}
          onRun={run}
          onClose={() => setOpenItemId(null)}
        />
      )}

      {reopening && r && (
        <ReasonModal
          title={`撤銷 ${r.month} 結算`}
          label="撤銷原因"
          confirmLabel="撤銷結算"
          danger
          onClose={() => setReopening(false)}
          onSubmit={(reason) => run(() => reopenPayrollRun(r.id, reason), '撤銷結算失敗')}
        >
          <p className="text-sm">撤銷後員工暫時看不到本月薪資單，並會收到「重新核算中」通知；修正後須重新結算。</p>
        </ReasonModal>
      )}
    </Card>
  );
}

function PayrollItemModal({
  detail,
  item,
  busy,
  onRun,
  onClose,
}: {
  detail: PayrollRunDetail;
  item: PayrollItemData;
  busy: boolean;
  onRun: (action: () => Promise<ApiResponse<PayrollRunDetail>>, fallback: string, silent?: boolean) => Promise<boolean>;
  onClose: () => void;
}) {
  const runId = detail.run.id;
  const draft = detail.run.status === 'DRAFT';
  const f = item.facts;
  const [otDraft, setOtDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(item.overtime.map((o) => [o.key, o.approvedMinutes === null ? '' : String(o.approvedMinutes)])),
  );
  const [adjType, setAdjType] = useState<PayrollAdjustmentType>('BONUS');
  const [adjAmount, setAdjAmount] = useState('');
  const [adjLabel, setAdjLabel] = useState('');
  const [adjNote, setAdjNote] = useState('');

  const leaveText = Object.entries(f.leaveHours || {})
    .filter(([, h]) => h > 0)
    .map(([k, h]) => `${detail.meta.leaveTypes[k] ?? k} ${h}h`)
    .join('、');

  function saveOvertime() {
    const decisions = item.overtime
      .filter((o) => otDraft[o.key] !== (o.approvedMinutes === null ? '' : String(o.approvedMinutes)))
      .map((o) => ({ key: o.key, approvedMinutes: otDraft[o.key] === '' ? null : Number(otDraft[o.key]) }));
    if (!decisions.length) return;
    void onRun(() => decideItemOvertime(runId, item.id, { decisions }), '核定加班失敗');
  }

  function addAdjustment(e: FormEvent) {
    e.preventDefault();
    const amount = Number(adjAmount);
    if (!amount) return;
    void onRun(
      () =>
        addPayrollAdjustment(runId, item.id, {
          type: adjType,
          amount,
          label: adjLabel.trim() || undefined,
          note: adjNote.trim() || undefined,
        }),
      '新增手動項失敗',
    );
  }

  return (
    <Modal open wide title={`${item.name}｜${detail.run.month} 薪資單`} onClose={onClose}>
      <div className="hr-panel__chips">
        <Badge>{detail.meta.payTypes[item.profile.payType]}</Badge>
        <Badge>在職 {f.employedDays}/{f.daysInMonth} 日</Badge>
        <Badge>排班 {f.scheduledShifts} 班</Badge>
        <Badge>實際工時 {formatMinutes(f.workedMinutes)}</Badge>
        <Badge tone={f.lateCount + f.earlyCount ? 'warning' : 'neutral'}>
          遲到早退 {f.lateCount + f.earlyCount} 次／{f.lateMinutes + f.earlyMinutes} 分
        </Badge>
        <Badge tone={f.absentShifts ? 'danger' : 'neutral'}>曠職 {f.absentShifts} 班／{formatMinutes(f.absentMinutes)}</Badge>
        {f.missedPunchOut + f.open > 0 && <Badge tone="danger">未打下班卡／上班中 {f.missedPunchOut + f.open}</Badge>}
        {f.performance && (
          <Badge tone="info">
            教練業績獎金 {formatMoney(f.performance.total)}（私教 {f.performance.ptSessions} 堂・團課 {f.performance.groupHeads} 人次）
          </Badge>
        )}
      </div>
      {leaveText && <p className="text-sm">已核准請假：{leaveText}</p>}
      {item.warnings.map((w) => (
        <Alert key={w.code + w.message} tone={w.blocking ? 'error' : 'warning'}>{w.message}</Alert>
      ))}

      <h4>加班核定</h4>
      {item.overtime.length === 0 ? (
        <p className="text-muted text-sm">本月無加班建議</p>
      ) : (
        <>
          <p className="text-muted text-sm">核定分鐘上限為建議值；0＝不計加班費，留空＝尚未核定（不可結算）。倍率依勞基法 §24／§39／§40 由系統計算。</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>類別</th>
                  <th>建議</th>
                  <th>核定（分）</th>
                </tr>
              </thead>
              <tbody>
                {item.overtime.map((o) => (
                  <tr key={o.key}>
                    <td className="mono">{o.date}（{weekdayLabel(o.date)}）</td>
                    <td>{detail.meta.overtimeKinds[o.kind]}</td>
                    <td>{formatMinutes(o.suggestedMinutes)}</td>
                    <td>
                      {draft ? (
                        <Input
                          className="payroll__ot-input"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={o.suggestedMinutes}
                          value={otDraft[o.key] ?? ''}
                          placeholder="未核定"
                          onChange={(e) => setOtDraft((d) => ({ ...d, [o.key]: e.target.value }))}
                        />
                      ) : o.approvedMinutes === null ? (
                        '—'
                      ) : (
                        formatMinutes(o.approvedMinutes)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {draft && (
            <div className="roster__toolbar">
              <Button size="sm" loading={busy} onClick={saveOvertime}>儲存核定</Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onRun(() => decideItemOvertime(runId, item.id, { mode: 'SUGGESTED' }), '核定失敗')}>
                未核定者依建議
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onRun(() => decideItemOvertime(runId, item.id, { mode: 'REJECT' }), '核定失敗')}>
                未核定者不計
              </Button>
            </div>
          )}
        </>
      )}

      <h4>手動項（獎金、津貼、所得稅扣繳等）</h4>
      {item.adjustments.length === 0 && <p className="text-muted text-sm">無</p>}
      {item.adjustments.map((a) => (
        <div key={a.id} className="payslip__row">
          <span>
            {a.label}
            <span className="text-muted text-sm">（{detail.meta.adjustmentTypes[a.type]?.kind === 'DEDUCTION' ? '扣' : '加'}）{a.note ? `｜${a.note}` : ''}</span>
          </span>
          <span>
            <span className="payroll__num">{formatMoney(a.amount)}</span>{' '}
            {draft && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onRun(() => removePayrollAdjustment(runId, item.id, a.id), '刪除失敗')}>
                刪除
              </Button>
            )}
          </span>
        </div>
      ))}
      {draft && (
        <form className="payroll__form" onSubmit={addAdjustment}>
          <Field label="類型">
            <Select value={adjType} onChange={(e) => setAdjType(e.target.value as PayrollAdjustmentType)}>
              {(Object.keys(detail.meta.adjustmentTypes) as PayrollAdjustmentType[]).map((t) => (
                <option key={t} value={t}>{detail.meta.adjustmentTypes[t].label}</option>
              ))}
            </Select>
          </Field>
          <Field label="金額（元）">
            <Input type="number" inputMode="numeric" min={1} value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} required />
          </Field>
          <Field label="名稱（選填）">
            <Input value={adjLabel} maxLength={30} onChange={(e) => setAdjLabel(e.target.value)} />
          </Field>
          <Field label="備註（僅總部可見）">
            <Input value={adjNote} maxLength={200} onChange={(e) => setAdjNote(e.target.value)} />
          </Field>
          <Button type="submit" size="sm" loading={busy}>新增</Button>
        </form>
      )}

      <h4>薪資明細</h4>
      <PayslipLines lines={item.lines} grossPay={item.grossPay} deductionTotal={item.deductionTotal} netPay={item.netPay} />
      <p className="text-muted text-sm">雇主總成本 {formatMoney(item.employerCost)}（應發＋雇主負擔勞健保／勞退）</p>
    </Modal>
  );
}
