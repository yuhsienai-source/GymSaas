import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Field, Input } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createHqHoliday,
  deleteHqHoliday,
  fetchHqHolidays,
  getErrorMessage,
  renameHqHoliday,
  seedHqDefaultHolidays,
} from '../../../lib/api';
import { weekdayLabel } from '../../../lib/hrFormat';
import { taipeiToday } from '../../../lib/laborLaw';
import type { HolidayCalendar, PublicHoliday } from '../../../types/api';

/** 國定假日曆：影響正職國休額度（§37）與四週排班國定假日提示 */
export default function HqHolidayPanel({ onReload }: { onReload: () => Promise<void> }) {
  const { toast } = useToast();
  const [year, setYear] = useState(() => Number(taipeiToday().slice(0, 4)));
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<HolidayCalendar | null>(null);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchHqHolidays(year)
      .then((res) => {
        if (!cancelled) setData(res.data ?? null);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入國定假日失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [year, reloadKey, toast]);

  function changed() {
    setReloadKey((k) => k + 1);
    void onReload();
  }

  async function guarded(fn: () => Promise<void>) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!date || !name.trim()) return;
    void guarded(async () => {
      try {
        const res = await createHqHoliday({ date, name: name.trim() });
        toast(res.message || '已新增', 'success');
        setDate('');
        setName('');
        changed();
      } catch (err) {
        toast(getErrorMessage(err, '新增國定假日失敗'), 'error');
      }
    });
  }

  function onSeed() {
    void guarded(async () => {
      try {
        const res = await seedHqDefaultHolidays(year);
        toast(res.message || '已補入', 'success');
        changed();
      } catch (err) {
        toast(getErrorMessage(err, '補入預設失敗'), 'error');
      }
    });
  }

  const hasDefaults = data?.defaultYears.includes(year) ?? false;
  const shownYear = data?.year === year ? data : null;

  return (
    <>
      <Card title="國定假日曆" className="hr-panel__card">
        <p className="text-muted text-sm">
          勞基法 §37：正職國休總數＝當年度到職日後之國定假日；國定假日出勤依 §39 加倍發給工資，或經勞工同意與其他工作日對調。
          農曆節日每年不同，請於年底前建立次年假日。刪除或新增會即時影響國休額度與排班提示。
        </p>
        <div className="roster__toolbar">
          <Button size="sm" variant="secondary" onClick={() => setYear((y) => y - 1)} aria-label="上一年">‹</Button>
          <strong className="hr-holiday__year">{year} 年</strong>
          <Button size="sm" variant="secondary" onClick={() => setYear((y) => y + 1)} aria-label="下一年">›</Button>
          {shownYear && <span className="text-sm">共 {shownYear.holidays.length} 日</span>}
          {shownYear && shownYear.missingDefaults > 0 && (
            <Button size="sm" variant="secondary" loading={busy} onClick={onSeed}>
              補入 {year} 年內建預設（{shownYear.missingDefaults} 筆）
            </Button>
          )}
          {shownYear && !hasDefaults && <span className="text-muted text-sm">尚無 {year} 年內建預設，請手動建立</span>}
        </div>
        <form onSubmit={onAdd} className="hr-holiday-form">
          <Field label="日期">
            <Input
              type="date"
              value={date}
              min={`${year}-01-01`}
              max={`${year}-12-31`}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <Field label="名稱">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} required />
          </Field>
          <Button type="submit" loading={busy}>新增</Button>
        </form>
      </Card>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>星期</th>
              <th>名稱</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shownYear?.holidays.map((h) => <HolidayRow key={h.id} holiday={h} onChanged={changed} />)}
            {shownYear && shownYear.holidays.length === 0 && (
              <tr>
                <td colSpan={4} className="text-muted text-center">{year} 年尚未設定國定假日</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HolidayRow({ holiday, onChanged }: { holiday: PublicHoliday; onChanged: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(holiday.name);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await renameHqHoliday(holiday.id, name.trim());
      setEditing(false);
      onChanged();
    } catch (err) {
      toast(getErrorMessage(err, '更新失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const warn = holiday.past ? '\n此日已過，刪除會減少員工本年度國休額度。' : '';
    if (!window.confirm(`刪除 ${holiday.date} ${holiday.name}？${warn}`)) return;
    try {
      await deleteHqHoliday(holiday.id);
      onChanged();
    } catch (err) {
      toast(getErrorMessage(err, '刪除失敗'), 'error');
    }
  }

  const weekend = holiday.weekday === 0 || holiday.weekday === 6;
  return (
    <tr className={holiday.past ? 'text-muted' : undefined}>
      <td className="mono">{holiday.date}</td>
      <td>{weekend ? <Badge tone="info">{weekdayLabel(holiday.weekday)}</Badge> : weekdayLabel(holiday.weekday)}</td>
      <td>
        {editing ? (
          <span className="hr-holiday__edit">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} autoFocus />
            <Button size="sm" loading={busy} onClick={() => void save()}>儲存</Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(holiday.name);
                setEditing(false);
              }}
            >
              取消
            </Button>
          </span>
        ) : (
          holiday.name
        )}
      </td>
      <td className="hr-panel__actions">
        {!editing && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>改名</Button>
            <Button size="sm" variant="ghost" onClick={() => void remove()}>刪除</Button>
          </>
        )}
      </td>
    </tr>
  );
}
