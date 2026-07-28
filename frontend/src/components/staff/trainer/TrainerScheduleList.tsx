import { Badge, EmptyState } from '../../ui';
import type { TrainerDashboardClass } from '../../../types/api';
import { formatWhen, typeLabel } from './trainerFormat';

type Props = {
  classes: TrainerDashboardClass[];
  selectedId?: number | null;
  onSelect?: (c: TrainerDashboardClass) => void;
  emptyTitle?: string;
  emptyDesc?: string;
  showRoster?: boolean;
};

export default function TrainerScheduleList({
  classes,
  selectedId,
  onSelect,
  emptyTitle = '近期沒有課程',
  emptyDesc,
  showRoster = true,
}: Props) {
  if (classes.length === 0) {
    return <EmptyState icon="📅" title={emptyTitle} desc={emptyDesc} />;
  }

  return (
    <ul className="coach-timeline">
      {classes.map((c) => {
        const active = selectedId === c.id;
        return (
          <li key={c.id}>
            <button
              type="button"
              className={`coach-timeline__item ${active ? 'is-active' : ''}`}
              onClick={() => onSelect?.(c)}
            >
              <div className="coach-timeline__when">{formatWhen(c.startAt)}</div>
              <div className="coach-timeline__body">
                <strong>{c.title}</strong>
                <span>
                  {typeLabel(c.type)} · {c.branchName || '—'} {c.venueName}
                  {c.stationName ? `／${c.stationName}` : ''}
                </span>
              </div>
              <Badge tone={c.remaining > 0 ? 'success' : 'neutral'}>
                {c.booked}/{c.capacity}
              </Badge>
            </button>
            {showRoster && active && (c.reservations || []).length > 0 ? (
              <ul className="coach-roster">
                {(c.reservations || []).map((r) => (
                  <li key={r.id}>
                    {r.memberName || (r.isConsultGuest ? '諮詢客人' : `會員 #${r.memberId}`)}
                    {r.isConsultGuest ? (
                      <span className="text-muted text-sm"> · 諮詢</span>
                    ) : null}
                    <span className="text-muted text-sm">
                      {r.memberPhone ? ` · ${r.memberPhone}` : ''}
                      {r.status ? ` · ${r.status}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
