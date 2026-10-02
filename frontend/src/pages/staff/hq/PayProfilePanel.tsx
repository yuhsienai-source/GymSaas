import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import { deletePayProfile, fetchPayProfiles, getErrorMessage, savePayProfile } from '../../../lib/api';
import { formatMoney } from '../../../lib/hrFormat';
import type { PayAllowance, PayProfileList, PayProfileRow, PayType } from '../../../types/api';

/** 員工薪資設定：計薪方式、固定津貼、勞健保投保與勞退提繳（僅 HQ ADMIN） */
export default function PayProfilePanel() {
  const { toast } = useToast();
  const [data, setData] = useState<PayProfileList | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [q, setQ] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [editing, setEditing] = useState<PayProfileRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPayProfiles()
      .then((res) => {
        if (!cancelled) setData(res.data ?? null);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入薪資設定失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (data?.items ?? []).filter(
      (r) => (!onlyMissing || !r.profile) && (!kw || r.name.toLowerCase().includes(kw) || r.account.toLowerCase().includes(kw)),
    );
  }, [data, q, onlyMissing]);
  const missing = (data?.items ?? []).filter((r) => !r.profile && r.isActive).length;

  return (
    <Card title="薪資設定" className="hr-panel__card">
      <p className="text-muted text-sm">
        設定月薪／時薪、固定津貼、勞保投保薪資、健保投保金額與眷屬人數、勞退提繳工資與自提比例；投保級距請依勞保局／健保署分級表填寫。
        教練底薪一律設於此處（正職須月薪制且 ≥ 基本工資；兼職時薪 ≥ 基本時薪），業績獎金由「教練業績」規則另計、不得替代底薪。
      </p>
      <div className="roster__toolbar">
        <Field label="搜尋">
          <Input value={q} placeholder="姓名／帳號" onChange={(e) => setQ(e.target.value)} />
        </Field>
        <label className="text-sm">
          <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> 只看未設定
        </label>
        {missing > 0 && <Badge tone="warning">{missing} 位在職員工未設定</Badge>}
      </div>
      {!data ? (
        <p className="text-muted">載入中…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon="👥" title="沒有符合的員工" />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>員工</th>
                <th>分店／型態</th>
                <th>到職日</th>
                <th>計薪</th>
                <th className="payroll__num">勞保</th>
                <th className="payroll__num">健保（眷）</th>
                <th className="payroll__num">勞退（自提）</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = r.profile;
                return (
                  <tr key={r.staffId}>
                    <td>
                      {r.name}
                      {!r.isActive && <Badge tone="neutral">停用</Badge>}
                      <div className="text-muted text-sm">{r.position}</div>
                    </td>
                    <td className="text-sm">
                      {r.branchName ?? '跨店'}／{r.employmentLabel}
                      {!r.laborActApplies && <div className="text-muted">不適用勞基法</div>}
                    </td>
                    <td className="mono text-sm">{r.hireDate ?? '—'}</td>
                    <td>
                      {!p ? (
                        <Badge tone="warning">未設定</Badge>
                      ) : p.payType === 'MONTHLY' ? (
                        `月薪 ${formatMoney(p.monthlySalary)}`
                      ) : (
                        `時薪 ${formatMoney(p.hourlyWage)}`
                      )}
                      {p?.allowances?.length ? <div className="text-muted text-sm">津貼 {p.allowances.length} 項</div> : null}
                    </td>
                    <td className="payroll__num">{p ? formatMoney(p.laborInsuredSalary) : ''}</td>
                    <td className="payroll__num">{p ? `${formatMoney(p.healthInsuredSalary)}（${p.healthDependents}）` : ''}</td>
                    <td className="payroll__num">{p ? `${formatMoney(p.pensionWage)}（${Math.round(p.pensionSelfRate * 1000) / 10}%）` : ''}</td>
                    <td>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>{p ? '編輯' : '設定'}</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ProfileModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </Card>
  );
}

const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

function ProfileModal({ row, onClose, onSaved }: { row: PayProfileRow; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const p = row.profile;
  const [payType, setPayType] = useState<PayType>(p?.payType ?? (row.employmentType === 'FULL_TIME' ? 'MONTHLY' : 'HOURLY'));
  const [monthly, setMonthly] = useState(str(p?.monthlySalary));
  const [hourly, setHourly] = useState(str(p?.hourlyWage));
  const [allowances, setAllowances] = useState<{ label: string; amount: string }[]>(
    (p?.allowances ?? []).map((a: PayAllowance) => ({ label: a.label, amount: String(a.amount) })),
  );
  const [labor, setLabor] = useState(str(p?.laborInsuredSalary));
  const [health, setHealth] = useState(str(p?.healthInsuredSalary));
  const [deps, setDeps] = useState(str(p?.healthDependents ?? 0));
  const [pension, setPension] = useState(str(p?.pensionWage));
  const [selfPct, setSelfPct] = useState(p ? String(Math.round(p.pensionSelfRate * 1000) / 10) : '0');
  const [note, setNote] = useState(p?.note ?? '');
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await savePayProfile(row.staffId, {
        payType,
        monthlySalary: payType === 'MONTHLY' ? numOrNull(monthly) : null,
        hourlyWage: payType === 'HOURLY' ? numOrNull(hourly) : null,
        allowances: allowances.filter((a) => a.label.trim() || a.amount.trim()).map((a) => ({ label: a.label.trim(), amount: Number(a.amount) })),
        laborInsuredSalary: numOrNull(labor),
        healthInsuredSalary: numOrNull(health),
        healthDependents: Number(deps) || 0,
        pensionWage: numOrNull(pension),
        pensionSelfRate: (Number(selfPct) || 0) / 100,
        note: note.trim() || null,
      });
      toast(res.message || '已儲存', 'success');
      onSaved();
    } catch (err) {
      toast(getErrorMessage(err, '儲存失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`刪除 ${row.name} 的薪資設定？（已建立之薪資批次不受影響，重算時將移除）`)) return;
    try {
      const res = await deletePayProfile(row.staffId);
      toast(res.message || '已刪除', 'success');
      onSaved();
    } catch (err) {
      toast(getErrorMessage(err, '刪除失敗'), 'error');
    }
  }

  return (
    <Modal open wide title={`${row.name}｜薪資設定`} onClose={onClose}>
      <p className="text-muted text-sm">
        {row.employmentLabel}
        {row.weeklyHours ? `｜約定週工時 ${row.weeklyHours}h` : ''}｜到職 {row.hireDate ?? '未設定'}
      </p>
      <form onSubmit={submit}>
        <div className="payroll__form">
          <Field label="計薪方式">
            <Select value={payType} onChange={(e) => setPayType(e.target.value as PayType)}>
              <option value="MONTHLY">月薪</option>
              <option value="HOURLY">時薪</option>
            </Select>
          </Field>
          {payType === 'MONTHLY' ? (
            <Field label="月薪（元）">
              <Input type="number" inputMode="numeric" min={1} value={monthly} onChange={(e) => setMonthly(e.target.value)} required />
            </Field>
          ) : (
            <Field label="時薪（元）">
              <Input type="number" inputMode="numeric" min={1} value={hourly} onChange={(e) => setHourly(e.target.value)} required />
            </Field>
          )}
          <Field label="勞保投保薪資" hint="留空＝未投保">
            <Input type="number" inputMode="numeric" min={1} value={labor} onChange={(e) => setLabor(e.target.value)} />
          </Field>
          <Field label="健保投保金額" hint="留空＝不在本公司投保">
            <Input type="number" inputMode="numeric" min={1} value={health} onChange={(e) => setHealth(e.target.value)} />
          </Field>
          <Field label="健保眷屬人數" hint="自付計費上限 3 口">
            <Input type="number" inputMode="numeric" min={0} max={10} value={deps} onChange={(e) => setDeps(e.target.value)} />
          </Field>
          <Field label="勞退月提繳工資" hint="留空＝不提繳">
            <Input type="number" inputMode="numeric" min={1} value={pension} onChange={(e) => setPension(e.target.value)} />
          </Field>
          <Field label="勞退自提（%）" hint="0～6">
            <Input type="number" inputMode="decimal" min={0} max={6} step={0.5} value={selfPct} onChange={(e) => setSelfPct(e.target.value)} />
          </Field>
        </div>

        <h4>固定津貼</h4>
        {allowances.map((a, idx) => (
          <div key={idx} className="payroll__allowance">
            <Field label="名稱">
              <Input value={a.label} maxLength={30} onChange={(e) => setAllowances((xs) => xs.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))} />
            </Field>
            <Field label="金額">
              <Input type="number" inputMode="numeric" min={1} value={a.amount} onChange={(e) => setAllowances((xs) => xs.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))} />
            </Field>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAllowances((xs) => xs.filter((_, i) => i !== idx))}>移除</Button>
          </div>
        ))}
        {allowances.length < 10 && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setAllowances((xs) => [...xs, { label: '', amount: '' }])}>
            ＋ 新增津貼
          </Button>
        )}

        <Field label="備註">
          <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="roster__toolbar">
          <Button type="submit" loading={busy}>儲存</Button>
          {p && (
            <Button type="button" variant="ghost" onClick={() => void remove()}>刪除設定</Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
