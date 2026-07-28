import { Link } from 'react-router-dom';
import LandingLayout from '../components/layout/LandingLayout';
import { Card } from '../components/ui';

const portals = [
  {
    to: '/',
    icon: '📱',
    title: '會員端',
    desc: 'LINE 一鍵登入、雙錢包餘額、進出場動態門禁碼',
    variant: 'member',
  },
  {
    to: '/gate',
    icon: '📠',
    title: '門禁閘機',
    desc: '掃碼進場 / 出場結算，HMAC 驗簽防截圖',
    variant: 'gate',
  },
  {
    to: '/staff/login',
    icon: '🏋️',
    title: '員工後台',
    desc: '櫃檯維運、總部 HQ、團課排課、教練工作區',
    variant: 'staff',
  },
  {
    to: '/board',
    icon: '📟',
    title: '容留看板',
    desc: 'WebSocket 即時場內人數（不託管在 API 靜態目錄）',
    variant: 'member',
  },
];

const features = [
  { title: '雙錢包', desc: '運動金優先扣，現金補足' },
  { title: '進場快照', desc: '跨夜依 CheckInLog 結算' },
  { title: '商品化儲值', desc: '僅 promotionId，防改包' },
  { title: 'RBAC 隔離', desc: '會員 / 員工 JWT 分流' },
];

/** 原首頁：各端入口總覽（會員登入已改為 `/`） */
export default function PortalPage() {
  return (
    <LandingLayout>
      <section className="hero">
        <span className="hero__badge">體育客 · 系統入口</span>
        <h1>連鎖健身場館數位營運平台</h1>
        <p>UI 只呼叫後端 API／WebSocket；商業邏輯與入帳一律在 backend</p>
      </section>

      <div className="portal-grid">
        {portals.map((p) => (
          <Link key={p.to} to={p.to} className={`portal-card portal-card--${p.variant}`}>
            <span className="portal-card__icon">{p.icon}</span>
            <h2>{p.title}</h2>
            <p>{p.desc}</p>
            <span className="portal-card__arrow">進入 →</span>
          </Link>
        ))}
      </div>

      <div className="feature-strip">
        {features.map((f) => (
          <div key={f.title} className="feature-chip">
            <strong>{f.title}</strong>
            {f.desc}
          </div>
        ))}
      </div>

      <Card title="API 架構速查" className="mt-lg" padding="lg">
        <ul className="info-list" style={{ textAlign: 'left', paddingLeft: '1.2rem', margin: 0 }}>
          <li>
            會員 <code>/api/member/*</code> — memberId 只從 JWT 取
          </li>
          <li>
            門禁 <code>/api/gate/*</code> — 掃 QR / 刷臉，禁傳 memberId
          </li>
          <li>
            員工 <code>/api/ops</code> · <code>/api/hq</code> · <code>/api/pt</code> ·{' '}
            <code>/api/trainer</code>
          </li>
        </ul>
      </Card>
    </LandingLayout>
  );
}
