import { useMemo, useState } from 'react';
import { Button, Modal } from '../../ui';
import { getErrorMessage, rescheduleTrainerClass } from '../../../lib/api';
import { useToast } from '../../../contexts/ToastContext';
import type { TrainerDashboardClass } from '../../../types/api';

type Props = {
  classes: TrainerDashboardClass[];
  viewAsTrainerId?: number;
  onChanged: () => Promise<void> | void;
  onSelect?: (c: TrainerDashboardClass) => void;
};

const HOURS = Array.from({ length: 14 }, (_, i) => i + 8); // 08–21
const DAY_MS = 86_400_000;

/** 以台北日曆解出年月日（避免瀏覽器時區漂移） */
function taipeiParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  // en-CA weekday: Mon/Tue...
  const wdMap: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    weekday: wdMap[parts.weekday] ?? 0,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function ymdTaipei(d: Date) {
  return taipeiParts(d).ymd;
}

/** 回傳該台北日 00:00+08 的 Date（UTC 瞬間） */
function taipeiMidnightUtc(ymd: string) {
  return new Date(`${ymd}T00:00:00+08:00`);
}

function startOfWeekTaipei(d: Date) {
  const p = taipeiParts(d);
  const midnight = taipeiMidnightUtc(p.ymd);
  return new Date(midnight.getTime() - p.weekday * DAY_MS);
}

function hourMinuteTaipei(iso: string) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [hh, mm] = fmt.format(d).split(':').map(Number);
  return { hh, mm };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && aEnd > bStart;
}

function toDropIso(weekStart: Date, dayIndex: number, hour: number, minute = 0) {
  const day = new Date(weekStart.getTime() + dayIndex * DAY_MS);
  const ymd = ymdTaipei(day);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${ymd}T${hh}:${mm}:00+08:00`;
}

export default function TrainerWeekCalendar({
  classes,
  viewAsTrainerId,
  onChanged,
  onSelect,
}: Props) {
  const { toast } = useToast();
  const [weekAnchor, setWeekAnchor] = useState(() => startOfWeekTaipei(new Date()));
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [hoverCell, setHoverCell] = useState<{ day: number; hour: number; bad: boolean } | null>(
    null,
  );
  const [pending, setPending] = useState<{
    cls: TrainerDashboardClass;
    startAt: string;
    endAt: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const [{ dataMin, dataMax }] = useState(() => {
    const now = Date.now();
    return {
      dataMin: startOfWeekTaipei(new Date(now - DAY_MS)).getTime(), // 允許今天稍早
      dataMax: now + 14 * DAY_MS,
    };
  });

  const weekStart = useMemo(() => startOfWeekTaipei(weekAnchor), [weekAnchor]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS)),
    [weekStart],
  );

  const canPrev = weekStart.getTime() > dataMin;
  const canNext = weekStart.getTime() + 7 * DAY_MS < dataMax;

  const weekClasses = useMemo(() => {
    const start = weekStart.getTime();
    const end = start + 7 * DAY_MS;
    return classes.filter((c) => {
      const t = new Date(c.startAt).getTime();
      return t >= start && t < end;
    });
  }, [classes, weekStart]);

  function cellConflict(dayIndex: number, hour: number, minute: number, excludeId: number | null, durationMs: number) {
    const startIso = toDropIso(weekStart, dayIndex, hour, minute);
    const start = new Date(startIso).getTime();
    const end = start + durationMs;
    return weekClasses.some((c) => {
      if (excludeId != null && c.id === excludeId) return false;
      return overlaps(start, end, new Date(c.startAt).getTime(), new Date(c.endAt).getTime());
    });
  }

  function eventsForCell(dayIndex: number, hour: number) {
    const dayStr = ymdTaipei(days[dayIndex]);
    return weekClasses.filter((c) => {
      const { hh } = hourMinuteTaipei(c.startAt);
      return ymdTaipei(new Date(c.startAt)) === dayStr && hh === hour;
    });
  }

  function dragMinute(cls: TrainerDashboardClass) {
    return hourMinuteTaipei(cls.startAt).mm || 0;
  }

  async function confirmMove() {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await rescheduleTrainerClass(pending.cls.id, {
        startAt: pending.startAt,
        endAt: pending.endAt,
        viewAsTrainerId,
      });
      if (res.status === 'success') {
        toast(res.message || '已改期', 'success');
        setPending(null);
        await onChanged();
      } else {
        toast(res.message || '改期失敗', 'error');
      }
    } catch (err) {
      toast(getErrorMessage(err, '改期失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const dayLabels = ['一', '二', '三', '四', '五', '六', '日'];

  return (
    <div className="trainer-cal">
      <div className="trainer-cal__toolbar">
        <div className="btn-row">
          <Button
            variant="secondary"
            size="sm"
            disabled={!canPrev}
            onClick={() => setWeekAnchor(new Date(weekStart.getTime() - 7 * DAY_MS))}
          >
            上週
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setWeekAnchor(startOfWeekTaipei(new Date()))}
          >
            本週
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!canNext}
            onClick={() => setWeekAnchor(new Date(weekStart.getTime() + 7 * DAY_MS))}
          >
            下週
          </Button>
        </div>
        <strong>
          {ymdTaipei(days[0])} — {ymdTaipei(days[6])}
        </strong>
      </div>

      <div className="trainer-cal__legend">
        <span>僅顯示儀表板載入的未來約 14 天 · 拖曳私教／諮詢改時（保留原分鐘）· 衝突格變紅</span>
      </div>

      <div className="trainer-cal__grid" role="grid" aria-label="週課表">
        <div className="trainer-cal__corner" />
        {days.map((d, i) => (
          <div key={i} className="trainer-cal__dayhead">
            {dayLabels[i]}
            <br />
            {ymdTaipei(d).slice(5)}
          </div>
        ))}

        {HOURS.map((hour) => (
          <div key={`row-${hour}`} style={{ display: 'contents' }}>
            <div className="trainer-cal__hour">{String(hour).padStart(2, '0')}:00</div>
            {days.map((_, dayIndex) => {
              const events = eventsForCell(dayIndex, hour);
              const isHover =
                hoverCell?.day === dayIndex && hoverCell?.hour === hour && draggingId != null;
              return (
                <div
                  key={`${dayIndex}-${hour}`}
                  className={`trainer-cal__cell${
                    isHover ? (hoverCell?.bad ? ' is-drop-bad' : ' is-drop-ok') : ''
                  }`}
                  onDragOver={(e) => {
                    if (draggingId == null) return;
                    e.preventDefault();
                    const cls = weekClasses.find((c) => c.id === draggingId);
                    if (!cls) return;
                    const dur =
                      new Date(cls.endAt).getTime() - new Date(cls.startAt).getTime();
                    const minute = dragMinute(cls);
                    const bad = cellConflict(dayIndex, hour, minute, draggingId, dur);
                    setHoverCell((prev) => {
                      if (
                        prev &&
                        prev.day === dayIndex &&
                        prev.hour === hour &&
                        prev.bad === bad
                      ) {
                        return prev;
                      }
                      return { day: dayIndex, hour, bad };
                    });
                    e.dataTransfer.dropEffect = bad ? 'none' : 'move';
                  }}
                  onDragLeave={() => {
                    setHoverCell((h) =>
                      h?.day === dayIndex && h.hour === hour ? null : h,
                    );
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = Number(e.dataTransfer.getData('text/class-id') || draggingId);
                    setHoverCell(null);
                    setDraggingId(null);
                    const cls = weekClasses.find((c) => c.id === id);
                    if (!cls) return;
                    if (cls.type === 'GROUP') {
                      toast('團課請至總部期班調整，不支援拖拉改期', 'info');
                      return;
                    }
                    const dur =
                      new Date(cls.endAt).getTime() - new Date(cls.startAt).getTime();
                    const minute = dragMinute(cls);
                    if (cellConflict(dayIndex, hour, minute, id, dur)) {
                      toast('此時段與其他課程衝突', 'error');
                      return;
                    }
                    const startAt = toDropIso(weekStart, dayIndex, hour, minute);
                    const endAt = new Date(new Date(startAt).getTime() + dur).toISOString();
                    setPending({ cls, startAt, endAt });
                  }}
                >
                  {events.map((c) => {
                    const typeClass =
                      c.type === 'GROUP'
                        ? ' trainer-cal__event--group'
                        : c.type === 'CONSULT'
                          ? ' trainer-cal__event--consult'
                          : '';
                    return (
                      <div
                        key={c.id}
                        className={`trainer-cal__event${typeClass}`}
                        draggable={c.type !== 'GROUP'}
                        title={c.title}
                        onClick={() => onSelect?.(c)}
                        onDragStart={(e) => {
                          if (c.type === 'GROUP') {
                            e.preventDefault();
                            return;
                          }
                          setDraggingId(c.id);
                          e.dataTransfer.setData('text/class-id', String(c.id));
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => {
                          setDraggingId(null);
                          setHoverCell(null);
                        }}
                      >
                        {c.title}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <Modal
        open={Boolean(pending)}
        title="確認改期"
        onClose={() => {
          if (!busy) setPending(null);
        }}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setPending(null)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void confirmMove()}>
              {busy ? '更新中…' : '確認移動'}
            </Button>
          </>
        }
      >
        {pending ? (
          <p>
            將「{pending.cls.title}」移至{' '}
            <strong className="mono">{pending.startAt.replace('+08:00', '')}</strong>？
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
