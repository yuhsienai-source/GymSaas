import { type FormEvent, useEffect, useState } from 'react';
import MemberLayout from '../../components/layout/MemberLayout';
import {
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
  fetchCmsAnnouncements,
  fetchCmsBranches,
  fetchCmsFaq,
  fetchCmsTrainers,
  fetchMemberProfile,
  getErrorMessage,
  submitCmsContact,
} from '../../lib/api';
import type {
  CmsAnnouncement,
  CmsBranchIntro,
  CmsFaqItem,
  CmsTrainerPublic,
  MemberProfile,
} from '../../types/api';

type Tab = 'announcements' | 'branches' | 'faq' | 'trainers' | 'contact';

const TABS: { key: Tab; label: string }[] = [
  { key: 'announcements', label: '公告' },
  { key: 'branches', label: '場館' },
  { key: 'faq', label: 'FAQ' },
  { key: 'trainers', label: '教練' },
  { key: 'contact', label: '聯絡我們' },
];

function fmt(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW');
  } catch {
    return String(iso);
  }
}

export default function MemberExplorePage() {
  const { logout } = useMemberAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [tab, setTab] = useState<Tab>('announcements');
  const [loading, setLoading] = useState(true);
  const [announcements, setAnnouncements] = useState<CmsAnnouncement[]>([]);
  const [branches, setBranches] = useState<CmsBranchIntro[]>([]);
  const [faq, setFaq] = useState<CmsFaqItem[]>([]);
  const [trainers, setTrainers] = useState<CmsTrainerPublic[]>([]);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactMessage, setContactMessage] = useState('');
  const [contactBusy, setContactBusy] = useState(false);

  const reload = () => setReloadKey((k) => k + 1);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [profileRes, annRes, branchRes, faqRes, trainerRes] = await Promise.all([
          fetchMemberProfile(),
          fetchCmsAnnouncements(),
          fetchCmsBranches(),
          fetchCmsFaq(),
          fetchCmsTrainers(),
        ]);
        if (cancelled) return;
        setProfile((profileRes.data as MemberProfile) || null);
        if (annRes.status === 'success' && annRes.data) setAnnouncements(annRes.data);
        if (branchRes.status === 'success' && branchRes.data) setBranches(branchRes.data);
        if (faqRes.status === 'success' && faqRes.data) setFaq(faqRes.data);
        if (trainerRes.status === 'success' && trainerRes.data) setTrainers(trainerRes.data);
        if (profileRes.data?.name) setContactName(profileRes.data.name);
        if (profileRes.data?.phone) setContactPhone(profileRes.data.phone);
      } catch (err) {
        if (!cancelled) toast(getErrorMessage(err, '載入探索內容失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  async function onContactSubmit(e: FormEvent) {
    e.preventDefault();
    if (!contactName.trim() || !contactMessage.trim()) {
      toast('請填寫姓名與留言', 'error');
      return;
    }
    setContactBusy(true);
    try {
      const res = await submitCmsContact({
        name: contactName.trim(),
        email: contactEmail.trim() || undefined,
        phone: contactPhone.trim() || undefined,
        message: contactMessage.trim(),
      });
      if (res.status === 'success') {
        toast(res.message || '留言已送出', 'success');
        setContactMessage('');
      } else {
        toast(res.message || '送出失敗', 'error');
      }
    } catch (err) {
      toast(getErrorMessage(err, '送出失敗'), 'error');
    } finally {
      setContactBusy(false);
    }
  }

  return (
    <MemberLayout
      name={profile?.name}
      plan={profile?.plan}
      onRefresh={reload}
      onLogout={logout}
      activeTab="explore"
    >
      <nav className="hq-tabs" role="tablist" aria-label="探索">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`hq-tabs__btn ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="hq-tab-panel" style={{ marginTop: '0.75rem' }}>
        {loading ? (
          <Skeleton style={{ height: 120 }} />
        ) : tab === 'announcements' ? (
          announcements.length === 0 ? (
            <EmptyState icon="📢" title="目前沒有公告" />
          ) : (
            <ul className="member-list">
              {announcements.map((a) => (
                <li key={a.id}>
                  <Card title={a.title} subtitle={fmt(a.publishedAt)}>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{a.body}</p>
                  </Card>
                </li>
              ))}
            </ul>
          )
        ) : tab === 'branches' ? (
          branches.length === 0 ? (
            <EmptyState icon="🏢" title="尚無場館介紹" />
          ) : (
            <ul className="member-list">
              {branches.map((b) => (
                <li key={b.id}>
                  <Card title={b.name} subtitle={b.address || undefined}>
                    {b.introText ? (
                      <p style={{ whiteSpace: 'pre-wrap' }}>{b.introText}</p>
                    ) : (
                      <p className="text-muted text-sm">尚無介紹文字</p>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )
        ) : tab === 'faq' ? (
          faq.length === 0 ? (
            <EmptyState icon="❓" title="尚無 FAQ" />
          ) : (
            <ul className="member-list">
              {faq.map((f) => (
                <li key={f.id}>
                  <Card title={f.question}>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{f.answer}</p>
                  </Card>
                </li>
              ))}
            </ul>
          )
        ) : tab === 'trainers' ? (
          trainers.length === 0 ? (
            <EmptyState icon="💪" title="尚無教練介紹" />
          ) : (
            <ul className="member-list">
              {trainers.map((t) => (
                <li key={t.id}>
                  <Card
                    title={t.displayName}
                    subtitle={(t.branches || []).map((b) => b.name).filter(Boolean).join('、') || undefined}
                  >
                    {t.bio ? (
                      <p style={{ whiteSpace: 'pre-wrap' }}>{t.bio}</p>
                    ) : (
                      <p className="text-muted text-sm">尚無簡介</p>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )
        ) : (
          <Card title="聯絡我們" subtitle="我們將盡快回覆您的留言">
            <form onSubmit={onContactSubmit}>
              <Field label="姓名">
                <Input value={contactName} onChange={(e) => setContactName(e.target.value)} required />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                />
              </Field>
              <Field label="電話">
                <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
              </Field>
              <Field label="留言">
                <textarea
                  className="input"
                  value={contactMessage}
                  onChange={(e) => setContactMessage(e.target.value)}
                  rows={4}
                  required
                />
              </Field>
              <Button type="submit" loading={contactBusy}>
                送出留言
              </Button>
            </form>
          </Card>
        )}
      </div>
    </MemberLayout>
  );
}
