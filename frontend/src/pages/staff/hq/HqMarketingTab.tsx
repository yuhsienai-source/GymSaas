import { type FormEvent, useEffect, useState } from 'react';
import { Button, Card, Field, Input, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createHqLotteryPool,
  createHqMarketingCampaign,
  drawHqLotteryPool,
  fetchHqDormantList,
  fetchHqLotteryPools,
  fetchHqMarketingCampaigns,
  getErrorMessage,
  issueHqGiftCard,
  sendHqMarketingCampaign,
} from '../../../lib/api';
import type { LotteryPool, MarketingCampaign } from '../../../types/api';

const SEGMENTS = [
  { value: 'DORMANT_BALANCE', label: '沉睡（餘額）' },
  { value: 'DORMANT_VISIT', label: '沉睡（未到館）' },
  { value: 'NO_RENEW', label: '未續課' },
  { value: 'UNUSED_SESSIONS', label: '未銷課' },
  { value: 'POST_CONSULT', label: '諮詢未購' },
];

export default function HqMarketingTab() {
  const { toast } = useToast();
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([]);
  const [pools, setPools] = useState<LotteryPool[]>([]);
  const [dormantSegment, setDormantSegment] = useState('DORMANT_VISIT');
  const [dormantItems, setDormantItems] = useState<unknown[]>([]);
  const [section, setSection] = useState<'campaigns' | 'dormant' | 'gift' | 'lottery'>('campaigns');
  const [busy, setBusy] = useState(false);

  const [campName, setCampName] = useState('');
  const [campSegment, setCampSegment] = useState('DORMANT_VISIT');
  const [campMessage, setCampMessage] = useState('');
  const [giftAmount, setGiftAmount] = useState('500');
  const [poolName, setPoolName] = useState('');

  const [reloadKey, setReloadKey] = useState(0);
  const load = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchHqMarketingCampaigns(), fetchHqLotteryPools()])
      .then(([campRes, poolRes]) => {
        if (cancelled) return;
        if (campRes.status === 'success' && campRes.data) setCampaigns(campRes.data);
        if (poolRes.status === 'success' && poolRes.data) setPools(poolRes.data);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入行銷資料失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  async function loadDormant() {
    setBusy(true);
    try {
      const res = await fetchHqDormantList(dormantSegment);
      if (res.status === 'success' && res.data) setDormantItems(res.data.items);
    } catch (err) {
      toast(getErrorMessage(err, '查詢名單失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateCampaign(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await createHqMarketingCampaign({
        name: campName.trim(),
        segment: campSegment,
        message: campMessage.trim(),
      });
      toast(res.message || '已建立', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') {
        setCampName('');
        setCampMessage('');
        void load();
      }
    } catch (err) {
      toast(getErrorMessage(err, '建立失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onIssueGift(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await issueHqGiftCard({ amount: Number(giftAmount) });
      if (res.status === 'success' && res.data) {
        toast(`已發行 ${res.data.code}`, 'success');
      } else {
        toast(res.message || '發行失敗', 'error');
      }
    } catch (err) {
      toast(getErrorMessage(err, '發行失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onCreatePool(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await createHqLotteryPool({ name: poolName.trim() });
      toast(res.message || '已建立', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') {
        setPoolName('');
        void load();
      }
    } catch (err) {
      toast(getErrorMessage(err, '建立失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageSection title="行銷 CRM" desc="活動推播、沉睡名單、禮物卡、抽獎">
      <nav className="hq-tabs" role="tablist">
        {(['campaigns', 'dormant', 'gift', 'lottery'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`hq-tabs__btn ${section === key ? 'is-active' : ''}`}
            onClick={() => setSection(key)}
          >
            {key === 'campaigns'
              ? '活動'
              : key === 'dormant'
                ? '沉睡名單'
                : key === 'gift'
                  ? '禮物卡'
                  : '抽獎'}
          </button>
        ))}
      </nav>

      {section === 'campaigns' && (
        <div className="hq-tab-panel">
          <Card title="建立推播活動">
            <form onSubmit={onCreateCampaign}>
              <Field label="名稱">
                <Input value={campName} onChange={(e) => setCampName(e.target.value)} required />
              </Field>
              <Field label="分群">
                <Select value={campSegment} onChange={(e) => setCampSegment(e.target.value)}>
                  {SEGMENTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="訊息">
                <textarea
                  className="input"
                  rows={3}
                  value={campMessage}
                  onChange={(e) => setCampMessage(e.target.value)}
                  required
                />
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
                  <th>名稱</th>
                  <th>分群</th>
                  <th>狀態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.segment}</td>
                    <td>{c.status}</td>
                    <td>
                      <Button
                        size="sm"
                        onClick={async () => {
                          try {
                            const res = await sendHqMarketingCampaign(c.id);
                            toast(res.message || '已推播', 'success');
                          } catch (err) {
                            toast(getErrorMessage(err, '推播失敗'), 'error');
                          }
                        }}
                      >
                        推播
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {section === 'dormant' && (
        <div className="hq-tab-panel">
          <Card title="沉睡／未轉換名單">
            <Field label="分群">
              <Select value={dormantSegment} onChange={(e) => setDormantSegment(e.target.value)}>
                {SEGMENTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button onClick={() => void loadDormant()} loading={busy}>
              查詢
            </Button>
            <p className="text-muted text-sm mt-md">共 {dormantItems.length} 筆</p>
            <ul className="member-list">
              {dormantItems.slice(0, 50).map((item, i) => (
                <li key={i}>
                  <code>{JSON.stringify(item)}</code>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {section === 'gift' && (
        <Card title="發行禮物卡">
          <form onSubmit={onIssueGift}>
            <Field label="面額">
              <Input
                type="number"
                value={giftAmount}
                onChange={(e) => setGiftAmount(e.target.value)}
                min={1}
                required
              />
            </Field>
            <Button type="submit" loading={busy}>
              發行
            </Button>
          </form>
        </Card>
      )}

      {section === 'lottery' && (
        <div className="hq-tab-panel">
          <Card title="新增抽獎池">
            <form onSubmit={onCreatePool}>
              <Field label="名稱">
                <Input value={poolName} onChange={(e) => setPoolName(e.target.value)} required />
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
                  <th>名稱</th>
                  <th>狀態</th>
                  <th>報名</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.status}</td>
                    <td>{p._count?.entries ?? 0}</td>
                    <td>
                      <Button
                        size="sm"
                        onClick={async () => {
                          try {
                            const res = await drawHqLotteryPool(p.id);
                            toast(res.message || '已開獎', 'success');
                            void load();
                          } catch (err) {
                            toast(getErrorMessage(err, '開獎失敗'), 'error');
                          }
                        }}
                      >
                        開獎
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageSection>
  );
}
