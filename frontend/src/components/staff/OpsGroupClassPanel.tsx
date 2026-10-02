import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Modal, Skeleton } from '../ui';
import ReasonModal from './ReasonModal';
import { useToast } from '../../contexts/ToastContext';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import {
  fetchOpsGroupRefundPreview,
  fetchOpsGroupSellable,
  fetchOpsGroupSeriesDetail,
  fetchOpsMemberGroup,
  getErrorMessage,
  opsJoinGroupWaitlist,
  opsRefundGroupEnrollment,
} from '../../lib/api';
import { formatMoney } from '../../lib/hrFormat';
import { staffHasDutyRankOrAbove } from '../../lib/staffPermissions';
import {
  classWhen,
  ENROLL_KIND_LABEL,
  groupCartKey,
  type GroupCartDraft,
  ENROLL_STATUS_META,
  REFUND_KIND_LABEL,
  seriesScheduleLabel,
  WAITLIST_STATUS_META,
} from '../../lib/groupClass';
import type {
  GroupMemberOverview,
  GroupMyEnrollment,
  GroupRefundPreview,
  GroupSellableSeries,
  GroupSeriesDetail,
} from '../../types/api';

const listStyle = { listStyle: 'none', padding: 0, margin: 0 } as const;
const rowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  alignItems: 'flex-start',
  padding: '0.6rem 0',
  borderBottom: '1px solid var(--border, #e5e5e5)',
} as const;

/** 櫃檯團課：選期班入購物車（整期／插班／單堂）、代登候補、會員團課退費（DUTY+） */
export default function OpsGroupClassPanel({
  branchId,
  member,
  cartKeys,
  onAdd,
  reloadSignal = 0,
}: {
  branchId: number | '';
  member: { id: number; name?: string | null } | null;
  cartKeys: string[];
  onAdd: (draft: GroupCartDraft) => void;
  reloadSignal?: number;
}) {
  const { toast } = useToast();
  const { staff } = useStaffAuth();
  const canRefund = staffHasDutyRankOrAbove(staff);
  const memberId = member?.id ?? null;

  const [series, setSeries] = useState<GroupSellableSeries[]>([]);
  const [overview, setOverview] = useState<GroupMemberOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<GroupSeriesDetail | null>(null);
  const [refundTarget, setRefundTarget] = useState<{ enrollment: GroupMyEnrollment; preview: GroupRefundPreview } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [sRes, oRes] = await Promise.all([
          fetchOpsGroupSellable({
            ...(branchId ? { branchId: Number(branchId) } : {}),
            ...(memberId ? { memberId } : {}),
          }),
          memberId ? fetchOpsMemberGroup(memberId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setSeries(sRes.data || []);
        setOverview(oRes?.data || null);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '讀取團課失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast, branchId, memberId, reloadKey, reloadSignal]);

  function addTerm(s: GroupSellableSeries) {
    if (!s.termQuote) return;
    onAdd({
      seriesId: s.id,
      kind: 'TERM',
      name: s.title,
      price: s.termQuote.price,
      sessions: s.termQuote.sessions,
      detail: s.termQuote.prorated
        ? `插班 ${s.termQuote.sessions}/${s.sessionCount ?? '—'} 堂`
        : `整期 ${s.termQuote.sessions} 堂`,
    });
  }

  async function openDetail(id: number) {
    setBusyKey(`detail-${id}`);
    try {
      const res = await fetchOpsGroupSeriesDetail(id, memberId ?? undefined);
      setDetail(res.data || null);
    } catch (err) {
      toast(getErrorMessage(err, '讀取期班失敗'), 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function joinWaitlist(s: GroupSellableSeries) {
    if (!memberId) return;
    setBusyKey(`wl-${s.id}`);
    try {
      const res = await opsJoinGroupWaitlist({ memberId, seriesId: s.id });
      toast(res.message || '已代登候補', 'success');
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '代登候補失敗'), 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function openRefund(e: GroupMyEnrollment) {
    setBusyKey(`refund-${e.id}`);
    try {
      const res = await fetchOpsGroupRefundPreview(e.id);
      if (res.data) setRefundTarget({ enrollment: e, preview: res.data });
    } catch (err) {
      toast(getErrorMessage(err, '退費試算失敗'), 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function submitRefund(reason: string) {
    if (!refundTarget) return false;
    try {
      const res = await opsRefundGroupEnrollment(refundTarget.enrollment.id, reason);
      toast(res.message || '退費完成', 'success');
      setReloadKey((k) => k + 1);
      return true;
    } catch (err) {
      toast(getErrorMessage(err, '團課退費失敗'), 'error');
      return false;
    }
  }

  const enrollments = overview?.enrollments || [];
  const waitlist = overview?.waitlist || [];
  const preview = refundTarget?.preview;

  return (
    <Card title="團課期班" subtitle="付費期班 · 整期（插班依剩餘堂數計價）或單堂 · 金額以後端為準 · 不可用錢包扣款">
      <div className="form-stack">
        {!member && <Alert tone="warning">報名團課需先於上方「選擇會員」</Alert>}
        {loading ? (
          <Skeleton style={{ height: 80 }} />
        ) : series.length === 0 ? (
          <EmptyState icon="📋" title="此分店目前無開放報名的期班" />
        ) : (
          <ul style={listStyle}>
            {series.map((s) => {
              const enrolled = Boolean(s.myEnrollment);
              const offered = s.myWaitlist?.status === 'OFFERED';
              const inCart = cartKeys.includes(groupCartKey({ seriesId: s.id, kind: 'TERM' }));
              const canTerm = Boolean(member) && !enrolled && s.sellable && s.termQuote && (s.seatsLeft > 0 || offered);
              const canWait = Boolean(member) && !enrolled && s.sellable && s.seatsLeft <= 0 && !s.myWaitlist;
              return (
                <li key={s.id} style={{ ...rowStyle, flexDirection: 'column' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{s.title}</strong>
                    {enrolled ? <Badge tone="success">已報名</Badge> : null}
                    {s.myWaitlist ? (
                      <Badge tone={WAITLIST_STATUS_META[s.myWaitlist.status]?.tone || 'info'}>
                        {WAITLIST_STATUS_META[s.myWaitlist.status]?.label || s.myWaitlist.status}
                      </Badge>
                    ) : null}
                    {s.seatsLeft <= 0 ? <Badge tone="warning">額滿</Badge> : null}
                  </div>
                  <span className="text-sm text-muted">
                    {seriesScheduleLabel(s)} · {s.trainerName || '—'} · 剩 {s.seatsLeft}/{s.capacity}
                    {s.waitingCount ? ` · 候補 ${s.waitingCount}` : ''}
                  </span>
                  <span className="text-sm">
                    {s.termQuote
                      ? `整期 ${formatMoney(s.termQuote.price)}（${s.termQuote.sessions} 堂${
                          s.termQuote.prorated ? '・插班' : ''
                        }）`
                      : ''}
                    {s.dropInPrice ? ` · 單堂 ${formatMoney(s.dropInPrice)}` : ''}
                  </span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="secondary" disabled={!canTerm || inCart} onClick={() => addTerm(s)}>
                      {inCart ? '已在購物車' : s.termQuote?.prorated ? '插班入車' : '整期入車'}
                    </Button>
                    {s.dropInPrice ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!member}
                        loading={busyKey === `detail-${s.id}`}
                        onClick={() => void openDetail(s.id)}
                      >
                        單堂
                      </Button>
                    ) : null}
                    {canWait ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busyKey === `wl-${s.id}`}
                        onClick={() => void joinWaitlist(s)}
                      >
                        代登候補
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {member && (enrollments.length > 0 || waitlist.length > 0) && (
          <>
            <strong>{member.name || '會員'} 的團課</strong>
            <ul style={listStyle}>
              {enrollments.map((e) => {
                const meta = ENROLL_STATUS_META[e.status] || { label: e.status, tone: 'neutral' as const };
                return (
                  <li key={e.id} style={rowStyle}>
                    <div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span>{e.series.title}</span>
                        <Badge tone="neutral">{ENROLL_KIND_LABEL[e.kind] || e.kind}</Badge>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </div>
                      <span className="text-sm text-muted">
                        {e.sessionsTotal} 堂 · {formatMoney(e.price)} · {e.source === 'POS' ? '臨櫃' : '線上'}
                        {e.status === 'REFUNDED' ? ` · 已退 ${formatMoney(e.refundAmount)}` : ''}
                      </span>
                    </div>
                    {canRefund && e.status === 'ACTIVE' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busyKey === `refund-${e.id}`}
                        onClick={() => void openRefund(e)}
                      >
                        退費試算
                      </Button>
                    ) : null}
                  </li>
                );
              })}
              {waitlist.map((w) => (
                <li key={`w-${w.id}`} style={rowStyle}>
                  <span className="text-sm">
                    候補：{w.seriesTitle} · {WAITLIST_STATUS_META[w.status]?.label || w.status}
                    {w.position ? ` · 第 ${w.position} 順位` : ''}
                    {w.offerExpiresAt ? ` · 限 ${classWhen(w.offerExpiresAt)} 前報名` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <Modal open={Boolean(detail)} title={detail ? `${detail.title} · 單堂` : '單堂'} onClose={() => setDetail(null)}>
        {detail ? (
          <ul style={listStyle}>
            {detail.classes
              .filter((c) => c.upcoming)
              .map((c) => {
                const key = groupCartKey({ seriesId: detail.id, kind: 'DROP_IN', classId: c.id });
                const inCart = cartKeys.includes(key);
                return (
                  <li key={c.id} style={rowStyle}>
                    <span className="text-sm">
                      {classWhen(c.startAt)} · 單堂空位 {c.dropInSeats}
                    </span>
                    {c.mine ? (
                      <Badge tone="success">已預約</Badge>
                    ) : (
                      <Button
                        size="sm"
                        disabled={c.dropInSeats < 1 || inCart || !detail.dropInPrice}
                        onClick={() => {
                          onAdd({
                            seriesId: detail.id,
                            kind: 'DROP_IN',
                            classId: c.id,
                            name: detail.title,
                            price: detail.dropInPrice || 0,
                            sessions: 1,
                            detail: `單堂 ${classWhen(c.startAt)}`,
                          });
                          setDetail(null);
                        }}
                      >
                        {inCart ? '已在購物車' : c.dropInSeats < 1 ? '已滿' : '入車'}
                      </Button>
                    )}
                  </li>
                );
              })}
          </ul>
        ) : null}
      </Modal>

      {refundTarget && preview && (
        <ReasonModal
          title={`團課退費：${preview.seriesTitle}`}
          label="退費原因"
          confirmLabel={preview.refundable ? `確認退費 ${formatMoney(preview.refundAmount)}` : '無法退費'}
          danger
          onSubmit={preview.refundable ? submitRefund : async () => false}
          onClose={() => setRefundTarget(null)}
        >
          <div className="form-stack" style={{ marginBottom: '0.75rem' }}>
            <span className="text-sm">
              {preview.refundKind ? REFUND_KIND_LABEL[preview.refundKind] || preview.refundKind : '—'} · 實付{' '}
              {formatMoney(preview.price)} · 已使用 {preview.consumedSessions}/{preview.sessionsTotal} 堂
            </span>
            <span className="text-sm">
              已使用金額 {formatMoney(preview.consumedValue)} · 手續費 {formatMoney(preview.fee)} · 應退{' '}
              <strong>{formatMoney(preview.refundAmount)}</strong>
            </span>
            <span className="text-sm text-muted">
              退款管道：{preview.channels.WALLET_CASH ? `零錢包 ${formatMoney(preview.channels.WALLET_CASH)} ` : ''}
              {preview.channels.LINEPAY ? `LINE Pay 線上退 ${formatMoney(preview.channels.LINEPAY)} ` : ''}
              {preview.channels.MANUAL ? `臨櫃人工退 ${formatMoney(preview.channels.MANUAL)}` : ''}
              {!preview.channels.WALLET_CASH && !preview.channels.LINEPAY && !preview.channels.MANUAL ? '—' : ''}
            </span>
            {preview.blockMessage ? <Alert tone="warning">{preview.blockMessage}</Alert> : null}
          </div>
        </ReasonModal>
      )}
    </Card>
  );
}
