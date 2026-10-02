import { type FormEvent, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select } from '../../ui';
import {
  createTrainerTimeOff,
  deleteTrainerTimeOff,
  getErrorMessage,
} from '../../../lib/api';
import { useToast } from '../../../contexts/ToastContext';
import type { TrainerTimeOff } from '../../../types/api';
import { formatTimeRange } from './trainerFormat';

type Props = {
  items: TrainerTimeOff[];
  reasons?: string[];
  viewAsTrainerId?: number | '';
  onChanged: () => Promise<void> | void;
};

function toLocalInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultRange() {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const end = new Date(start);
  end.setHours(end.getHours() + 2);
  return { start: toLocalInputValue(start), end: toLocalInputValue(end) };
}

/** 工時內不開放預約（行政／備課等）；休假一律走請假或週班表例假／休息日 */
export default function TrainerTimeOffPanel({
  items,
  reasons = ['行政作業', '備課', '外出公務', '其他'],
  viewAsTrainerId,
  onChanged,
}: Props) {
  const { toast } = useToast();
  const defaults = useMemo(() => defaultRange(), []);
  const [startAt, setStartAt] = useState(defaults.start);
  const [endAt, setEndAt] = useState(defaults.end);
  const [reason, setReason] = useState(reasons[0] || '行政作業');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);

  const [nowMs] = useState(() => Date.now());

  const upcoming = useMemo(() => {
    return [...items]
      .filter((t) => new Date(t.endAt).getTime() >= nowMs)
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  }, [items, nowMs]);

  const past = useMemo(() => {
    return [...items]
      .filter((t) => new Date(t.endAt).getTime() < nowMs)
      .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())
      .slice(0, 8);
  }, [items, nowMs]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    try {
      const res = await createTrainerTimeOff({
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(endAt).toISOString(),
        reason,
        note: note.trim() || undefined,
        viewAsTrainerId: viewAsTrainerId === '' ? undefined : viewAsTrainerId,
        trainerId: viewAsTrainerId === '' ? undefined : viewAsTrainerId,
      });
      toast(res.message || '已登記不開放預約時段', 'success');
      setNote('');
      await onChanged();
    } catch (err) {
      toast(getErrorMessage(err, '新增失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm('確定取消此不開放預約時段？')) return;
    setBusy(true);
    try {
      const res = await deleteTrainerTimeOff(
        id,
        viewAsTrainerId === '' ? undefined : Number(viewAsTrainerId),
      );
      toast(res.message || '已取消', 'success');
      await onChanged();
    } catch (err) {
      toast(getErrorMessage(err, '取消失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-stack coach-timeoff">
      <Alert tone="info">
        可預約時段＝已核准之週班表出勤時段 − 已核准請假 − 此處登記之不開放預約時段（行政、備課、外出公務等仍屬工作時間）。
        休假請於「我的出勤」申請請假，或於「我的排班」週班表指定例假／休息日。與既有課程重疊時無法登錄。
      </Alert>

      <Card title="新增不開放預約時段" subtitle="單筆最長 24 小時">
        <form onSubmit={handleCreate} className="form-stack">
          <Field label="開始">
            <Input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} required />
          </Field>
          <Field label="結束">
            <Input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} required />
          </Field>
          <Field label="原因">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="備註（選填）">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例：月會、器材盤點、外出研習"
              maxLength={200}
            />
          </Field>
          <Button type="submit" loading={busy} disabled={busy}>
            登記
          </Button>
        </form>
      </Card>

      <Card title="即將到來的不開放預約時段" subtitle={`${upcoming.length} 筆`}>
        {upcoming.length === 0 ? (
          <EmptyState icon="🗂️" title="目前沒有不開放預約時段" desc="登錄後，排課與會員預約會自動避開" />
        ) : (
          <ul className="coach-timeoff__list">
            {upcoming.map((t) => (
              <li key={t.id} className="coach-timeoff__item">
                <div>
                  <div className="coach-timeoff__item-head">
                    <Badge tone="warning">{t.reason}</Badge>
                    <strong>{formatTimeRange(t.startAt, t.endAt)}</strong>
                  </div>
                  {t.note ? <p className="text-sm text-muted">{t.note}</p> : null}
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void handleDelete(t.id)}
                >
                  取消
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {past.length > 0 ? (
        <Card title="近期已結束" subtitle="僅供查閱">
          <ul className="coach-timeoff__list">
            {past.map((t) => (
              <li key={t.id} className="coach-timeoff__item coach-timeoff__item--past">
                <div>
                  <Badge tone="neutral">{t.reason}</Badge>
                  <div className="text-sm">{formatTimeRange(t.startAt, t.endAt)}</div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
