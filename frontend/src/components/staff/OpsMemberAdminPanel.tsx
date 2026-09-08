import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input } from '../ui';
import { useToast } from '../../contexts/ToastContext';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import {
  adjustOpsMemberExpire,
  approveOpsIdPhotoDeleteRequest,
  createOpsMemberNote,
  fetchOpsMemberIdPhotos,
  fetchOpsMemberNotes,
  getErrorMessage,
  rejectOpsIdPhotoDeleteRequest,
  requestOpsMemberIdPhotoPresign,
  type IdPhotoSide,
} from '../../lib/api';
import type { PosDisplayHostApi } from '../../lib/usePosDisplayHost';
import type { OpsMember } from '../../types/api';
import OpsIdPhotoAssistPanel from './OpsIdPhotoAssistPanel';

type Props = {
  member: OpsMember | null;
  onMemberUpdated?: (member: OpsMember) => void;
  /** 客顯 host（臨櫃代辦證件 CONSENT） */
  posDisplay?: PosDisplayHostApi | null;
  branchCode?: string;
  staffId?: number | null;
};

type PendingDelete = {
  id: string;
  side: string;
  status: string;
  reason?: string | null;
  requestedAt: string;
};

export default function OpsMemberAdminPanel({
  member,
  onMemberUpdated,
  posDisplay = null,
  branchCode = '—',
  staffId = null,
}: Props) {
  const { toast } = useToast();
  const { canAccessTx } = useStaffAuth();
  const [noteDraft, setNoteDraft] = useState('');
  const [notes, setNotes] = useState<
    { id: number; content: string; visibility: string; createdAt: string }[]
  >([]);
  const [expireDays, setExpireDays] = useState('7');
  const [expireReason, setExpireReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [idMeta, setIdMeta] = useState<{
    sides: Record<string, { id?: string | null; side: string } | null>;
    pendingDeletes: PendingDelete[];
  } | null>(null);
  const [preview, setPreview] = useState<{ front: string | null; back: string | null }>({
    front: null,
    back: null,
  });
  const [previewMeta, setPreviewMeta] = useState<{
    frontExpiresAt?: string | null;
    backExpiresAt?: string | null;
    mode?: string | null;
  }>({});
  const [previewBusy, setPreviewBusy] = useState<IdPhotoSide | null>(null);
  const [viewReason, setViewReason] = useState('');

  const loadNotes = useCallback(async () => {
    if (!member) return;
    try {
      const res = await fetchOpsMemberNotes(member.id);
      if (res.status === 'success' && res.data) setNotes(res.data);
    } catch {
      /* ignore */
    }
  }, [member]);

  const loadIdPhotos = useCallback(async () => {
    if (!member) return;
    try {
      const res = await fetchOpsMemberIdPhotos(member.id);
      if (res.status === 'success' && res.data) {
        setIdMeta({
          sides: res.data.sides || {},
          pendingDeletes: res.data.pendingDeletes || [],
        });
      }
    } catch {
      setIdMeta(null);
    }
  }, [member]);

  useEffect(() => {
    void loadNotes();
    void loadIdPhotos();
    setPreview({ front: null, back: null });
    setPreviewMeta({});
    setViewReason('');
  }, [loadNotes, loadIdPhotos]);

  async function openPresignedPreview(side: IdPhotoSide) {
    if (!member) return;
    if (!canAccessTx) {
      toast('原圖調閱僅限 DUTY（值星）以上', 'error');
      return;
    }
    const reason = viewReason.trim();
    if (reason.length < 4) {
      toast('請填寫調閱原因（至少 4 字）', 'error');
      return;
    }
    setPreviewBusy(side);
    try {
      const res = await requestOpsMemberIdPhotoPresign(member.id, side, reason);
      if (res.status !== 'success' || !res.data?.url) {
        toast(res.message || '簽發調閱失敗', 'error');
        return;
      }
      setPreview((p) => ({ ...p, [side]: res.data!.url }));
      setPreviewMeta((m) => ({
        ...m,
        mode: res.data!.mode,
        [side === 'back' ? 'backExpiresAt' : 'frontExpiresAt']: res.data!.expiresAt,
      }));
      toast(
        `已簽發調閱（${res.data.mode === 'r2_presign' ? 'R2 Presigned' : '短效 token'} · ${res.data.expiresIn}s）`,
        'success',
      );
    } catch (err) {
      toast(getErrorMessage(err, '調閱失敗'), 'error');
    } finally {
      setPreviewBusy(null);
    }
  }

  if (!member) {
    return <Alert tone="info">選擇會員後可管理備註、效期與證件狀態。</Alert>;
  }

  async function onAddNote(e: FormEvent) {
    e.preventDefault();
    if (!noteDraft.trim()) return;
    setBusy(true);
    try {
      const res = await createOpsMemberNote(member!.id, {
        content: noteDraft.trim(),
        visibility: 'SHARED',
      });
      if (res.status !== 'success') {
        toast(res.message || '新增備註失敗', 'error');
        return;
      }
      setNoteDraft('');
      toast('備註已儲存', 'success');
      void loadNotes();
    } catch (err) {
      toast(getErrorMessage(err, '新增備註失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onAdjustExpire(e: FormEvent) {
    e.preventDefault();
    if (!expireReason.trim()) {
      toast('請填寫原因', 'error');
      return;
    }
    const days = parseInt(expireDays, 10);
    if (!Number.isFinite(days) || days === 0) {
      toast('天數須為非零整數（可為負數縮短）', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await adjustOpsMemberExpire(member!.id, {
        days,
        reason: expireReason.trim(),
      });
      if (res.status !== 'success') {
        toast(res.message || '調整失敗', 'error');
        return;
      }
      toast('已調整會籍日期', 'success');
      if (res.data?.expireDate) {
        onMemberUpdated?.({ ...member!, expireDate: res.data.expireDate });
      }
      setExpireReason('');
    } catch (err) {
      toast(getErrorMessage(err, '調整效期失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onApproveDelete(requestId: string) {
    setBusy(true);
    try {
      const res = await approveOpsIdPhotoDeleteRequest(requestId);
      if (res.status !== 'success') {
        toast(res.message || '核准失敗', 'error');
        return;
      }
      toast('已核准並清除證件', 'success');
      setPreview({ front: null, back: null });
      void loadIdPhotos();
    } catch (err) {
      toast(getErrorMessage(err, '核准失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onRejectDelete(requestId: string) {
    setBusy(true);
    try {
      const res = await rejectOpsIdPhotoDeleteRequest(requestId, '櫃檯駁回');
      if (res.status !== 'success') {
        toast(res.message || '駁回失敗', 'error');
        return;
      }
      toast('已駁回清除申請', 'info');
      void loadIdPhotos();
    } catch (err) {
      toast(getErrorMessage(err, '駁回失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const hasFront = Boolean(idMeta?.sides?.front);
  const hasBack = Boolean(idMeta?.sides?.back);

  return (
    <div className="ops-member-admin">
      <Card title="會員備註" subtitle={`${member.memberNo || `#${member.id}`} ${member.name}`}>
        <form onSubmit={(e) => void onAddNote(e)}>
          <Field label="新增備註">
            <Input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="稽核、客訴、晉升等重大事項…"
            />
          </Field>
          <Button type="submit" loading={busy} disabled={!noteDraft.trim()}>
            儲存備註
          </Button>
        </form>
        <ul className="member-notes-list" style={{ marginTop: '1rem' }}>
          {notes.map((n) => (
            <li key={n.id} style={{ marginBottom: '0.5rem' }}>
              <small>{new Date(n.createdAt).toLocaleString('zh-TW')}</small>
              <div>{n.content}</div>
            </li>
          ))}
          {!notes.length && <Alert tone="info">尚無備註</Alert>}
        </ul>
      </Card>

      {posDisplay && staffId != null && (
        <div style={{ marginTop: '1rem' }}>
          <OpsIdPhotoAssistPanel
            member={member}
            branchCode={branchCode}
            staffId={staffId}
            posDisplay={posDisplay}
            onUploaded={() => void loadIdPhotos()}
          />
        </div>
      )}

      <div style={{ marginTop: '1rem' }}>
        <Card title="證件狀態與調閱" subtitle="一般櫃檯僅見已建檔標記；原圖限 DUTY+ 短效 Presigned／token">
          <Alert tone="info">
            個資用途僅限會籍身分核對；禁止下載／轉傳。清除申請須核准後才刪檔。
          </Alert>
          <div className="id-photo-grid" style={{ marginTop: '0.75rem' }}>
            {(['front', 'back'] as IdPhotoSide[]).map((side) => {
              const has = side === 'front' ? hasFront : hasBack;
              const label = side === 'front' ? '正面' : '反面';
              const exp =
                side === 'front' ? previewMeta.frontExpiresAt : previewMeta.backExpiresAt;
              return (
                <div className="id-photo-side" key={side}>
                  <p className="id-photo-side__title">
                    證件{label}
                    {has ? ' · ✓ 已建檔' : ' · 尚未上傳'}
                  </p>
                  {canAccessTx && preview[side] ? (
                    <>
                      <img
                        src={preview[side]!}
                        alt={`證件${label}調閱`}
                        className="id-photo-side__preview"
                        onContextMenu={(e) => e.preventDefault()}
                        draggable={false}
                      />
                      {exp ? (
                        <small className="text-muted">
                          連結至 {new Date(exp).toLocaleTimeString('zh-TW')} 失效
                          {previewMeta.mode ? ` · ${previewMeta.mode}` : ''}
                        </small>
                      ) : null}
                    </>
                  ) : (
                    <div className="id-photo-side__placeholder">
                      {!has
                        ? '尚未上傳'
                        : canAccessTx
                          ? '填寫原因後調閱原圖'
                          : '已建檔（無權預覽大圖）'}
                    </div>
                  )}
                  {canAccessTx && (
                    <div className="id-photo-side__actions">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!has}
                        loading={previewBusy === side}
                        onClick={() => void openPresignedPreview(side)}
                      >
                        調閱原圖
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {canAccessTx ? (
            <div style={{ marginTop: '0.75rem' }}>
              <Field label="調閱原因（寫入稽核 Log）" hint="至少 4 字；每次調閱皆留存 IdPhotoAccessLog">
                <Input
                  value={viewReason}
                  onChange={(e) => setViewReason(e.target.value)}
                  placeholder="例：主管機關臨檢核對身分"
                />
              </Field>
            </div>
          ) : (
            <div style={{ marginTop: '0.75rem' }}>
              <Alert tone="warning">原圖調閱僅限 DUTY（值星）以上，並須填寫原因。</Alert>
            </div>
          )}
          {canAccessTx && (idMeta?.pendingDeletes?.length || 0) > 0 && (
            <div className="id-photo-pending" style={{ marginTop: '0.75rem' }}>
              <p className="id-photo-side__title">待核准清除申請</p>
              <ul>
                {idMeta!.pendingDeletes.map((p) => (
                  <li key={p.id}>
                    <span>
                      {p.side === 'both' ? '正＋反面' : p.side === 'back' ? '反面' : '正面'}
                      {p.reason ? ` · ${p.reason}` : ''}
                      {' · '}
                      {new Date(p.requestedAt).toLocaleString('zh-TW')}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      loading={busy}
                      onClick={() => void onApproveDelete(p.id)}
                    >
                      核准刪除
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void onRejectDelete(p.id)}
                    >
                      駁回
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <Card title="調整會籍日期">
          <Alert tone="info">DUTY+ 可調整；正數延長、負數縮短，原因必填並寫入備註。</Alert>
          <form onSubmit={(e) => void onAdjustExpire(e)}>
            <Field label="天數（±）">
              <Input
                type="number"
                value={expireDays}
                onChange={(e) => setExpireDays(e.target.value)}
              />
            </Field>
            <Field label="原因">
              <Input value={expireReason} onChange={(e) => setExpireReason(e.target.value)} />
            </Field>
            <Button type="submit" loading={busy}>
              套用調整
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
