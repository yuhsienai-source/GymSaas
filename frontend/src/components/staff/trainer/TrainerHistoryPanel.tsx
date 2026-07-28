import { Badge, EmptyState } from '../../ui';
import type { TrainerDashboardClass } from '../../../types/api';
import { formatTimeRange, typeLabel } from './trainerFormat';

type Props = {
  classes: TrainerDashboardClass[];
};

export default function TrainerHistoryPanel({ classes }: Props) {
  if (classes.length === 0) {
    return <EmptyState icon="📋" title="尚無課程紀錄" desc="已結束的課程會顯示於此，含當日學員名單" />;
  }

  return (
    <div className="form-stack" style={{ gap: '0.75rem' }}>
      {classes.map((c) => (
        <article key={c.id} className="coach-history-card">
          <div className="coach-history-card__head">
            <div>
              <strong>{c.title}</strong>
              <div className="text-muted text-sm">{formatTimeRange(c.startAt, c.endAt)}</div>
            </div>
            <Badge tone="neutral">{typeLabel(c.type)}</Badge>
          </div>
          <p className="text-sm text-muted" style={{ margin: '0.35rem 0' }}>
            {c.branchName || '—'} · {c.venueName || '—'}
            {c.stationName ? `／${c.stationName}` : ''} · 出席 {c.booked}/{c.capacity}
          </p>
          {(c.reservations || []).length === 0 ? (
            <p className="text-sm text-muted">無人預約</p>
          ) : (
            <ul className="coach-roster coach-roster--compact">
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
          )}
        </article>
      ))}
    </div>
  );
}
