import { useEffect, useState } from 'react';
import { Alert, Badge, Button, EmptyState, Modal, PageSection, Skeleton } from '../ui';
import ReasonModal from './ReasonModal';
import { useToast } from '../../contexts/ToastContext';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { cancelGroupSeries, fetchGroupSeriesAdmin, fetchGroupSeriesRoster, getErrorMessage } from '../../lib/api';
import { formatMoney } from '../../lib/hrFormat';
import {
  classWhen,
  dateKey,
  ENROLL_KIND_LABEL,
  ENROLL_STATUS_META,
  REFUND_KIND_LABEL,
  seriesScheduleLabel,
  seriesStatusMeta,
  WAITLIST_STATUS_META,
} from '../../lib/groupClass';
import type { GroupAdminSeries, GroupSeriesRoster } from '../../types/api';

/** 團課期班總覽：報名統計、最低開班判定、名單；取消期班（全額退費）限 ADMIN */
export default function GroupSeriesAdminPanel({ reloadSignal = 0 }: { reloadSignal?: number }) {
  const { toast } = useToast();
  const { isAdmin } = useStaffAuth();
  const [rows, setRows] = useState<GroupAdminSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [roster, setRoster] = useState<GroupSeriesRoster | null>(null);
  const [rosterBusyId, setRosterBusyId] = useState<number | null>(null);
  const [cancelTarget, setCancelTarget] = useState<GroupAdminSeries | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchGroupSeriesAdmin(includeEnded);
        if (!cancelled) setRows(res.data || []);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '讀取期班失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, includeEnded, reloadKey, reloadSignal]);

  async function openRoster(id: number) {
    setRosterBusyId(id);
    try {
      const res = await fetchGroupSeriesRoster(id);
      setRoster(res.data || null);
    } catch (err) {
      toast(getErrorMessage(err, '讀取名單失敗'), 'error');
    } finally {
      setRosterBusyId(null);
    }
  }

  async function submitCancel(reason: string) {
    if (!cancelTarget) return false;
    try {
      const res = await cancelGroupSeries(cancelTarget.id, reason);
      toast(res.message || '期班已取消', res.data?.failed?.length ? 'error' : 'success');
      setReloadKey((k) => k + 1);
      return true;
    } catch (err) {
      toast(getErrorMessage(err, '取消期班失敗'), 'error');
      return false;
    }
  }

  const needsDecision = rows.filter((r) => r.needsDecision);

  return (
    <PageSection
      title="團課期班"
      desc="報名人數、候補與最低開班判定由後端計算"
      action={
        <label className="checkbox-item">
          <input
            type="checkbox"
            checked={includeEnded}
            onChange={(e) => {
              setLoading(true);
              setIncludeEnded(e.target.checked);
            }}
          />
          含已結束
        </label>
      }
    >
      {needsDecision.length > 0 && (
        <Alert tone="warning">
          {needsDecision.length} 個期班已過報名截止仍未達最低開班人數：
          {needsDecision.map((r) => r.title).join('、')}。
          {isAdmin ? '請決定照常開班或取消（已報名者全額退費）。' : '請通知總部管理員決定是否取消。'}
        </Alert>
      )}
      {loading ? (
        <Skeleton style={{ height: 120 }} />
      ) : rows.length === 0 ? (
        <EmptyState icon="📅" title="尚無期班" desc="請於上方建立期班" />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>期班</th>
                <th>時間</th>
                <th>價格</th>
                <th>整期報名</th>
                <th>單堂／候補</th>
                <th>狀態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const st = seriesStatusMeta(s.status);
                return (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.title}</strong>
                      <div className="text-sm text-muted">
                        {[s.branchName, s.venueName, s.trainerName].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="text-sm">
                      {seriesScheduleLabel(s)}
                      <div className="text-muted">
                        {s.classCount} 堂 · 截止 {dateKey(s.enrollDeadline)}
                      </div>
                    </td>
                    <td className="text-sm">
                      {s.termPrice != null ? `整期 ${formatMoney(s.termPrice)}` : '未綁方案（不可售）'}
                      {s.dropInPrice ? <div className="text-muted">單堂 {formatMoney(s.dropInPrice)}</div> : null}
                    </td>
                    <td>
                      <Badge tone={s.belowMinimum ? 'warning' : 'success'}>
                        {s.termActive}/{s.capacity}
                      </Badge>
                      <div className="text-sm text-muted">
                        {s.minEnrollment > 0 ? `最低 ${s.minEnrollment}` : '無最低'}
                        {s.termPending > 0 ? ` · 待付 ${s.termPending}` : ''}
                      </div>
                    </td>
                    <td className="text-sm">
                      單堂 {s.dropInActive}
                      <div className="text-muted">
                        候補 {s.waiting}
                        {s.offered > 0 ? ` · 遞補中 ${s.offered}` : ''}
                      </div>
                    </td>
                    <td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {s.needsDecision ? (
                        <div>
                          <Badge tone="danger">待決定</Badge>
                        </div>
                      ) : s.belowMinimum && s.status === 'OPEN' ? (
                        <div>
                          <Badge tone="warning">未達最低</Badge>
                        </div>
                      ) : null}
                      {s.cancelReason ? <div className="text-sm text-muted">{s.cancelReason}</div> : null}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={rosterBusyId === s.id}
                          onClick={() => void openRoster(s.id)}
                        >
                          名單
                        </Button>
                        {isAdmin && s.status === 'OPEN' ? (
                          <Button size="sm" variant="danger" onClick={() => setCancelTarget(s)}>
                            取消期班
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={Boolean(roster)} title={roster ? `${roster.series.title} 名單` : '名單'} onClose={() => setRoster(null)} wide>
        {roster ? (
          <div className="form-stack">
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              {seriesScheduleLabel(roster.series)} · 整期剩餘名額 {roster.seatsLeft}
            </p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>會員</th>
                    <th>類型</th>
                    <th>狀態</th>
                    <th>金額</th>
                    <th>來源</th>
                    <th>付款時間</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.enrollments.map((e) => {
                    const meta = ENROLL_STATUS_META[e.status] || { label: e.status, tone: 'neutral' as const };
                    return (
                      <tr key={e.id}>
                        <td>
                          {e.memberName || '—'}
                          <div className="text-sm text-muted">{e.memberNo || `#${e.memberId}`}</div>
                        </td>
                        <td>
                          {ENROLL_KIND_LABEL[e.kind] || e.kind} · {e.sessionsTotal} 堂
                        </td>
                        <td>
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                          {e.refundKind ? (
                            <div className="text-sm text-muted">
                              {REFUND_KIND_LABEL[e.refundKind] || e.refundKind} {formatMoney(e.refundAmount)}
                            </div>
                          ) : null}
                        </td>
                        <td>{formatMoney(e.price)}</td>
                        <td>{e.source === 'POS' ? '臨櫃' : '線上'}</td>
                        <td className="text-sm">{e.paidAt ? classWhen(e.paidAt) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {roster.waitlist.length > 0 && (
              <>
                <strong>候補名單</strong>
                <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {roster.waitlist.map((w) => {
                    const meta = WAITLIST_STATUS_META[w.status] || { label: w.status, tone: 'neutral' as const };
                    return (
                      <li key={w.id} className="text-sm">
                        {w.memberName || `#${w.memberId}`} · <Badge tone={meta.tone}>{meta.label}</Badge>
                        {w.offerExpiresAt ? ` 限 ${classWhen(w.offerExpiresAt)} 前` : ''}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
            <strong>堂次</strong>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {roster.classes.map((c) => (
                <li key={c.id} className="text-sm">
                  {classWhen(c.startAt)} · 預約 {c.booked}/{c.capacity} · 出席 {c.attended}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Modal>

      {cancelTarget && (
        <ReasonModal
          title={`取消期班：${cancelTarget.title}`}
          label="取消原因（通知學員，不含金額）"
          confirmLabel="取消期班並退費"
          danger
          onSubmit={submitCancel}
          onClose={() => setCancelTarget(null)}
        >
          <Alert tone="warning">
            將刪除未上課堂次、取消候補，已報名 {cancelTarget.termActive + cancelTarget.dropInActive}{' '}
            人之未履約部分全額退費（無手續費）。此動作無法復原。
          </Alert>
        </ReasonModal>
      )}
    </PageSection>
  );
}
