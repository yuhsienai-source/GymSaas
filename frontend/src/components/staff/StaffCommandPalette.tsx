import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchOpsMembers, getErrorMessage } from '../../lib/api';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { useToast } from '../../contexts/ToastContext';

type CmdItem = {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  keywords?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

type MemberHit = { id: number; name: string; phone: string; memberNo?: string | null };

/** 短時 per-query 快取（避免連打同一關鍵字） */
const queryCache = new Map<string, { at: number; rows: MemberHit[] }>();
const QUERY_CACHE_TTL_MS = 30_000;
const NO_MEMBERS: MemberHit[] = [];

export default function StaffCommandPalette({ open, onClose }: Props) {
  return open ? <CommandPaletteBody onClose={onClose} /> : null;
}

/** 僅在開啟時掛載，關閉即卸載，重開時搜尋字／結果自動歸零 */
function CommandPaletteBody({ onClose }: Pick<Props, 'onClose'>) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isAdmin, canAccessTx, hasPermission } = useStaffAuth();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [memberResult, setMemberResult] = useState<{ needle: string; rows: MemberHit[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const canSearchMembers = hasPermission('ops') || isAdmin;
  const needle = q.trim();
  const searchingMembers = canSearchMembers && needle.length > 0;
  const memberResultFresh = memberResult?.needle === needle;
  const members = searchingMembers && memberResultFresh ? memberResult.rows : NO_MEMBERS;
  const memberSearchBusy = searchingMembers && !memberResultFresh;

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!searchingMembers) return;
    let cancelled = false;
    const cached = queryCache.get(needle);
    const cacheHit = cached && Date.now() - cached.at < QUERY_CACHE_TTL_MS ? cached.rows : null;
    const t = window.setTimeout(
      () => {
        if (cacheHit) {
          setMemberResult({ needle, rows: cacheHit });
          return;
        }
        fetchOpsMembers({ lite: true, take: 80, q: needle })
          .then((res) => {
            if (cancelled) return;
            if (res.status !== 'success' || !res.data) {
              setMemberResult({ needle, rows: [] });
              return;
            }
            const rows = res.data.items.map((m) => ({
              id: m.id,
              name: m.name,
              phone: m.phone,
              memberNo: m.memberNo,
            }));
            queryCache.set(needle, { at: Date.now(), rows });
            setMemberResult({ needle, rows });
          })
          .catch((err) => {
            if (cancelled) return;
            setMemberResult({ needle, rows: [] });
            toast(getErrorMessage(err, '搜尋會員失敗'), 'error');
          });
      },
      cacheHit ? 0 : 200,
    );

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [needle, searchingMembers, toast]);

  const navItems = useMemo(() => {
    const items: CmdItem[] = [];
    if (hasPermission('ops') || isAdmin) {
      items.push({
        id: 'nav-ops',
        label: '櫃檯維運',
        icon: '🏪',
        keywords: 'ops checkout 結帳',
        run: () => navigate('/staff/ops'),
      });
    }
    if (canAccessTx) {
      items.push({
        id: 'nav-inv',
        label: '進銷存',
        icon: '📦',
        keywords: 'inventory stock',
        run: () => navigate('/staff/inventory'),
      });
      items.push({
        id: 'nav-tx',
        label: '交易異動',
        icon: '🔁',
        keywords: 'tx refund 退費',
        run: () => navigate('/staff/tx'),
      });
    }
    if (isAdmin) {
      items.push({
        id: 'nav-hq',
        label: '總部 HQ',
        icon: '🏢',
        keywords: 'hq admin 總部 分析',
        run: () => navigate('/staff/hq'),
      });
      items.push({
        id: 'nav-hq-analytics',
        label: '銷售分析',
        icon: '📊',
        keywords: 'analytics 營收',
        run: () => navigate('/staff/hq?tab=salesAnalytics'),
      });
    }
    if (hasPermission('trainer') || isAdmin) {
      items.push({
        id: 'nav-trainer',
        label: '教練服務台',
        icon: '🏋️',
        keywords: 'trainer 約課 課表',
        run: () => navigate('/staff/trainer'),
      });
    }
    return items;
  }, [canAccessTx, hasPermission, isAdmin, navigate]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list: CmdItem[] = [...navItems];

    if (needle.length >= 1) {
      const matched = members.slice(0, 8).map((m) => ({
        id: `m-${m.id}`,
        label: m.name,
        hint: `${m.phone}${m.memberNo ? ` · ${m.memberNo}` : ''}`,
        icon: '👤',
        run: () => navigate(`/staff/ops?tab=checkout&memberId=${m.id}`),
      }));
      list.unshift(...matched);
    }

    if (!needle) return list;
    return list.filter((item) => {
      if (item.id.startsWith('m-')) return true;
      const blob = `${item.label} ${item.hint || ''} ${item.keywords || ''}`.toLowerCase();
      return blob.includes(needle);
    });
  }, [members, navItems, navigate, q]);

  const activeResetKey = `${q}|${items.length}`;
  const [prevActiveResetKey, setPrevActiveResetKey] = useState(activeResetKey);
  if (prevActiveResetKey !== activeResetKey) {
    setPrevActiveResetKey(activeResetKey);
    setActive(0);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[active];
        if (item) {
          item.run();
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, items, onClose]);

  return (
    <div
      className="cmdk-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="全域搜尋">
        <input
          ref={inputRef}
          className="cmdk__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜尋會員、功能…"
          aria-label="搜尋"
        />
        {items.length === 0 ? (
          <p className="cmdk__empty">
            {memberSearchBusy && q.trim() ? '搜尋中…' : '沒有符合的結果'}
          </p>
        ) : (
          <ul className="cmdk__list" role="listbox">
            {items.map((item, idx) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === active}
                  className={`cmdk__item ${idx === active ? 'is-active' : ''}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => {
                    item.run();
                    onClose();
                  }}
                >
                  <span className="cmdk__item-icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                  {item.hint ? <span className="cmdk__item-meta">{item.hint}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="cmdk__hint">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 移動
          </span>
          <span>
            <kbd>Enter</kbd> 開啟
          </span>
          <span>
            <kbd>Esc</kbd> 關閉
          </span>
        </div>
      </div>
    </div>
  );
}
