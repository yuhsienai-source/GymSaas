// lib/gateAlert.js — 閘機異常推播（尾隨／無進場紀錄出場等）
import { WebSocketServer } from 'ws';

const HEARTBEAT_MS = parseInt(process.env.GATE_ALERT_WS_HEARTBEAT_MS || '30000', 10);
const MAX_RECENT = 40;

let wss = null;
let heartbeatTimer = null;
/** @type {object[]} */
const recentAlerts = [];

function maskName(name) {
  if (!name) return '***';
  if (name.length <= 1) return '*';
  return name[0] + '*'.repeat(Math.min(name.length - 1, 2));
}

/**
 * @param {{
 *   code: string,
 *   title?: string,
 *   message: string,
 *   memberId?: number|null,
 *   memberName?: string|null,
 *   branchId?: number|null,
 *   severity?: 'high'|'medium'|'info',
 * }} payload
 */
export function broadcastGateAlert(payload) {
  const event = {
    type: 'gate-alert',
    code: String(payload.code || 'GATE_ALERT'),
    title: payload.title || '閘機異常',
    message: String(payload.message || ''),
    memberId: payload.memberId ?? null,
    memberName: payload.memberName ? maskName(payload.memberName) : null,
    branchId: payload.branchId ?? null,
    severity: payload.severity || 'high',
    at: new Date().toISOString(),
  };

  recentAlerts.unshift(event);
  if (recentAlerts.length > MAX_RECENT) recentAlerts.length = MAX_RECENT;

  if (!wss) return event;
  const raw = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try {
        client.send(raw);
      } catch {
        /* ignore */
      }
    }
  }
  return event;
}

export function getRecentGateAlerts(limit = 20) {
  return recentAlerts.slice(0, Math.min(MAX_RECENT, Math.max(1, limit)));
}

/** 掛載於既有 HTTP server：/ws/gate-alert */
export function attachGateAlertWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws/gate-alert' });

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    try {
      socket.send(
        JSON.stringify({
          type: 'gate-alert-hello',
          message: '已訂閱閘機異常推播',
          recent: getRecentGateAlerts(10),
        }),
      );
    } catch {
      /* ignore */
    }

    socket.on('error', (err) => console.error('gate-alert WS error:', err.message));
  });

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  console.log('[體育客] WebSocket 閘機異常已掛載：/ws/gate-alert');
  return wss;
}
