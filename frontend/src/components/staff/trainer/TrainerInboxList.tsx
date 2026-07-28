import { Alert, Badge, Button, EmptyState } from '../../ui';
import type { TrainerInboxItem } from '../../../types/api';
import { formatWhen, inboxTone, inboxTypeLabel, sortInbox } from './trainerFormat';

type Props = {
  items: TrainerInboxItem[];
  limit?: number;
  onOpenStudent?: (memberId: number) => void;
  onViewAll?: () => void;
};

export default function TrainerInboxList({ items, limit, onOpenStudent, onViewAll }: Props) {
  const list = sortInbox(items).slice(0, limit ?? items.length);

  if (items.length === 0) {
    return (
      <EmptyState
        icon="📬"
        title="目前沒有待處理訊息"
        desc="未付款、堂數將盡、合約到期、警示與未綁 LINE 會顯示於此"
      />
    );
  }

  return (
    <div className="form-stack" style={{ gap: '0.65rem' }}>
      {list.map((item) => (
        <article key={item.id} className="coach-inbox__item">
          <div className="coach-inbox__head">
            <Badge tone={inboxTone(item.severity)} dot>
              {inboxTypeLabel(item.type)}
            </Badge>
            <strong>{item.title}</strong>
            <span className="text-muted text-sm">{formatWhen(String(item.at))}</span>
          </div>
          <p className="text-sm" style={{ margin: '0.35rem 0' }}>
            {item.body}
          </p>
          {item.actionHint ? (
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              {item.actionHint}
            </p>
          ) : null}
          {item.type === 'UNPAID' ? (
            <div style={{ marginTop: '0.4rem' }}>
              <Alert tone="warning">銷課／結帳請引導至櫃檯；教練端不收款。</Alert>
            </div>
          ) : null}
          {item.memberId && onOpenStudent ? (
            <div className="btn-row" style={{ marginTop: '0.45rem' }}>
              <Button size="sm" variant="secondary" onClick={() => onOpenStudent(item.memberId!)}>
                查看學員
              </Button>
            </div>
          ) : null}
        </article>
      ))}
      {limit != null && items.length > limit && onViewAll ? (
        <Button variant="ghost" onClick={onViewAll}>
          查看全部訊息（{items.length}）
        </Button>
      ) : null}
    </div>
  );
}
