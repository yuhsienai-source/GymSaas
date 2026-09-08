import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import MemberLayout from '../../components/layout/MemberLayout';
import IdPhotoUploadModal from '../../components/member/IdPhotoUploadModal';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Skeleton,
} from '../../components/ui';
import { useMemberAuth } from '../../contexts/MemberAuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  cancelMemberIdPhotoDeleteRequest,
  fetchMemberIdPhotoMeta,
  fetchMemberProfile,
  fetchMemberSignedContracts,
  getErrorMessage,
  memberIdPhotoPath,
  updateMemberProfile,
  type IdPhotoSide,
} from '../../lib/api';
import { getMemberToken } from '../../lib/storage';
import type { MemberContractListItem, MemberProfile } from '../../types/api';

function purposeLabel(purpose?: string | null) {
  switch (purpose) {
    case 'NEW_MEMBER':
      return '新會員';
    case 'BIOMETRICS_CONSENT':
      return '生物辨識';
    case 'GENERAL':
      return '一般';
    default:
      return purpose || null;
  }
}

function statusLabel(item: MemberContractListItem) {
  if (item.status === 'SIGNED') return '已簽署';
  if (item.status === 'NEEDS_RESIGN' || item.needsResign) return '需重簽';
  if (item.required || item.tone === 'required') return '必簽未簽';
  if (item.status === 'PENDING') return '待簽署';
  return '未簽署';
}

function statusTone(item: MemberContractListItem): 'success' | 'warning' | 'danger' | 'neutral' {
  if (item.status === 'SIGNED') return 'success';
  if (
    item.status === 'NEEDS_RESIGN' ||
    item.needsResign ||
    item.tone === 'resign' ||
    item.required ||
    item.tone === 'required'
  ) {
    return 'danger';
  }
  if (item.status === 'PENDING') return 'warning';
  return 'neutral';
}

function formatSignedAt(value?: string | null) {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString('zh-TW');
  } catch {
    return String(value);
  }
}

function itemKey(item: MemberContractListItem) {
  return item.signatureId ?? `c-${item.contractId}-v-${item.versionId ?? 0}`;
}

const SIDE_LABEL: Record<IdPhotoSide, string> = {
  front: '證件正面',
  back: '證件反面',
};

async function fetchIdPhotoBlobUrl(side: IdPhotoSide): Promise<string | null> {
  const token = getMemberToken();
  const res = await fetch(memberIdPhotoPath(side), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export default function MemberProfilePage() {
  const { logout } = useMemberAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [contracts, setContracts] = useState<MemberContractListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [emergencyContact, setEmergencyContact] = useState('');
  const [emergencyContactPhone, setEmergencyContactPhone] = useState('');
  const [error, setError] = useState('');
  const [expandedKey, setExpandedKey] = useState<string | number | null>(null);
  const [frontPreview, setFrontPreview] = useState<string | null>(null);
  const [backPreview, setBackPreview] = useState<string | null>(null);
  const [idPhotoModalOpen, setIdPhotoModalOpen] = useState(false);
  const [idPhotoModalSide, setIdPhotoModalSide] = useState<IdPhotoSide | null>(null);
  const [pendingDeletes, setPendingDeletes] = useState<
    { id: string; side: string; status: string; reason?: string | null; requestedAt: string }[]
  >([]);

  function setPreview(side: IdPhotoSide, url: string | null) {
    if (side === 'front') {
      setFrontPreview((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return url;
      });
    } else {
      setBackPreview((prev) => {
        if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev);
        return url;
      });
    }
  }

  async function refreshIdPhotoMetaAndPreviews(opts?: {
    frontUrl?: string | null;
    backUrl?: string | null;
  }) {
    const loadSide = async (side: IdPhotoSide, hasUrl?: string | null) => {
      if (!hasUrl) {
        setPreview(side, null);
        return;
      }
      try {
        const url = await fetchIdPhotoBlobUrl(side);
        if (url) setPreview(side, url);
      } catch {
        /* ignore */
      }
    };
    await Promise.all([
      loadSide('front', opts?.frontUrl ?? profile?.idPhotoUrl),
      loadSide('back', opts?.backUrl ?? profile?.idPhotoBackUrl),
    ]);
    try {
      const meta = await fetchMemberIdPhotoMeta();
      if (meta.status === 'success' && meta.data?.pendingDeletes) {
        setPendingDeletes(meta.data.pendingDeletes);
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [profileRes, contractsRes] = await Promise.all([
          fetchMemberProfile(),
          fetchMemberSignedContracts(),
        ]);
        if (cancelled) return;
        if (profileRes.status === 'success' && profileRes.data) {
          setProfile(profileRes.data);
          setName(profileRes.data.name || '');
          setEmergencyContact(profileRes.data.emergencyContact || '');
          setEmergencyContactPhone(profileRes.data.emergencyContactPhone || '');
          const loadSide = async (side: IdPhotoSide, hasUrl?: string | null) => {
            if (!hasUrl) return;
            try {
              const url = await fetchIdPhotoBlobUrl(side);
              if (!cancelled && url) setPreview(side, url);
            } catch {
              /* ignore preview */
            }
          };
          await Promise.all([
            loadSide('front', profileRes.data.idPhotoUrl),
            loadSide('back', profileRes.data.idPhotoBackUrl),
          ]);
          try {
            const meta = await fetchMemberIdPhotoMeta();
            if (!cancelled && meta.status === 'success' && meta.data?.pendingDeletes) {
              setPendingDeletes(meta.data.pendingDeletes);
            }
          } catch {
            /* ignore */
          }
        }
        if (contractsRes.status === 'success' && Array.isArray(contractsRes.data)) {
          setContracts(contractsRes.data);
        }
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入個人資料失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  async function handleCancelDeleteRequest(requestId: string) {
    try {
      await cancelMemberIdPhotoDeleteRequest(requestId);
      toast('已取消清除申請', 'info');
      setPendingDeletes((rows) => rows.filter((r) => r.id !== requestId));
    } catch (err) {
      toast(getErrorMessage(err, '取消失敗'), 'error');
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (name.trim().length < 2) {
      setError('姓名至少 2 字');
      return;
    }
    const emPhoneRaw = emergencyContactPhone.trim().replace(/[\s-]/g, '');
    if (emPhoneRaw && !/^09\d{8}$/.test(emPhoneRaw)) {
      setError('緊急聯絡人手機須為 09 開頭 10 碼');
      return;
    }
    setSaving(true);
    try {
      const res = await updateMemberProfile({
        name: name.trim(),
        emergencyContact: emergencyContact.trim() || null,
        emergencyContactPhone: emPhoneRaw || null,
      });
      if (res.status === 'success' && res.data) {
        setProfile(res.data);
        setName(res.data.name || '');
        setEmergencyContact(res.data.emergencyContact || '');
        setEmergencyContactPhone(res.data.emergencyContactPhone || '');
        toast(res.message || '已更新', 'success');
      } else {
        setError(res.message || '更新失敗');
      }
    } catch (err) {
      setError(getErrorMessage(err, '更新失敗'));
    } finally {
      setSaving(false);
    }
  }

  const plan = profile?.plan || '計時會員';
  const pendingCount = contracts.filter((c) => c.status !== 'SIGNED').length;
  const headerPlan = [profile?.branchLabel, plan, profile?.memberNo]
    .filter(Boolean)
    .join(' · ');

  function renderIdSide(side: IdPhotoSide) {
    const preview = side === 'front' ? frontPreview : backPreview;
    return (
      <div className="id-photo-side" key={side}>
        <p className="id-photo-side__title">{SIDE_LABEL[side]}</p>
        {preview ? (
          <img src={preview} alt={`${SIDE_LABEL[side]}預覽`} className="id-photo-side__preview" />
        ) : (
          <div className="id-photo-side__placeholder">尚未上傳</div>
        )}
        <div className="id-photo-side__actions">
          <Button
            type="button"
            variant="secondary"
            className="id-photo-touch-btn"
            onClick={() => {
              setIdPhotoModalSide(side);
              setIdPhotoModalOpen(true);
            }}
          >
            上傳／更新
          </Button>
        </div>
      </div>
    );
  }

  return (
    <MemberLayout
      name={profile?.name || (loading ? '載入中…' : '會員')}
      plan={headerPlan || plan}
      onLogout={logout}
      activeTab="profile"
    >
      <p className="text-sm" style={{ marginBottom: '0.75rem' }}>
        <Link to="/member">← 回首頁</Link>
      </p>

      <Card title="個人資料" subtitle="點左上角個人圖示亦可進入此頁">
        {loading ? (
          <Skeleton style={{ height: 180 }} />
        ) : (
          <form className="form-stack" onSubmit={handleSave}>
            {error && (
              <Alert tone="error" onDismiss={() => setError('')}>
                {error}
              </Alert>
            )}

            <div className="profile-section">
              <p className="profile-section__label">帳號資訊</p>
              <Field label="會員編號">
                <Input value={profile?.memberNo || '—'} readOnly disabled className="mono" />
              </Field>
              <Field label="綁定分店" hint="變更分店請洽櫃檯">
                <Input value={profile?.branchLabel || '尚未綁定'} readOnly disabled />
              </Field>
              <Field label="手機" hint="變更手機請洽櫃檯">
                <Input value={profile?.phone || ''} readOnly disabled />
              </Field>
              <div className="profile-badges">
                <Badge tone={profile?.hasLineBound ? 'success' : 'neutral'}>
                  LINE／裝置{' '}
                  {profile?.hasLineBound && profile?.hasDeviceBound
                    ? '已綁定'
                    : profile?.hasLineBound
                      ? 'LINE 已綁（待補裝置）'
                      : '未綁定'}
                </Badge>
                <Badge tone={profile?.hasFaceBound ? 'success' : 'neutral'}>
                  人臉 {profile?.hasFaceBound ? '已綁定' : '未綁定'}
                </Badge>
              </div>
            </div>

            <div className="profile-section">
              <p className="profile-section__label">可編輯資料</p>
              <Field label="姓名" hint="必填">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={2}
                  autoComplete="name"
                />
              </Field>
              <Field label="緊急聯絡人">
                <Input
                  value={emergencyContact}
                  onChange={(e) => setEmergencyContact(e.target.value)}
                  placeholder="姓名"
                  autoComplete="off"
                />
              </Field>
              <Field label="緊急聯絡人手機" hint="09 開頭 10 碼">
                <Input
                  value={emergencyContactPhone}
                  onChange={(e) => setEmergencyContactPhone(e.target.value)}
                  inputMode="tel"
                  placeholder="0912345678"
                  autoComplete="tel"
                />
              </Field>
            </div>

            <div className="profile-section">
              <p className="profile-section__label">證件照片</p>
              <Alert tone="info">
                僅供會籍身分核對。保存至會籍結束後 3 年；重傳後舊圖保留 1 年。清除須櫃檯核准。影像經登入憑證讀取，不上公開目錄。
              </Alert>
              <div className="id-photo-grid">
                {renderIdSide('front')}
                {renderIdSide('back')}
              </div>
              <Button
                type="button"
                className="id-photo-touch-btn"
                style={{ width: '100%', marginTop: '0.65rem', background: '#083D4F' }}
                onClick={() => {
                  setIdPhotoModalSide(null);
                  setIdPhotoModalOpen(true);
                }}
              >
                開啟證件上傳（鏡頭／選檔／申請清除）
              </Button>
              {pendingDeletes.length > 0 && (
                <div className="id-photo-pending">
                  <p className="id-photo-side__title">待核准清除申請</p>
                  <ul>
                    {pendingDeletes.map((p) => (
                      <li key={p.id}>
                        {p.side === 'both'
                          ? '正＋反面'
                          : SIDE_LABEL[p.side as IdPhotoSide] || p.side}
                        {' · '}
                        {new Date(p.requestedAt).toLocaleString('zh-TW')}
                        <Button
                          type="button"
                          variant="ghost"
                          className="id-photo-touch-btn"
                          onClick={() => void handleCancelDeleteRequest(p.id)}
                        >
                          取消申請
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <Button type="submit" size="lg" loading={saving} className="w-full" style={{ width: '100%' }}>
              儲存變更
            </Button>
          </form>
        )}
      </Card>

      <IdPhotoUploadModal
        open={idPhotoModalOpen}
        initialSide={idPhotoModalSide}
        onClose={() => setIdPhotoModalOpen(false)}
        onUploaded={(side) => {
          setProfile((p) => {
            if (!p) return p;
            if (side === 'back') {
              return { ...p, idPhotoBackUrl: p.idPhotoBackUrl || 'uploaded' };
            }
            return { ...p, idPhotoUrl: p.idPhotoUrl || 'uploaded' };
          });
          void (async () => {
            try {
              const url = await fetchIdPhotoBlobUrl(side);
              if (url) setPreview(side, url);
            } catch {
              /* ignore */
            }
          })();
        }}
        onDeleteRequested={() => {
          void refreshIdPhotoMetaAndPreviews();
        }}
      />

      <Card
        title="契約簽署狀態"
        subtitle={
          pendingCount > 0
            ? `含 ${pendingCount} 份應簽署／待重簽；完成簽署請洽櫃檯`
            : '已簽署與應簽署契約；點選可展開內容'
        }
      >
        {loading ? (
          <Skeleton style={{ height: 120 }} />
        ) : contracts.length === 0 ? (
          <EmptyState icon="📄" title="尚無相關契約" desc="入會或櫃檯辦理時會顯示於此" />
        ) : (
          <ul className="member-contract-list">
            {contracts.map((c) => {
              const key = itemKey(c);
              const open = expandedKey === key;
              const title = c.title || c.displayName || `契約 #${c.contractId}`;
              const purpose = purposeLabel(c.purpose);
              const signedAt = formatSignedAt(c.signedAt);
              const isSigned = c.status === 'SIGNED';
              return (
                <li
                  key={key}
                  className={`member-contract-list__item member-contract-list__item--${c.tone || 'unsigned'}`}
                >
                  <button
                    type="button"
                    className="member-contract-list__toggle"
                    aria-expanded={open}
                    onClick={() => setExpandedKey(open ? null : key)}
                  >
                    <span className="member-contract-list__title-row">
                      <span className="member-contract-list__title">{title}</span>
                      <Badge tone={statusTone(c)}>{statusLabel(c)}</Badge>
                    </span>
                    <span className="member-contract-list__meta">
                      {c.versionLabel || (c.version != null ? `V${c.version}` : '')}
                      {purpose ? ` · ${purpose}` : ''}
                      {c.required && !isSigned ? ' · 必簽' : ''}
                      {isSigned && signedAt ? ` · ${signedAt}` : ''}
                      {!isSigned ? ' · 請洽櫃檯簽署' : ''}
                    </span>
                    <span className="member-contract-list__chevron" aria-hidden>
                      {open ? '▾' : '▸'}
                    </span>
                  </button>
                  {open && (
                    <div className="member-contract-list__detail">
                      {!isSigned && (
                        <Alert tone={c.required || c.tone === 'required' ? 'error' : 'warning'}>
                          {c.needsResign || c.status === 'NEEDS_RESIGN'
                            ? '合約版本已更新，請洽櫃檯重新簽署。'
                            : c.required || c.tone === 'required'
                              ? '此為必簽契約，未簽署不得進場，請洽櫃檯完成電子簽名。'
                              : '此契約尚未簽署，請洽櫃檯完成電子簽名。'}
                        </Alert>
                      )}
                      <pre className="member-contract-list__body">{c.body || '（無內文）'}</pre>
                      {isSigned && c.signatureData ? (
                        <div className="member-contract-list__sign">
                          <p className="text-sm text-muted">電子簽名</p>
                          <img src={c.signatureData} alt="電子簽名" />
                        </div>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </MemberLayout>
  );
}
