import { useMemo, useState } from 'react';
import { Badge, EmptyState, Field, Input } from '../../ui';
import type { TrainerPtContract } from '../../../types/api';
import { formatExpire, money } from './trainerFormat';

type Props = {
  contracts: TrainerPtContract[];
  focusMemberId?: number | null;
  onBookForMember?: (memberId: number) => void;
};

export default function TrainerStudentsPanel({
  contracts,
  focusMemberId,
  onBookForMember,
}: Props) {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = contracts;
    if (needle) {
      list = list.filter((c) => {
        const hay = `${c.memberName || ''} ${c.memberPhone || ''} ${c.memberNo || ''} ${c.memberId}`.toLowerCase();
        return hay.includes(needle);
      });
    }
    return [...list].sort((a, b) => {
      if (focusMemberId) {
        if (a.memberId === focusMemberId) return -1;
        if (b.memberId === focusMemberId) return 1;
      }
      if (a.isAlert !== b.isAlert) return a.isAlert ? -1 : 1;
      return a.remainingSessions - b.remainingSessions;
    });
  }, [contracts, q, focusMemberId]);

  if (contracts.length === 0) {
    return <EmptyState icon="💪" title="尚無進行中的私教合約" desc="學員購課請走櫃檯結帳後會出現於此" />;
  }

  return (
    <div className="form-stack">
      <Field label="搜尋學員" hint="姓名／電話／會員編號">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="輸入關鍵字"
        />
      </Field>

      <div className="coach-student-grid">
        {filtered.map((c) => {
          const low = c.remainingSessions <= 2;
          const focused = focusMemberId === c.memberId;
          return (
            <article
              key={c.id}
              className={`coach-student-card ${focused ? 'is-focus' : ''} ${c.isAlert ? 'is-alert' : ''}`}
            >
              <div className="coach-student-card__head">
                <div>
                  <strong>{c.memberName || `會員 #${c.memberId}`}</strong>
                  <div className="text-muted text-sm mono">
                    {c.memberNo || `#${c.memberId}`}
                    {c.memberPhone ? ` · ${c.memberPhone}` : ''}
                  </div>
                </div>
                <div className="coach-student-card__badges">
                  {c.isAlert ? <Badge tone="danger" dot>警示</Badge> : null}
                  {c.hasLineBound ? (
                    <Badge tone="success">LINE</Badge>
                  ) : (
                    <Badge tone="warning">未綁 LINE</Badge>
                  )}
                </div>
              </div>

              <div className="coach-student-card__meters">
                <div>
                  <span className="text-muted text-sm">剩餘堂數</span>
                  <strong className={low ? 'is-warn' : ''}>
                    {c.remainingSessions}
                    <small>／{c.totalSessions}</small>
                  </strong>
                </div>
                <div>
                  <span className="text-muted text-sm">已用</span>
                  <strong>{c.usedSessions}</strong>
                </div>
                <div>
                  <span className="text-muted text-sm">合約到期</span>
                  <strong>{formatExpire(c.expiresAt)}</strong>
                </div>
              </div>

              <dl className="coach-book-detail__grid">
                <dt>零錢包</dt>
                <dd>{money(c.cashWallet)}</dd>
                <dt>運動金</dt>
                <dd>{money(c.bonusWallet)}</dd>
                <dt>會籍效期</dt>
                <dd>{formatExpire(c.memberExpireDate)}</dd>
                <dt>合約 #</dt>
                <dd className="mono">{c.id}</dd>
              </dl>

              {onBookForMember ? (
                <button
                  type="button"
                  className="coach-student-card__cta"
                  onClick={() => onBookForMember(c.memberId)}
                >
                  為此學員代約 →
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
