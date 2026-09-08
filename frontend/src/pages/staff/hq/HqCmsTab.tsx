import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Button, Card, Field, Input, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createCmsAnnouncement,
  createCmsFaq,
  deleteCmsAnnouncement,
  deleteCmsFaq,
  fetchCmsAnnouncements,
  fetchCmsBranches,
  fetchCmsFaq,
  getErrorMessage,
  updateCmsBranchContent,
  updateCmsFaq,
} from '../../../lib/api';
import type { Branch } from '../../../types/api';
import type { CmsAnnouncement, CmsBranchIntro, CmsFaqItem } from '../../../types/api';
import type { HqDataProps } from './types';

export default function HqCmsTab({ branches }: Pick<HqDataProps, 'branches'>) {
  const { toast } = useToast();
  const [announcements, setAnnouncements] = useState<CmsAnnouncement[]>([]);
  const [faqItems, setFaqItems] = useState<CmsFaqItem[]>([]);
  const [branchIntros, setBranchIntros] = useState<CmsBranchIntro[]>([]);
  const [section, setSection] = useState<'announcements' | 'faq' | 'branches'>('announcements');
  const [busy, setBusy] = useState(false);

  const [annTitle, setAnnTitle] = useState('');
  const [annBody, setAnnBody] = useState('');
  const [annBranchId, setAnnBranchId] = useState<number | ''>('');

  const [faqQ, setFaqQ] = useState('');
  const [faqA, setFaqA] = useState('');

  const [editBranchId, setEditBranchId] = useState<number | ''>('');
  const [introText, setIntroText] = useState('');
  const [showOccupancy, setShowOccupancy] = useState(true);

  const load = useCallback(async () => {
    try {
      const [annRes, faqRes, branchRes] = await Promise.all([
        fetchCmsAnnouncements(),
        fetchCmsFaq(),
        fetchCmsBranches(),
      ]);
      if (annRes.status === 'success' && annRes.data) setAnnouncements(annRes.data);
      if (faqRes.status === 'success' && faqRes.data) setFaqItems(faqRes.data);
      if (branchRes.status === 'success' && branchRes.data) {
        setBranchIntros(branchRes.data);
        if (!editBranchId && branchRes.data[0]) {
          setEditBranchId(branchRes.data[0].id);
          setIntroText(branchRes.data[0].introText || '');
          setShowOccupancy(branchRes.data[0].showOccupancy !== false);
        }
      }
    } catch (err) {
      toast(getErrorMessage(err, '載入 CMS 失敗'), 'error');
    }
  }, [editBranchId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const b = branchIntros.find((x) => x.id === editBranchId);
    if (b) {
      setIntroText(b.introText || '');
      setShowOccupancy(b.showOccupancy !== false);
    }
  }, [editBranchId, branchIntros]);

  async function onSaveBranchIntro(e: FormEvent) {
    e.preventDefault();
    if (editBranchId === '') return;
    setBusy(true);
    try {
      const res = await updateCmsBranchContent(Number(editBranchId), {
        introText,
        showOccupancy,
      });
      toast(res.message || '已更新', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') void load();
    } catch (err) {
      toast(getErrorMessage(err, '更新失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateAnnouncement(e: FormEvent) {
    e.preventDefault();
    if (!annTitle.trim() || !annBody.trim()) return;
    setBusy(true);
    try {
      const res = await createCmsAnnouncement({
        title: annTitle.trim(),
        body: annBody.trim(),
        branchId: annBranchId === '' ? null : Number(annBranchId),
      });
      toast(res.message || '已建立', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') {
        setAnnTitle('');
        setAnnBody('');
        void load();
      }
    } catch (err) {
      toast(getErrorMessage(err, '建立失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateFaq(e: FormEvent) {
    e.preventDefault();
    if (!faqQ.trim() || !faqA.trim()) return;
    setBusy(true);
    try {
      const res = await createCmsFaq({ question: faqQ.trim(), answer: faqA.trim() });
      toast(res.message || '已建立', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') {
        setFaqQ('');
        setFaqA('');
        void load();
      }
    } catch (err) {
      toast(getErrorMessage(err, '建立失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const activeBranches = branches.filter((b: Branch) => b.isActive);

  return (
    <PageSection title="內容管理 CMS" desc="公告、FAQ、場館介紹">
      <nav className="hq-tabs" role="tablist">
        {(['announcements', 'faq', 'branches'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`hq-tabs__btn ${section === key ? 'is-active' : ''}`}
            onClick={() => setSection(key)}
          >
            {key === 'announcements' ? '公告' : key === 'faq' ? 'FAQ' : '場館'}
          </button>
        ))}
      </nav>

      {section === 'announcements' && (
        <div className="hq-tab-panel">
          <Card title="新增公告">
            <form onSubmit={onCreateAnnouncement}>
              <Field label="標題">
                <Input value={annTitle} onChange={(e) => setAnnTitle(e.target.value)} required />
              </Field>
              <Field label="內容">
                <textarea
                  className="input"
                  rows={4}
                  value={annBody}
                  onChange={(e) => setAnnBody(e.target.value)}
                  required
                />
              </Field>
              <Field label="分店">
                <Select
                  value={annBranchId === '' ? '' : String(annBranchId)}
                  onChange={(e) => setAnnBranchId(e.target.value ? Number(e.target.value) : '')}
                >
                  <option value="">全館</option>
                  {activeBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" loading={busy}>
                建立
              </Button>
            </form>
          </Card>
          <div className="table-wrap mt-lg">
            <table className="data-table">
              <thead>
                <tr>
                  <th>標題</th>
                  <th>分店</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {announcements.map((a) => (
                  <tr key={a.id}>
                    <td>{a.title}</td>
                    <td>{a.branchId ?? '全館'}</td>
                    <td>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (!window.confirm('刪除此公告？')) return;
                          try {
                            const res = await deleteCmsAnnouncement(a.id);
                            toast(res.message || '已刪除', 'success');
                            void load();
                          } catch (err) {
                            toast(getErrorMessage(err, '刪除失敗'), 'error');
                          }
                        }}
                      >
                        刪除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {section === 'faq' && (
        <div className="hq-tab-panel">
          <Card title="新增 FAQ">
            <form onSubmit={onCreateFaq}>
              <Field label="問題">
                <Input value={faqQ} onChange={(e) => setFaqQ(e.target.value)} required />
              </Field>
              <Field label="答案">
                <textarea
                  className="input"
                  rows={3}
                  value={faqA}
                  onChange={(e) => setFaqA(e.target.value)}
                  required
                />
              </Field>
              <Button type="submit" loading={busy}>
                建立
              </Button>
            </form>
          </Card>
          <ul className="member-list mt-lg">
            {faqItems.map((f) => (
              <li key={f.id}>
                <Card title={f.question}>
                  <p>{f.answer}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await updateCmsFaq(f.id, { isActive: false });
                        toast('已停用', 'success');
                        void load();
                      } catch (err) {
                        toast(getErrorMessage(err, '更新失敗'), 'error');
                      }
                    }}
                  >
                    停用
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      if (!window.confirm('刪除 FAQ？')) return;
                      try {
                        await deleteCmsFaq(f.id);
                        toast('已刪除', 'success');
                        void load();
                      } catch (err) {
                        toast(getErrorMessage(err, '刪除失敗'), 'error');
                      }
                    }}
                  >
                    刪除
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      )}

      {section === 'branches' && (
        <div className="hq-tab-panel">
          <Card title="場館介紹">
            <form onSubmit={onSaveBranchIntro}>
              <Field label="分店">
                <Select
                  value={editBranchId === '' ? '' : String(editBranchId)}
                  onChange={(e) => setEditBranchId(e.target.value ? Number(e.target.value) : '')}
                >
                  {branchIntros.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="介紹文字">
                <textarea
                  className="input"
                  rows={6}
                  value={introText}
                  onChange={(e) => setIntroText(e.target.value)}
                />
              </Field>
              <label className="id-photo-consent" style={{ marginBottom: '0.75rem' }}>
                <input
                  type="checkbox"
                  checked={showOccupancy}
                  onChange={(e) => setShowOccupancy(e.target.checked)}
                />
                <span>對外顯示場館即時人數（看板／會員首頁）</span>
              </label>
              <Button type="submit" loading={busy}>
                儲存
              </Button>
            </form>
          </Card>
        </div>
      )}
    </PageSection>
  );
}
