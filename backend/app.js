//app.js — 純後端 API 伺服器（嚴禁掛載靜態前端）
import express from 'express';
import cors from 'cors';
import http from 'http';

import gateRoutes from './routes/gate.js';
import opsRoutes from './routes/ops.js';
import memberRoutes from './routes/member.js';
import trainerRoutes from './routes/trainer.js';
import hqRoutes from './routes/hq.js';
import ptRoutes from './routes/pt.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import boardRoutes from './routes/board.js';
import posRoutes from './routes/pos.js';
import inventoryOpsRoutes from './routes/inventoryOps.js';
import reportsRoutes from './routes/reports.js';
import contractsRoutes from './routes/contracts.js';
import onboardingRoutes from './routes/onboarding.js';
import { attachOccupancyWebSocket } from './lib/occupancy.js';
import { backfillMissingMemberNos } from './lib/memberNo.js';
import { startCardRecurringScheduler } from './lib/cardSubscription.js';

const app = express();
const PORT = process.env.PORT || 8000;

function parseCorsAllowlist() {
  const raw = String(process.env.CORS_ORIGIN || '').trim();
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean);
  }
  if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    return [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'https://localhost:5173',
      'https://127.0.0.1:5173',
    ];
  }
  throw new Error('CORS_ORIGIN 未設定（正式環境必填，逗號分隔）');
}

/** 開發環境：允許區網 IP 的 Vite 前端 Origin（手機連 https://192.168.x.x:5173） */
function isDevLanFrontendOrigin(origin) {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return false;
  try {
    const u = new URL(origin);
    if (u.port !== '5173' && u.port !== '4173') return false;
    const h = u.hostname;
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(h) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)
    );
  } catch {
    return false;
  }
}

const corsAllowlist = parseCorsAllowlist();
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const normalized = String(origin).replace(/\/$/, '');
      const ok =
        corsAllowlist.includes(normalized) || isDevLanFrontendOrigin(normalized);
      return cb(ok ? null : new Error('CORS origin denied'), ok);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.json({
    status: 'success',
    message: '體育客 GymSaaS Backend API（前後端分離｜本服務不提供 UI）',
    data: {
      health: '/api/health',
      websocket: '/ws/occupancy',
      docsNote: '請由獨立前端網域呼叫本 API；FRONTEND_URL 僅用於 OAuth／金流瀏覽器回流',
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'success',
    message: '體育客 SaaS API 運作中',
    data: {
      port: Number(PORT),
      mode: 'api-only',
      frontendUrl: process.env.FRONTEND_URL || null,
    },
  });
});

app.use('/api/gate', gateRoutes);
// 較長路徑須掛在 /api/ops 之前，否則會被 ops 中介層攔截
app.use('/api/ops/inventory', inventoryOpsRoutes);
app.use('/api/ops', opsRoutes);
app.use('/api/ops', posRoutes);
app.use('/api/member', memberRoutes);
app.use('/api/trainer', trainerRoutes);
// 較長路徑須掛在 /api/hq 之前，否則 hq 的 requireAdmin 會擋住 DUTY 報表
app.use('/api/hq/reports', reportsRoutes);
app.use('/api/hq/contracts', contractsRoutes);
app.use('/api/hq', hqRoutes);
app.use('/api/pt', ptRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/board', boardRoutes);

// 未匹配的非 API 路徑：一律 JSON 404（不回 HTML）
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: `找不到路由：${req.method} ${req.path}`,
  });
});

const server = http.createServer(app);
attachOccupancyWebSocket(server);

server.listen(PORT, () => {
  console.log(`[體育客 API] Port ${PORT}｜純後端｜WS /ws/occupancy`);
  startCardRecurringScheduler();
  backfillMissingMemberNos()
    .then((n) => {
      if (n > 0) console.log(`[體育客] 已補發 ${n} 組會員編號`);
    })
    .catch((err) => {
      console.error('[體育客] 會員編號補發失敗:', err.message);
    });
});
