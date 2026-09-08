import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import LandingLayout from '../../components/layout/LandingLayout';
import { Card } from '../../components/ui';

interface OccupancySnapshot {
  presentCount: number;
  capacity: number;
  available: number;
  utilization: number;
  isFull: boolean;
  updatedAt: string;
  recent?: Array<{
    name: string;
    billingMode: string;
    checkInAt: string;
  }>;
}

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws/occupancy`;
}

export default function BoardPage() {
  const [snapshot, setSnapshot] = useState<OccupancySnapshot | null>(null);
  const [status, setStatus] = useState('連線中…');
  const [displayEnabled, setDisplayEnabled] = useState(true);

  useEffect(() => {
    let closed = false;
    let timer: number | undefined;
    let socket: WebSocket | null = null;
    let shouldReconnect = true;

    async function loadSettingsAndOnce() {
      try {
        const settingsRes = await fetch('/api/board/occupancy-settings');
        const settingsJson = await settingsRes.json();
        const show =
          settingsJson.status === 'success' && settingsJson.data?.isDisplay === true;
        if (closed) return false;
        if (!show) {
          setDisplayEnabled(false);
          setSnapshot(null);
          setStatus('容留人數顯示已關閉');
          shouldReconnect = false;
          return false;
        }
        setDisplayEnabled(true);
        const res = await fetch('/api/board/occupancy');
        const json = await res.json();
        if (closed) return false;
        if (json.meta?.isDisplay === false || json.data == null) {
          setDisplayEnabled(false);
          setSnapshot(null);
          setStatus('容留人數顯示已關閉');
          shouldReconnect = false;
          return false;
        }
        if (json.status === 'success') setSnapshot(json.data);
        return true;
      } catch {
        if (!closed) setStatus('REST 讀取失敗，改等 WebSocket…');
        return true;
      }
    }

    function connect() {
      socket = new WebSocket(wsUrl());
      socket.onopen = () => {
        if (!closed) setStatus('WebSocket 已連線');
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'occupancy') {
            setSnapshot(msg.data);
            setStatus(
              msg.event
                ? `即時更新 · ${msg.event}`
                : `即時更新 · ${new Date().toLocaleTimeString('zh-TW')}`,
            );
          }
        } catch {
          /* ignore */
        }
      };
      socket.onclose = () => {
        if (closed || !shouldReconnect) return;
        setStatus('連線中斷，3 秒後重連…');
        timer = window.setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    }

    void (async () => {
      const ok = await loadSettingsAndOnce();
      if (!closed && ok) connect();
    })();

    return () => {
      closed = true;
      shouldReconnect = false;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  const utilPct = snapshot ? Math.round(snapshot.utilization * 100) : 0;

  return (
    <LandingLayout>
      <section className="hero">
        <div className="board-hero__top">
          <Link to="/portal" className="board-leave">
            ← 離開
          </Link>
        </div>
        <span className="hero__badge">Live Board</span>
        <h1>場內容留人數</h1>
        <p>{status}</p>
      </section>

      {!displayEnabled ? (
        <Card variant="elevated" padding="lg" className="text-center">
          <p className="text-muted">目前不對外顯示即時人數</p>
        </Card>
      ) : (
        <Card variant="elevated" padding="lg" className="text-center">
          <div style={{ fontSize: 'clamp(4rem, 18vw, 8rem)', fontWeight: 800, lineHeight: 1 }}>
            {snapshot ? snapshot.presentCount : '—'}
          </div>
          <div
            style={{
              height: 12,
              margin: '1rem auto',
              maxWidth: 480,
              borderRadius: 999,
              background: 'rgba(15,23,42,.12)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, utilPct)}%`,
                background: snapshot?.isFull ? '#b45309' : '#083d4f',
                transition: 'width .5s ease',
              }}
            />
          </div>
          <div className="feature-strip" style={{ justifyContent: 'center' }}>
            <div className="feature-chip">
              <strong>上限</strong> {snapshot?.capacity ?? '—'}
            </div>
            <div className="feature-chip">
              <strong>剩餘</strong> {snapshot?.available ?? '—'}
            </div>
            <div className="feature-chip">
              <strong>使用率</strong> {snapshot ? `${utilPct}%` : '—'}
            </div>
          </div>
          <ul className="info-list" style={{ textAlign: 'left', marginTop: '1.5rem' }}>
            {(snapshot?.recent || []).map((r, i) => (
              <li key={`${r.checkInAt}-${i}`}>
                {r.name} · {r.billingMode} ·{' '}
                {new Date(r.checkInAt).toLocaleTimeString('zh-TW')}
              </li>
            ))}
            {snapshot && !snapshot.recent?.length && <li>目前無人在場</li>}
          </ul>
        </Card>
      )}
    </LandingLayout>
  );
}
