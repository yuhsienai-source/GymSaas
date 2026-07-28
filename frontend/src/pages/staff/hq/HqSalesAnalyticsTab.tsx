import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Field, Input, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  fetchSalesAnalytics,
  getErrorMessage,
  type ReportPayload,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import { defaultReportRange, downloadCsv } from '../../../lib/csvExport';
import type { Branch, Trainer } from '../../../types/api';

type AnalyticsKind = 'overview' | 'daily' | 'branch' | 'pay-mix' | 'products' | 'trainer';

const ANALYTICS_KINDS: { key: AnalyticsKind; label: string; desc: string }[] = [
  { key: 'overview', label: '營收總覽', desc: '儲值／商品／進出場／私教合計' },
  { key: 'daily', label: '每日趨勢', desc: '依日拆解各渠道營收' },
  { key: 'branch', label: '分店商品銷售', desc: '各分店商品銷售比較' },
  { key: 'pay-mix', label: '付款結構', desc: '儲值＋商品的付款方式占比' },
  { key: 'products', label: '熱銷商品', desc: '銷售金額／件數排行（前 50）' },
  { key: 'trainer', label: '教練績效', desc: '私教合約與團課預約彙總' },
];

function fmtMoney(v: unknown) {
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return `$${n.toLocaleString('zh-TW')}`;
}

type Props = {
  branches: Branch[];
  trainers: Trainer[];
};

export default function HqSalesAnalyticsTab({ branches, trainers }: Props) {
  const { toast } = useToast();
  const range = defaultReportRange();
  const [kind, setKind] = useState<AnalyticsKind>('overview');
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [q, setQ] = useState('');
  const [branchId, setBranchId] = useState<number | ''>('');
  const [trainerId, setTrainerId] = useState<number | ''>('');
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<ReportPayload<Record<string, unknown>> | null>(null);

  const kindMeta = ANALYTICS_KINDS.find((k) => k.key === kind);
  const trainersForBranch =
    branchId === ''
      ? trainers
      : trainers.filter((t) =>
          (t.branches || []).some((b) => b.branchId === branchId),
        );

  const trainerValid =
    trainerId === '' ||
    branchId === '' ||
    trainers.some(
      (t) =>
        t.id === trainerId &&
        (t.branches || []).some((b) => b.branchId === branchId),
    );
  const effectiveTrainerId = trainerValid ? trainerId : '';

  const runQuery = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchSalesAnalytics({
        kind,
        from: from || undefined,
        to: to || undefined,
        q: kind === 'trainer' ? q.trim() || undefined : undefined,
        branchId: branchId ? Number(branchId) : undefined,
        trainerId: kind === 'trainer' && effectiveTrainerId ? Number(effectiveTrainerId) : undefined,
      });
      if (res.status === 'success' && res.data) {
        setPayload(res.data);
      } else {
        setPayload(null);
        toast(res.message || '查詢失敗', 'error');
      }
    } catch (err) {
      setPayload(null);
      toast(getErrorMessage(err, '查詢銷售分析失敗'), 'error');
    } finally {
      setLoading(false);
    }
  }, [kind, from, to, q, branchId, effectiveTrainerId, toast]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await fetchSalesAnalytics({
          kind,
          from: from || undefined,
          to: to || undefined,
          q: kind === 'trainer' ? q.trim() || undefined : undefined,
          branchId: branchId ? Number(branchId) : undefined,
          trainerId: kind === 'trainer' && effectiveTrainerId ? Number(effectiveTrainerId) : undefined,
        });
        if (cancelled) return;
        if (res.status === 'success' && res.data) {
          setPayload(res.data);
        } else {
          setPayload(null);
          toast(res.message || '查詢失敗', 'error');
        }
      } catch (err) {
        if (cancelled) return;
        setPayload(null);
        toast(getErrorMessage(err, '查詢銷售分析失敗'), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 切換分析項目時自動查
  }, [kind]);

  function handleExport() {
    if (!payload?.rows?.length) {
      toast('沒有可輸出的資料', 'error');
      return;
    }
    const stamp = `${from || 'all'}_${to || 'all'}`;
    const label = kindMeta?.label || kind;

    if (kind === 'overview') {
      downloadCsv(
        `營收總覽_${stamp}`,
        ['項目', '金額', '筆數'],
        payload.rows.map((r) => [String(r.metric ?? ''), Number(r.amount) || 0, Number(r.count) || 0]),
      );
    } else if (kind === 'daily') {
      downloadCsv(
        `每日趨勢_${stamp}`,
        ['日期', '儲值', '商品', '進出場', '私教', '合計'],
        payload.rows.map((r) => [
          String(r.date ?? ''),
          Number(r.topupAmount) || 0,
          Number(r.salesAmount) || 0,
          Number(r.gateFee) || 0,
          Number(r.ptRevenue) || 0,
          Number(r.total) || 0,
        ]),
      );
    } else if (kind === 'branch') {
      downloadCsv(
        `分店商品銷售_${stamp}`,
        ['分店', '銷售金額', '單數', '件數'],
        payload.rows.map((r) => [
          String(r.branchName ?? ''),
          Number(r.salesAmount) || 0,
          Number(r.salesCount) || 0,
          Number(r.itemQty) || 0,
        ]),
      );
    } else if (kind === 'pay-mix') {
      downloadCsv(
        `付款結構_${stamp}`,
        ['付款方式', '金額', '占比%'],
        payload.rows.map((r) => [String(r.method ?? ''), Number(r.amount) || 0, Number(r.share) || 0]),
      );
    } else if (kind === 'products') {
      downloadCsv(
        `熱銷商品_${stamp}`,
        ['商品ID', '名稱', '件數', '金額'],
        payload.rows.map((r) => [
          Number(r.productId) || '',
          String(r.name ?? ''),
          Number(r.qty) || 0,
          Number(r.amount) || 0,
        ]),
      );
    } else {
      downloadCsv(
        `教練績效_${stamp}`,
        ['教練', '電話', '合約數', '銷售堂數', '已用堂數', '剩餘堂數', '私教營收', '團課數', '預約人次'],
        payload.rows.map((r) => [
          String(r.trainerName ?? ''),
          String(r.phone ?? ''),
          Number(r.contractCount) || 0,
          Number(r.sessionsSold) || 0,
          Number(r.sessionsUsed) || 0,
          Number(r.sessionsRemaining) || 0,
          Number(r.ptRevenue) || 0,
          Number(r.classCount) || 0,
          Number(r.reservationCount) || 0,
        ]),
      );
    }
    toast(`${label} CSV 已下載`, 'success');
  }

  const summary = payload?.summary;
  const rows = payload?.rows ?? [];

  return (
    <PageSection title="銷售分析" desc="依期間／分店彙總各渠道營收與結構，明細請至「一般報表」">
      <div className="hq-tabs hq-tabs--desktop" role="tablist" aria-label="銷售分析項目">
        {ANALYTICS_KINDS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={kind === item.key}
            className={`hq-tabs__btn ${kind === item.key ? 'is-active' : ''}`}
            onClick={() => setKind(item.key)}
            title={item.desc}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="hq-kind-select">
        <Field label="分析項目" hint={kindMeta?.desc}>
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as AnalyticsKind)}
            aria-label="銷售分析項目"
          >
            {ANALYTICS_KINDS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Card
          title={kindMeta?.label || '分析'}
          subtitle={`${kindMeta?.desc || ''} · 變更條件後請按「查詢」`}
        >
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void runQuery();
          }}
          style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
        >
          <Field label="起日">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="迄日">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="分店">
            <Select
              value={branchId === '' ? '' : String(branchId)}
              onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">全部分店</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {staffBranchLabel(b)}
                </option>
              ))}
            </Select>
          </Field>
          {kind === 'trainer' && (
            <>
              <Field label="教練">
                <Select
                  value={effectiveTrainerId === '' ? '' : String(effectiveTrainerId)}
                  onChange={(e) => setTrainerId(e.target.value ? Number(e.target.value) : '')}
                >
                  <option value="">全部教練</option>
                  {trainersForBranch.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="關鍵字">
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="教練姓名／電話"
                />
              </Field>
            </>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem' }}>
            <Button type="submit" disabled={loading}>
              {loading ? '分析中…' : '查詢'}
            </Button>
            <Button type="button" variant="secondary" onClick={handleExport} disabled={!rows.length}>
              輸出 CSV
            </Button>
          </div>
        </form>
      </Card>

      {summary && (
        <div
          className="wallet-row"
          style={{ margin: '0.75rem 0', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
        >
          {kind === 'overview' && (
            <>
              <div className="stat-card">
                <span className="stat-card__label">合計營收</span>
                <div className="stat-card__value">{fmtMoney(summary.totalRevenue)}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">儲值</span>
                <div className="stat-card__value">{fmtMoney(summary.topupAmount)}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">商品</span>
                <div className="stat-card__value">{fmtMoney(summary.salesAmount)}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">進出場</span>
                <div className="stat-card__value">{fmtMoney(summary.gateFee)}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">私教</span>
                <div className="stat-card__value">{fmtMoney(summary.ptRevenue)}</div>
              </div>
            </>
          )}
          {kind === 'daily' && (
            <>
              <div className="stat-card">
                <span className="stat-card__label">天數</span>
                <div className="stat-card__value">{summary.dayCount ?? 0}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">期間合計</span>
                <div className="stat-card__value">{fmtMoney(summary.totalRevenue)}</div>
              </div>
            </>
          )}
          {kind === 'branch' && (
            <>
              <div className="stat-card">
                <span className="stat-card__label">分店數</span>
                <div className="stat-card__value">{summary.branchCount ?? 0}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">商品營收</span>
                <div className="stat-card__value">{fmtMoney(summary.salesAmount)}</div>
              </div>
            </>
          )}
          {kind === 'pay-mix' && (
            <>
              <div className="stat-card">
                <span className="stat-card__label">付款合計</span>
                <div className="stat-card__value">{fmtMoney(summary.totalAmount)}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">方式數</span>
                <div className="stat-card__value">{summary.methodCount ?? 0}</div>
              </div>
            </>
          )}
          {kind === 'products' && (
            <>
              <div className="stat-card">
                <span className="stat-card__label">品項數</span>
                <div className="stat-card__value">{summary.productCount ?? 0}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">銷售金額</span>
                <div className="stat-card__value">{fmtMoney(summary.salesAmount)}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">件數</span>
                <div className="stat-card__value">{summary.itemQty ?? 0}</div>
              </div>
            </>
          )}
          {kind === 'trainer' && (
            <>
              <div className="stat-card">
                <span className="stat-card__label">教練</span>
                <div className="stat-card__value">{summary.trainerCount ?? 0}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">私教營收</span>
                <div className="stat-card__value">{fmtMoney(summary.ptRevenue)}</div>
              </div>
              <div className="stat-card">
                <span className="stat-card__label">已用堂數</span>
                <div className="stat-card__value">{summary.sessionsUsed ?? 0}</div>
              </div>
            </>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            {kind === 'overview' && (
              <tr>
                <th>項目</th>
                <th>金額</th>
                <th>筆數</th>
                <th>占比%</th>
              </tr>
            )}
            {kind === 'daily' && (
              <tr>
                <th>日期</th>
                <th>儲值</th>
                <th>商品</th>
                <th>進出場</th>
                <th>私教</th>
                <th>合計</th>
              </tr>
            )}
            {kind === 'branch' && (
              <tr>
                <th>分店</th>
                <th>銷售金額</th>
                <th>單數</th>
                <th>件數</th>
              </tr>
            )}
            {kind === 'pay-mix' && (
              <tr>
                <th>付款方式</th>
                <th>金額</th>
                <th>占比%</th>
              </tr>
            )}
            {kind === 'products' && (
              <tr>
                <th>商品ID</th>
                <th>商品名稱</th>
                <th>件數</th>
                <th>金額</th>
              </tr>
            )}
            {kind === 'trainer' && (
              <tr>
                <th>教練ID</th>
                <th>教練</th>
                <th>電話</th>
                <th>合約數</th>
                <th>銷售堂數</th>
                <th>已用堂數</th>
                <th>剩餘堂數</th>
                <th>私教營收</th>
                <th>團課數</th>
                <th>預約人次</th>
              </tr>
            )}
          </thead>
          <tbody>
            {!rows.length && (
              <tr>
                <td colSpan={10} className="text-muted text-center">
                  {loading ? '載入中…' : '此條件尚無資料'}
                </td>
              </tr>
            )}
            {kind === 'overview' &&
              rows.map((r) => {
                const amount = Number(r.amount) || 0;
                const total = Number(summary?.totalRevenue) || 0;
                const share = total > 0 ? Math.round((amount / total) * 1000) / 10 : 0;
                return (
                  <tr key={String(r.metric)}>
                    <td>{String(r.metric ?? '')}</td>
                    <td>{fmtMoney(amount)}</td>
                    <td>{Number(r.count) || 0}</td>
                    <td>{share}</td>
                  </tr>
                );
              })}
            {kind === 'daily' &&
              rows.map((r) => (
                <tr key={String(r.date)}>
                  <td className="mono text-sm">{String(r.date ?? '')}</td>
                  <td>{fmtMoney(r.topupAmount)}</td>
                  <td>{fmtMoney(r.salesAmount)}</td>
                  <td>{fmtMoney(r.gateFee)}</td>
                  <td>{fmtMoney(r.ptRevenue)}</td>
                  <td>{fmtMoney(r.total)}</td>
                </tr>
              ))}
            {kind === 'branch' &&
              rows.map((r) => (
                <tr key={String(r.branchId)}>
                  <td>{String(r.branchName ?? '')}</td>
                  <td>{fmtMoney(r.salesAmount)}</td>
                  <td>{Number(r.salesCount) || 0}</td>
                  <td>{Number(r.itemQty) || 0}</td>
                </tr>
              ))}
            {kind === 'pay-mix' &&
              rows.map((r) => (
                <tr key={String(r.method)}>
                  <td className="mono">{String(r.method ?? '')}</td>
                  <td>{fmtMoney(r.amount)}</td>
                  <td>{Number(r.share) || 0}</td>
                </tr>
              ))}
            {kind === 'products' &&
              rows.map((r) => (
                <tr key={String(r.productId)}>
                  <td className="mono text-sm">#{String(r.productId)}</td>
                  <td>{String(r.name ?? '')}</td>
                  <td>{Number(r.qty) || 0}</td>
                  <td>{fmtMoney(r.amount)}</td>
                </tr>
              ))}
            {kind === 'trainer' &&
              rows.map((r) => (
                <tr key={String(r.trainerId)}>
                  <td className="mono text-sm">#{String(r.trainerId)}</td>
                  <td>{String(r.trainerName ?? '')}</td>
                  <td className="mono text-sm">{String(r.phone ?? '—')}</td>
                  <td>{Number(r.contractCount) || 0}</td>
                  <td>{Number(r.sessionsSold) || 0}</td>
                  <td>{Number(r.sessionsUsed) || 0}</td>
                  <td>{Number(r.sessionsRemaining) || 0}</td>
                  <td>{fmtMoney(r.ptRevenue)}</td>
                  <td>{Number(r.classCount) || 0}</td>
                  <td>{Number(r.reservationCount) || 0}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </PageSection>
  );
}
