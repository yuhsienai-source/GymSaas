import { type FormEvent, useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  clearHqMemberAlert,
  compensateHqMemberBonus,
  compensateHqMemberCourse,
  compensateHqMemberExpire,
  fetchHqCompensationLogs,
  fetchHqCoursePlans,
  fetchHqPromotions,
  getErrorMessage,
  searchHqMembers,
} from '../../../lib/api';
import type { CoursePlan, HqCompensationLog, OpsMember, Promotion } from '../../../types/api';
import type { HqDataProps } from './types';

type ActionKey = 'bonus' | 'expire' | 'clear' | 'course';

function fmtDate(v?: string | null) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('zh-TW');
  } catch {
    return String(v);
  }
}

export default function HqCompensationTab({
  branches,
  trainers,
}: Pick<HqDataProps, 'branches' | 'trainers'>) {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<
    Pick<
      OpsMember,
      | 'id'
      | 'memberNo'
      | 'name'
      | 'phone'
      | 'plan'
      | 'expireDate'
      | 'cashWallet'
      | 'bonusWallet'
      | 'isAlert'
    >[]
  >([]);
  const [selected, setSelected] = useState<(typeof hits)[number] | null>(null);
  const [action, setAction] = useState<ActionKey>('bonus');
  const [reason, setReason] = useState('');
  const [promotionId, setPromotionId] = useState<number | ''>('');
  const [coursePlanId, setCoursePlanId] = useState<number | ''>('');
  const [trainerId, setTrainerId] = useState<number | ''>('');
  const [days, setDays] = useState('1');
  const [compPromos, setCompPromos] = useState<Promotion[]>([]);
  const [compCourses, setCompCourses] = useState<CoursePlan[]>([]);
  const [logs, setLogs] = useState<HqCompensationLog[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchHqPromotions(undefined, 'COMPENSATION'),
      fetchHqCoursePlans(undefined, 'COMPENSATION'),
    ])
      .then(([promoRes, courseRes]) => {
        if (cancelled) return;
        if (promoRes.status === 'success' && promoRes.data) {
          setCompPromos(promoRes.data.filter((p) => p.isActive !== false));
        }
        if (courseRes.status === 'success' && courseRes.data) {
          setCompCourses(courseRes.data.filter((p) => p.isActive !== false));
        }
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入補償專案失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const [logsQuery, setLogsQuery] = useState<{ memberId?: number; seq: number }>({ seq: 0 });
  const loadLogs = (memberId?: number) => setLogsQuery((q) => ({ memberId, seq: q.seq + 1 }));

  useEffect(() => {
    let cancelled = false;
    fetchHqCompensationLogs({ memberId: logsQuery.memberId, limit: 30 })
      .then((res) => {
        if (!cancelled && res.status === 'success' && res.data) setLogs(res.data);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入補償日誌失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [logsQuery, toast]);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await searchHqMembers(query);
      if (res.status === 'success' && res.data) {
        setHits(res.data);
        if (res.data.length === 1) {
          setSelected(res.data[0]);
          void loadLogs(res.data[0].id);
        }
        toast(res.data.length ? `找到 ${res.data.length} 位` : '無符合會員', 'info');
      }
    } catch (err) {
      toast(getErrorMessage(err, '搜尋失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selected) {
      toast('請先選擇會員', 'error');
      return;
    }
    if (!reason.trim() || reason.trim().length < 4) {
      toast('請填寫原因／客訴結案單號（至少 4 字）', 'error');
      return;
    }
    setBusy(true);
    try {
      if (action === 'bonus') {
        if (!promotionId) {
          toast('請選擇客訴補償專案（禁止自填金額）', 'error');
          return;
        }
        const res = await compensateHqMemberBonus(selected.id, {
          promotionId: Number(promotionId),
          reason: reason.trim(),
        });
        toast(res.message || '已配發運動金', 'success');
        if (res.data?.member) setSelected({ ...selected, ...res.data.member });
      } else if (action === 'course') {
        if (!coursePlanId) {
          toast('請選擇客訴補償課程（禁止自填堂數）', 'error');
          return;
        }
        if (!trainerId) {
          toast('請選擇綁定教練', 'error');
          return;
        }
        const res = await compensateHqMemberCourse(selected.id, {
          coursePlanId: Number(coursePlanId),
          trainerId: Number(trainerId),
          reason: reason.trim(),
        });
        toast(res.message || '已補償贈送課程', 'success');
      } else if (action === 'expire') {
        const res = await compensateHqMemberExpire(selected.id, {
          days: parseInt(days, 10),
          reason: reason.trim(),
        });
        toast(res.message || '已補償效期', 'success');
        if (res.data?.member) setSelected({ ...selected, ...res.data.member });
      } else {
        const res = await clearHqMemberAlert(selected.id, { reason: reason.trim() });
        toast(res.message || '已解除警示', 'success');
        if (res.data?.member) setSelected({ ...selected, ...res.data.member });
      }
      setReason('');
      await loadLogs(selected.id);
    } catch (err) {
      toast(getErrorMessage(err, '合規補償失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const branchName = (branchId?: number) =>
    branches.find((b) => b.id === branchId)?.name || (branchId ? `#${branchId}` : '—');

  return (
    <PageSection
      title="合規補償"
      desc="運動金／補償課程僅能綁定專案；效期展延與解鎖警示皆須填原因並寫入日誌。補償課程合約 source=COMPENSATION，與付費購案區隔。"
    >
      <Alert tone="warning">
        嚴禁自填補償金額／堂數。請先於「儲值方案／課程方案」建立 kind=COMPENSATION、price=$0
        的專案，再於此配發。
      </Alert>

      <div className="hq-grid-2" style={{ display: 'grid', gap: '1rem', gridTemplateColumns: '1fr 1fr' }}>
        <Card title="查詢會員" subtitle="手機／會員編號／姓名">
          <form onSubmit={handleSearch} className="form-stack">
            <Field label="關鍵字">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="0912… 或 A3K9XZ" />
            </Field>
            <Button type="submit" disabled={busy || query.trim().length < 2}>
              搜尋
            </Button>
          </form>
          {hits.length > 0 && (
            <ul className="text-sm" style={{ marginTop: '0.75rem', paddingLeft: 0, listStyle: 'none' }}>
              {hits.map((m) => (
                <li key={m.id} style={{ marginBottom: '0.35rem' }}>
                  <button
                    type="button"
                    className={`hq-tabs__btn ${selected?.id === m.id ? 'is-active' : ''}`}
                    onClick={() => {
                      setSelected(m);
                      void loadLogs(m.id);
                    }}
                  >
                    {m.memberNo || `#${m.id}`} · {m.name} · {m.phone}
                    {m.isAlert ? ' · 警示' : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="執行補償"
          subtitle={
            selected
              ? `${selected.name}（${selected.memberNo || selected.id}）· ${selected.plan} · 運動金 $${selected.bonusWallet ?? 0} · 效期 ${fmtDate(selected.expireDate)}${selected.isAlert ? ' · 警示中' : ''}`
              : '請先選擇會員'
          }
        >
          <form onSubmit={handleSubmit} className="form-stack">
            <Field label="手段">
              <Select
                value={action}
                onChange={(e) => setAction(e.target.value as ActionKey)}
              >
                <option value="bonus">補償運動金（綁定專案）</option>
                <option value="course">補償課程（贈送堂數）</option>
                <option value="expire">補償效期（展延 expireDate）</option>
                <option value="clear">解鎖帳號（清除 isAlert）</option>
              </Select>
            </Field>

            {action === 'bonus' && (
              <Field label="客訴補償專案" hint="僅列出 kind=COMPENSATION 且上架中">
                <Select
                  value={promotionId === '' ? '' : String(promotionId)}
                  onChange={(e) =>
                    setPromotionId(e.target.value ? Number(e.target.value) : '')
                  }
                >
                  <option value="">— 選擇 —</option>
                  {compPromos.map((p) => (
                    <option key={p.id} value={p.id}>
                      #{p.id} {p.name} · SC ${p.bonusGiven} · {branchName(p.branchId)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            {action === 'course' && (
              <>
                <Field label="客訴補償課程" hint="僅列出 kind=COMPENSATION 私教方案；堂數以方案為準">
                  <Select
                    value={coursePlanId === '' ? '' : String(coursePlanId)}
                    onChange={(e) =>
                      setCoursePlanId(e.target.value ? Number(e.target.value) : '')
                    }
                  >
                    <option value="">— 選擇 —</option>
                    {compCourses.map((p) => (
                      <option key={p.id} value={p.id}>
                        #{p.id} {p.name} · {p.sessions ?? '?'} 堂 · {branchName(p.branchId)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="綁定教練" hint="補償堂數歸屬此教練合約">
                  <Select
                    value={trainerId === '' ? '' : String(trainerId)}
                    onChange={(e) =>
                      setTrainerId(e.target.value ? Number(e.target.value) : '')
                    }
                  >
                    <option value="">— 選擇 —</option>
                    {trainers
                      .filter((t) => t.isActive !== false)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.displayName ? `（${t.displayName}）` : ''}
                        </option>
                      ))}
                  </Select>
                </Field>
              </>
            )}

            {action === 'expire' && (
              <Field label="補償天數" hint="單次最多 90 天">
                <Input
                  type="number"
                  min={1}
                  max={90}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </Field>
            )}

            <Field label="原因／客訴結案單號" hint="必填，寫入 HqCompensationLog">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例：CS-20260729-001 系統無法進場補償"
              />
            </Field>

            <Button type="submit" disabled={busy || !selected}>
              確認執行
            </Button>
          </form>
        </Card>
      </div>

      <Card title="補償日誌" subtitle="最近 30 筆（可依選定會員篩選）">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>動作</th>
                <th>會員</th>
                <th>原因</th>
                <th>操作者</th>
                <th>明細</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    尚無紀錄
                  </td>
                </tr>
              ) : (
                logs.map((l) => (
                  <tr key={l.id}>
                    <td>{fmtDate(l.createdAt)}</td>
                    <td>{l.action}</td>
                    <td>
                      {l.member?.memberNo || l.memberId} {l.member?.name || ''}
                    </td>
                    <td>{l.reason}</td>
                    <td>{l.actorStaff?.name || l.actorStaffId}</td>
                    <td className="text-sm text-muted">
                      {l.promotion
                        ? `${l.promotion.name} / SC $${l.promotion.bonusGiven}`
                        : l.coursePlan
                          ? `${l.coursePlan.name} / ${l.coursePlan.sessions ?? '?'} 堂`
                          : l.detail
                            ? JSON.stringify(l.detail)
                            : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </PageSection>
  );
}
