import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageSection } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createHqContract,
  fetchHqContractAudit,
  fetchHqContractPresets,
  fetchHqContracts,
  getErrorMessage,
  updateHqContract,
} from '../../../lib/api';
import type {
  ContractAuditLog,
  GymContractPreset,
  MembershipContract,
} from '../../../types/api';

type ContractPurpose = 'GENERAL' | 'NEW_MEMBER' | 'BIOMETRICS_CONSENT';

function contractLabel(c: Pick<MembershipContract, 'title' | 'shortName' | 'displayName'>) {
  return c.displayName || c.shortName || c.title;
}

function purposeLabel(purpose?: string | null) {
  if (purpose === 'BIOMETRICS_CONSENT') return '生物辨識同意書';
  if (purpose === 'NEW_MEMBER') return '新會員入會';
  return '一般';
}

function normalizePurpose(purpose?: string | null): ContractPurpose {
  if (purpose === 'BIOMETRICS_CONSENT' || purpose === 'NEW_MEMBER') return purpose;
  return 'GENERAL';
}

function auditActionLabel(action: string) {
  switch (action) {
    case 'CREATE':
      return '建立範本';
    case 'UPDATE':
      return '異動';
    case 'BUMP_VERSION':
      return '條文升版';
    case 'VOID':
    case 'VOID_CONTRACT':
      return '作廢';
    case 'REACTIVATE':
      return '重新啟用';
    case 'ASSIGN':
      return '指派待簽';
    case 'SIGN':
      return '電子簽署';
    case 'RESIGN':
      return '重簽準備';
    case 'OPEN':
      return '開啟';
    case 'VIEW':
      return '檢視';
    default:
      return action;
  }
}

export default function HqContractsTab() {
  const { toast } = useToast();
  const [contracts, setContracts] = useState<MembershipContract[]>([]);
  const [presets, setPresets] = useState<GymContractPreset[]>([]);
  const [title, setTitle] = useState('');
  const [shortName, setShortName] = useState('');
  const [body, setBody] = useState('');
  const [changeNote, setChangeNote] = useState('V1');
  const [purpose, setPurpose] = useState<ContractPurpose>('GENERAL');
  const [presetKey, setPresetKey] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState<MembershipContract | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editShortName, setEditShortName] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editChangeReason, setEditChangeReason] = useState('');
  const [editPurpose, setEditPurpose] = useState<ContractPurpose>('GENERAL');
  const [historyOf, setHistoryOf] = useState<MembershipContract | null>(null);
  const [auditRows, setAuditRows] = useState<ContractAuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchHqContracts('ALL');
      if (res.status === 'success' && res.data) setContracts(res.data);
    } catch (err) {
      toast(getErrorMessage(err, '載入電子合約失敗'), 'error');
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;

    async function fetchList() {
      try {
        const [listRes, presetRes] = await Promise.all([
          fetchHqContracts('ALL'),
          fetchHqContractPresets(),
        ]);
        if (cancelled) return;
        if (listRes.status === 'success' && listRes.data) setContracts(listRes.data);
        if (presetRes.status === 'success' && presetRes.data) setPresets(presetRes.data);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入電子合約失敗'), 'error');
      }
    }

    void fetchList();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  function applyPreset(key: string) {
    setPresetKey(key);
    if (!key) return;
    const p = presets.find((x) => x.key === key);
    if (!p) return;
    setTitle(p.title);
    setShortName(p.shortName);
    setBody(p.body);
    setChangeNote(p.versionBase || 'V1');
    setPurpose(normalizePurpose(p.purpose));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) {
      toast('請填寫標題與合約內容', 'error');
      return;
    }
    if (shortName.trim().length > 20) {
      toast('簡稱請勿超過 20 字', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await createHqContract({
        title: title.trim(),
        shortName: shortName.trim() || undefined,
        body: body.trim(),
        versionBase: changeNote.trim() || 'V1',
        purpose,
        presetKey: presetKey || undefined,
      });
      toast(res.message || '電子合約已建立', 'success');
      setTitle('');
      setShortName('');
      setBody('');
      setChangeNote('V1');
      setPurpose('GENERAL');
      setPresetKey('');
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '建立電子合約失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  function openEdit(c: MembershipContract) {
    setEditing(c);
    setEditTitle(c.title);
    setEditShortName(c.shortName || '');
    setEditBody(c.currentVersion?.body || '');
    setEditChangeReason('');
    setEditPurpose(normalizePurpose(c.purpose));
  }

  async function handleUpdate(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    if (editShortName.trim().length > 20) {
      toast('簡稱請勿超過 20 字', 'error');
      return;
    }
    const reason = editChangeReason.trim();
    if (!reason) {
      toast('電子合約異動須填寫原因', 'error');
      return;
    }
    if (reason.length > 200) {
      toast('異動原因請勿超過 200 字', 'error');
      return;
    }
    const bodyChanged = editBody.trim() !== (editing.currentVersion?.body || '');
    setBusy(true);
    try {
      const payload: {
        title?: string;
        shortName?: string | null;
        body?: string;
        bumpVersion?: boolean;
        changeNote: string;
        purpose?: ContractPurpose;
      } = { changeNote: reason };
      if (editTitle.trim() !== editing.title) payload.title = editTitle.trim();
      const nextShort = editShortName.trim() || null;
      if (nextShort !== (editing.shortName || null)) payload.shortName = nextShort;
      if (bodyChanged) {
        payload.body = editBody.trim();
        payload.bumpVersion = true;
      }
      if (editPurpose !== normalizePurpose(editing.purpose)) payload.purpose = editPurpose;
      const hasFieldChange =
        payload.title !== undefined ||
        payload.shortName !== undefined ||
        payload.body !== undefined ||
        payload.purpose !== undefined;
      if (!hasFieldChange) {
        toast('沒有變更', 'error');
        setBusy(false);
        return;
      }
      const res = await updateHqContract(editing.id, payload);
      toast(res.message || '電子合約已更新', 'success');
      setEditing(null);
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '更新電子合約失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleVoid(c: MembershipContract) {
    if (!window.confirm(`確定作廢電子合約「${contractLabel(c)}」？作廢後不可再綁定新方案。`)) return;
    const reason = window.prompt('請填寫作廢原因', '');
    if (reason == null) return;
    if (!reason.trim()) {
      toast('作廢須填寫原因', 'error');
      return;
    }
    try {
      const res = await updateHqContract(c.id, {
        status: 'VOIDED',
        changeNote: reason.trim(),
      });
      toast(res.message || '已作廢', 'success');
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '作廢失敗'), 'error');
    }
  }

  async function handleReactivate(c: MembershipContract) {
    const reason = window.prompt('請填寫重新啟用原因', '');
    if (reason == null) return;
    if (!reason.trim()) {
      toast('重新啟用須填寫原因', 'error');
      return;
    }
    try {
      const res = await updateHqContract(c.id, {
        status: 'ACTIVE',
        changeNote: reason.trim(),
      });
      toast(res.message || '已啟用', 'success');
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '啟用失敗'), 'error');
    }
  }

  async function openHistory(c: MembershipContract) {
    setHistoryOf(c);
    setAuditRows([]);
    setAuditLoading(true);
    try {
      const res = await fetchHqContractAudit(c.id);
      if (res.status === 'success' && res.data) setAuditRows(res.data);
    } catch (err) {
      toast(getErrorMessage(err, '載入稽核軌跡失敗'), 'error');
    } finally {
      setAuditLoading(false);
    }
  }

  return (
    <PageSection
      title="電子合約"
      desc="健身房專業電子合約：可自建範本、現場／自助電子簽名；條文異動一律升版；建立、異動、指派、簽署、重簽皆寫入不可竄改之稽核軌跡"
    >
      <div className="staff-grid">
        <Card title="建立電子合約" subtitle="可選專業範本後再自行調整">
          <form className="form-stack" onSubmit={handleCreate}>
            <Field label="專業範本" hint="套用後仍可修改內容；建立時會記錄範本來源">
              <select
                className="input"
                value={presetKey}
                onChange={(e) => applyPreset(e.target.value)}
              >
                <option value="">空白自行撰寫</option>
                {presets.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="標題" hint="完整合約名稱">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </Field>
            <Field label="簡稱" hint="選填，列表／標籤優先顯示（最多 20 字）">
              <Input
                value={shortName}
                onChange={(e) => setShortName(e.target.value)}
                placeholder="例：入會約"
                maxLength={20}
              />
            </Field>
            <Field label="合約條文" hint="純文字；簽署時全文展開，內容會計算雜湊防竄改">
              <textarea
                className="input"
                rows={12}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
              />
            </Field>
            <Field label="版本備註" hint="預設 V1；建立後鎖定。條文異動升版產生 V1.1、V1.2…">
              <Input
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                placeholder="V1"
                maxLength={40}
                required
              />
            </Field>
            <Field
              label="用途"
              hint="新會員入會＝自助註冊必簽（全站僅一份）；生物辨識＝人臉授權來源（全站僅一份）"
            >
              <select
                className="input"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value as ContractPurpose)}
              >
                <option value="GENERAL">一般電子合約</option>
                <option value="NEW_MEMBER">新會員入會契約</option>
                <option value="BIOMETRICS_CONSENT">生物辨識同意書</option>
              </select>
            </Field>
            <Button type="submit" loading={busy}>
              建立電子合約
            </Button>
          </form>
        </Card>

        <Card title="電子合約一覽" subtitle={`共 ${contracts.length} 份`}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>簡稱</th>
                  <th>標題</th>
                  <th>用途</th>
                  <th>狀態</th>
                  <th>目前版本</th>
                  <th>稽核</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {contracts.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-muted text-center">
                      尚無電子合約
                    </td>
                  </tr>
                ) : (
                  contracts.map((c) => (
                    <tr key={c.id}>
                      <td className="mono text-sm">#{c.id}</td>
                      <td>{c.shortName || '—'}</td>
                      <td>{c.title}</td>
                      <td>
                        {c.purpose === 'GENERAL' || !c.purpose ? (
                          '一般'
                        ) : (
                          <Badge tone="info">{purposeLabel(c.purpose)}</Badge>
                        )}
                      </td>
                      <td>
                        <Badge tone={c.status === 'ACTIVE' ? 'success' : 'neutral'}>
                          {c.status === 'ACTIVE' ? '啟用' : '作廢'}
                        </Badge>
                      </td>
                      <td>
                        {c.currentVersion?.versionLabel ||
                          (c.currentVersion?.version != null
                            ? `v${c.currentVersion.version}`
                            : '—')}
                      </td>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => void openHistory(c)}>
                          {(c.changeLogs?.length || 0) > 0
                            ? `${c.changeLogs!.length} 筆操作`
                            : `${c.versionCount} 版`}
                        </Button>
                      </td>
                      <td className="table-actions">
                        <Button size="sm" variant="secondary" onClick={() => openEdit(c)}>
                          編修
                        </Button>
                        {c.status === 'ACTIVE' ? (
                          <Button size="sm" variant="danger" onClick={() => void handleVoid(c)}>
                            作廢
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void handleReactivate(c)}
                          >
                            啟用
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Modal
        open={editing !== null}
        title={editing ? `編修電子合約 · ${contractLabel(editing)}` : '編修'}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
              取消
            </Button>
            <Button onClick={handleUpdate} loading={busy}>
              儲存
            </Button>
          </>
        }
      >
        {editing && (
          <form className="form-stack" onSubmit={handleUpdate}>
            <Alert tone="info">
              每次異動須填寫原因並寫入稽核。修改條文會自動升版（下一版{' '}
              {editing.versionBase || 'V1'}
              {(editing.currentVersion?.version || 1) >= 1
                ? `.${editing.currentVersion?.version || 1}`
                : ''}
              ），前版作廢且已簽署會員需重新電子簽名；舊簽名仍保留於稽核軌跡。
            </Alert>
            <Field label="版本備註（已鎖定）">
              <Input value={editing.versionBase || 'V1'} readOnly disabled />
            </Field>
            {editing.currentVersion?.bodyHash ? (
              <Field label="目前條文雜湊">
                <Input value={editing.currentVersion.bodyHash} readOnly disabled className="mono" />
              </Field>
            ) : null}
            <Field label="標題">
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required />
            </Field>
            <Field label="簡稱" hint="選填，最多 20 字">
              <Input
                value={editShortName}
                onChange={(e) => setEditShortName(e.target.value)}
                maxLength={20}
              />
            </Field>
            <Field label="合約條文">
              <textarea
                className="input"
                rows={12}
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                required
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
              />
            </Field>
            <Field label="異動原因" hint="必填；寫入操作歷程與稽核（最多 200 字）">
              <Input
                value={editChangeReason}
                onChange={(e) => setEditChangeReason(e.target.value)}
                placeholder="例：更新暫停條款、依法修訂告知事項"
                maxLength={200}
                required
              />
            </Field>
            <Field
              label="用途"
              hint="新會員入會＝自助註冊必簽；生物辨識＝人臉授權（各僅可一份啟用）"
            >
              <select
                className="input"
                value={editPurpose}
                onChange={(e) => setEditPurpose(e.target.value as ContractPurpose)}
              >
                <option value="GENERAL">一般電子合約</option>
                <option value="NEW_MEMBER">新會員入會契約</option>
                <option value="BIOMETRICS_CONSENT">生物辨識同意書</option>
              </select>
            </Field>
          </form>
        )}
      </Modal>

      <Modal
        open={historyOf !== null}
        title={historyOf ? `稽核／版本 · ${contractLabel(historyOf)}` : '稽核'}
        onClose={() => setHistoryOf(null)}
        footer={
          <Button variant="ghost" onClick={() => setHistoryOf(null)}>
            關閉
          </Button>
        }
      >
        {historyOf && (
          <div className="form-stack">
            <strong style={{ fontSize: '0.9rem' }}>全域稽核軌跡</strong>
            {auditLoading ? (
              <p className="text-muted text-sm" style={{ margin: 0 }}>
                載入中…
              </p>
            ) : auditRows.length === 0 ? (
              <p className="text-muted text-sm" style={{ margin: 0 }}>
                尚無稽核紀錄（舊資料可能僅有下方操作歷程）
              </p>
            ) : (
              auditRows.map((log) => (
                <div
                  key={log.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.75rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <strong>
                      {auditActionLabel(log.action)}
                      {log.actorType ? ` · ${log.actorType}` : ''}
                    </strong>
                    <span className="text-muted text-sm">
                      {new Date(log.createdAt).toLocaleString('zh-TW')}
                    </span>
                  </div>
                  {log.summary ? (
                    <p className="text-sm text-muted" style={{ margin: '0.25rem 0' }}>
                      {log.summary}
                    </p>
                  ) : null}
                  {log.changeNote ? (
                    <p className="text-sm" style={{ margin: '0.25rem 0 0' }}>
                      原因：{log.changeNote}
                    </p>
                  ) : null}
                  <p className="text-sm text-muted mono" style={{ margin: '0.35rem 0 0' }}>
                    {log.id}
                    {log.ipAddress ? ` · IP ${log.ipAddress}` : ''}
                    {log.memberId ? ` · 會員 #${log.memberId}` : ''}
                  </p>
                </div>
              ))
            )}

            <strong style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>操作歷程</strong>
            {(historyOf.changeLogs || []).length === 0 ? (
              <p className="text-muted text-sm" style={{ margin: 0 }}>
                尚無操作紀錄
              </p>
            ) : (
              (historyOf.changeLogs || []).map((log) => (
                <div
                  key={log.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.75rem',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <strong>
                      {log.action === 'BUMP_VERSION'
                        ? '條文升版'
                        : log.action === 'CREATE'
                          ? '建立'
                          : log.action === 'VOID_CONTRACT'
                            ? '作廢合約'
                            : log.action === 'REACTIVATE'
                              ? '重新啟用'
                              : '異動'}
                      {log.versionLabel ? ` · ${log.versionLabel}` : ''}
                    </strong>
                    <span className="text-muted text-sm">
                      {new Date(log.createdAt).toLocaleString('zh-TW')}
                    </span>
                  </div>
                  {log.summary ? (
                    <p className="text-sm text-muted" style={{ margin: '0.25rem 0' }}>
                      {log.summary}
                    </p>
                  ) : null}
                  <p className="text-sm" style={{ margin: '0.25rem 0 0' }}>
                    原因：{log.changeNote}
                  </p>
                </div>
              ))
            )}

            <strong style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>版本一覽</strong>
            {historyOf.versions.map((v) => (
              <div
                key={v.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.75rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <strong>
                    {v.versionLabel || v.changeNote || `v${v.version}`}{' '}
                    <Badge tone={v.status === 'VOIDED' ? 'neutral' : 'success'}>
                      {v.status === 'VOIDED' ? '已作廢' : '啟用中'}
                    </Badge>
                  </strong>
                  <span className="text-muted text-sm">
                    {new Date(v.createdAt).toLocaleString('zh-TW')}
                  </span>
                </div>
                {v.bodyHash ? (
                  <p className="text-sm text-muted mono" style={{ margin: '0.35rem 0' }}>
                    hash {v.bodyHash.slice(0, 16)}…
                  </p>
                ) : null}
                {v.changeNote && v.changeNote !== (v.versionLabel || '') ? (
                  <p className="text-sm" style={{ margin: '0.35rem 0' }}>
                    升版原因：{v.changeNote}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </PageSection>
  );
}
