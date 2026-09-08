import { useEffect, useMemo, useRef, useState } from 'react';
import BrandMark from '../../components/BrandMark';
import SignaturePad from '../../components/staff/SignaturePad';
import { Button } from '../../components/ui';
import {
  createPosDisplayBus,
  POS_DISPLAY_TYPES,
  summarizePosDisplayCart,
  type PosDisplayCartPayload,
  type PosDisplayConsentPayload,
  type PosDisplayMessage,
} from '../../lib/posDisplayBus';

type ViewMode = 'IDLE' | 'CART' | 'CONSENT';
type PosBus = ReturnType<typeof createPosDisplayBus>;

interface OccupancySnapshot {
  presentCount: number;
  capacity?: number;
  updatedAt?: string;
}

function occupancyWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws/occupancy`;
}

function money(n: number) {
  return `$${Math.round(Number(n) || 0).toLocaleString('zh-TW')}`;
}

function kindLabel(kind?: string) {
  const k = String(kind || '').toUpperCase();
  if (k === 'PRODUCT' || k === 'SALE') return '商品';
  if (k === 'PROMO' || k === 'PROMOTION') return '購案';
  if (k === 'COURSE' || k === 'PT') return '私教／課程';
  return kind || '項目';
}

export default function CustomerDisplayPage() {
  const [mode, setMode] = useState<ViewMode>('IDLE');
  const [cart, setCart] = useState<PosDisplayCartPayload | null>(null);
  const [consent, setConsent] = useState<PosDisplayConsentPayload | null>(null);
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const [linkOk, setLinkOk] = useState(false);
  const [occupancy, setOccupancy] = useState<OccupancySnapshot | null>(null);
  const [occupancyVisible, setOccupancyVisible] = useState(true);
  const [occupancyStatus, setOccupancyStatus] = useState('連線中…');
  const [clock, setClock] = useState(() => new Date());
  const busRef = useRef<PosBus | null>(null);

  const cartSummary = useMemo(() => summarizePosDisplayCart(cart), [cart]);

  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // 客顯 bus：BC + storage 備援
  useEffect(() => {
    const bus = createPosDisplayBus('display');
    busRef.current = bus;
    bus.startHeartbeat(5000);

    const unsub = bus.subscribe((msg: PosDisplayMessage) => {
      if (msg.from === 'display') return;
      const type = String(msg.type || '').toUpperCase();

      if (type === POS_DISPLAY_TYPES.PING) {
        bus.post(POS_DISPLAY_TYPES.PONG, { role: 'display' });
        setLinkOk(true);
        return;
      }
      if (type === POS_DISPLAY_TYPES.PONG) {
        setLinkOk(true);
        return;
      }
      if (type === POS_DISPLAY_TYPES.IDLE || type === POS_DISPLAY_TYPES.RESET) {
        setMode('IDLE');
        setCart(null);
        setConsent(null);
        setSignatureData(null);
        setLinkOk(true);
        return;
      }
      if (type === POS_DISPLAY_TYPES.CART || type === POS_DISPLAY_TYPES.CART_UPDATE) {
        const payload = (msg.payload || {}) as PosDisplayCartPayload;
        setCart(payload);
        setConsent(null);
        setSignatureData(null);
        setMode('CART');
        setLinkOk(true);
        return;
      }
      if (type === POS_DISPLAY_TYPES.CONSENT) {
        const payload = (msg.payload || {}) as PosDisplayConsentPayload;
        if (!payload?.consentSignatureId || !payload?.body) return;
        setConsent(payload);
        setSignatureData(null);
        setMode('CONSENT');
        setLinkOk(true);
      }
    });

    bus.post(POS_DISPLAY_TYPES.PONG, { role: 'display', ready: true });

    return () => {
      unsub();
      bus.close();
      busRef.current = null;
    };
  }, []);

  // /ws/occupancy（尊重 occupancy-settings）
  useEffect(() => {
    let closed = false;
    let timer: number | undefined;
    let socket: WebSocket | null = null;
    let shouldReconnect = true;

    async function bootstrap() {
      try {
        const settingsRes = await fetch('/api/board/occupancy-settings');
        const settingsJson = await settingsRes.json();
        const show =
          settingsJson.status === 'success' && settingsJson.data?.isDisplay === true;
        if (closed) return false;
        if (!show) {
          setOccupancyVisible(false);
          setOccupancy(null);
          setOccupancyStatus('容留顯示已關閉');
          shouldReconnect = false;
          return false;
        }
        setOccupancyVisible(true);
        const res = await fetch('/api/board/occupancy');
        const json = await res.json();
        if (closed) return false;
        if (json.meta?.isDisplay === false || json.data == null) {
          setOccupancyVisible(false);
          setOccupancy(null);
          setOccupancyStatus('容留顯示已關閉');
          shouldReconnect = false;
          return false;
        }
        if (json.status === 'success') setOccupancy(json.data);
        return true;
      } catch {
        if (!closed) setOccupancyStatus('改等 WebSocket…');
        return true;
      }
    }

    function connect() {
      socket = new WebSocket(occupancyWsUrl());
      socket.onopen = () => {
        if (!closed) setOccupancyStatus('即時連線');
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'occupancy' && msg.data) {
            setOccupancy(msg.data);
            setOccupancyStatus(`更新 ${new Date().toLocaleTimeString('zh-TW')}`);
          }
        } catch {
          /* ignore */
        }
      };
      socket.onclose = () => {
        if (closed || !shouldReconnect) return;
        setOccupancyStatus('重連中…');
        timer = window.setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    }

    void (async () => {
      const ok = await bootstrap();
      if (!closed && ok) connect();
    })();

    return () => {
      closed = true;
      shouldReconnect = false;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  function submitSignature() {
    if (!consent || !signatureData) return;
    busRef.current?.post(POS_DISPLAY_TYPES.SIGNATURE_COMPLETED, {
      purpose: consent.purpose,
      consentSignatureId: consent.consentSignatureId,
      signatureDataUrl: signatureData,
      signedAt: new Date().toISOString(),
    });
    setMode('IDLE');
    setConsent(null);
    setSignatureData(null);
  }

  const timeLabel = clock.toLocaleTimeString('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className={`cd-app cd-app--${mode.toLowerCase()}`}>
      <header className="cd-header">
        <div className="cd-brand">
          <BrandMark />
          <div className="cd-brand__text">
            <strong>1st FITNESS</strong>
            <small>客顯 · Customer Display</small>
          </div>
        </div>
        <div className="cd-header__meta">
          <span className={`cd-link ${linkOk ? 'is-ok' : ''}`}>
            {linkOk ? '主螢幕已連線' : '等待主螢幕…'}
          </span>
          <time dateTime={clock.toISOString()}>{timeLabel}</time>
        </div>
      </header>

      {mode === 'IDLE' && (
        <section className="cd-idle" aria-live="polite">
          <div className="cd-idle__hero">
            <p className="cd-idle__eyebrow">Welcome</p>
            <h1 className="cd-idle__title">歡迎光臨</h1>
            <p className="cd-marquee" aria-hidden="true">
              <span>
                歡迎光臨 1st FITNESS　請至櫃檯辦理入會／結帳　Welcome　請出示會員動態 QR　
              </span>
              <span>
                歡迎光臨 1st FITNESS　請至櫃檯辦理入會／結帳　Welcome　請出示會員動態 QR　
              </span>
            </p>
          </div>
          {occupancyVisible && occupancy ? (
            <div className="cd-occupancy">
              <div className="cd-occupancy__count">{occupancy.presentCount}</div>
              <div className="cd-occupancy__label">人在館</div>
              <div className="cd-occupancy__status">{occupancyStatus}</div>
            </div>
          ) : (
            <div className="cd-occupancy cd-occupancy--muted">
              <div className="cd-occupancy__label">{occupancyStatus || '—'}</div>
            </div>
          )}
        </section>
      )}

      {mode === 'CART' && (
        <section className="cd-cart" aria-live="polite">
          <div className="cd-cart__head">
            <h2>購物明細</h2>
            {cartSummary.memberName ? (
              <p className="cd-cart__member">{cartSummary.memberName}</p>
            ) : (
              <p className="cd-cart__member text-muted">臨櫃結帳</p>
            )}
          </div>
          <div className="cd-cart__table-wrap">
            <table className="cd-cart__table">
              <thead>
                <tr>
                  <th>項目</th>
                  <th>數量</th>
                  <th>小計</th>
                  <th>贈 SC</th>
                </tr>
              </thead>
              <tbody>
                {cartSummary.lines.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="cd-cart__empty">
                      等待主螢幕傳送購物車…
                    </td>
                  </tr>
                ) : (
                  cartSummary.lines.map((line, idx) => (
                    <tr key={`${line.name}-${idx}`}>
                      <td>
                        <span className="cd-cart__kind">{kindLabel(line.kind)}</span>
                        <strong>{line.name}</strong>
                      </td>
                      <td>×{line.qty}</td>
                      <td>{money(line.lineTotal)}</td>
                      <td>{line.bonusSc ? `+${Math.round(line.bonusSc)}` : '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <footer className="cd-cart__totals">
            <div>
              <span>商品合計</span>
              <strong>{money(cartSummary.subtotal)}</strong>
            </div>
            <div>
              <span>加贈運動金（SC）</span>
              <strong className="cd-cart__sc">+{Math.round(cartSummary.bonusTotal)}</strong>
            </div>
            <div className="cd-cart__payable">
              <span>應付總額</span>
              <strong>{money(cartSummary.payableTotal)}</strong>
            </div>
          </footer>
        </section>
      )}

      {mode === 'CONSENT' && consent && (
        <section className="cd-consent">
          <div className="cd-consent__doc">
            <h2>{consent.title}</h2>
            {consent.memberName ? (
              <p className="cd-consent__meta">簽署人：{consent.memberName}</p>
            ) : null}
            {consent.branchLabel ? (
              <p className="cd-consent__meta">分店：{consent.branchLabel}</p>
            ) : null}
            <div className="cd-consent__body">{consent.body}</div>
          </div>
          <div className="cd-consent__sign">
            <h3>請於下方親簽</h3>
            <SignaturePad
              key={consent.consentSignatureId}
              height={220}
              onChange={setSignatureData}
            />
            <div className="cd-consent__actions">
              <Button
                disabled={!signatureData}
                onClick={submitSignature}
                style={{ minHeight: 48, fontSize: '1.05rem' }}
              >
                確認簽署並送回櫃檯
              </Button>
              <p className="cd-consent__hint">
                簽署完成後將自動回傳主螢幕（consentSignatureId）
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
