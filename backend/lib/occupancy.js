// lib/occupancy.js — 場內容留人數：查詢 + WebSocket 推播
import { WebSocketServer } from 'ws';
import prisma from './prisma.js';

const DEFAULT_CAPACITY = parseInt(process.env.BOARD_CAPACITY || '80', 10);
const HEARTBEAT_MS = parseInt(process.env.OCCUPANCY_WS_HEARTBEAT_MS || '30000', 10);

let wss = null;
let heartbeatTimer = null;

export function getBoardCapacity() {
  return DEFAULT_CAPACITY;
}

/**
 * 容留人數顯示開關（Branch.showOccupancy）
 * @param {{ branchId?: number|null }} [opts]
 * @returns {Promise<{ isDisplay: boolean, branchId: number|null, branches?: { id: number, name: string, showOccupancy: boolean }[] }>}
 */
export async function getOccupancyDisplaySettings({ branchId } = {}) {
  const bid = branchId != null ? parseInt(String(branchId), 10) : null;
  if (Number.isInteger(bid) && bid > 0) {
    const branch = await prisma.branch.findFirst({
      where: { id: bid, isActive: true },
      select: { id: true, name: true, showOccupancy: true },
    });
    if (!branch) {
      return { isDisplay: false, branchId: bid, branches: [] };
    }
    return {
      isDisplay: branch.showOccupancy === true,
      branchId: branch.id,
      branches: [branch],
    };
  }

  const branches = await prisma.branch.findMany({
    where: { isActive: true },
    select: { id: true, name: true, showOccupancy: true },
    orderBy: { id: 'asc' },
  });
  const isDisplay = branches.some((b) => b.showOccupancy === true);
  return { isDisplay, branchId: null, branches };
}

/** 統計目前在場人數（未出場且未取消） */
export async function getOccupancySnapshot() {
  const presentCount = await prisma.checkInLog.count({
    where: { checkOutAt: null, status: 'ACTIVE' },
  });

  const recent = await prisma.checkInLog.findMany({
    where: { checkOutAt: null, status: 'ACTIVE' },
    orderBy: { checkInAt: 'desc' },
    take: 8,
    include: {
      member: { select: { id: true, name: true, plan: true } },
    },
  });

  const capacity = getBoardCapacity();
  const available = Math.max(0, capacity - presentCount);

  return {
    presentCount,
    capacity,
    available,
    utilization: capacity > 0 ? Math.min(1, presentCount / capacity) : 0,
    isFull: presentCount >= capacity,
    updatedAt: new Date().toISOString(),
    recent: recent.map((log) => ({
      memberId: log.member.id,
      name: maskName(log.member.name),
      plan: log.member.plan,
      billingMode: log.billingMode,
      checkInAt: log.checkInAt,
    })),
  };
}

function maskName(name) {
  if (!name) return '***';
  if (name.length <= 1) return '*';
  return name[0] + '*'.repeat(Math.min(name.length - 1, 2));
}

/** 掛載 WebSocket 於既有 HTTP server */
export function attachOccupancyWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws/occupancy' });

  wss.on('connection', async (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    try {
      const snapshot = await getOccupancySnapshot();
      socket.send(JSON.stringify({ type: 'occupancy', data: snapshot }));
    } catch (error) {
      console.error('看板初始推播失敗:', error);
    }

    socket.on('error', (err) => console.error('WS client error:', err.message));
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

  console.log('[體育客] WebSocket 容留看板已掛載：/ws/occupancy（heartbeat）');
  return wss;
}

/** 進出場後廣播最新容留 */
export async function broadcastOccupancy(event = {}) {
  if (!wss) return;

  try {
    const snapshot = await getOccupancySnapshot();
    const payload = JSON.stringify({
      type: 'occupancy',
      event: event.type || 'update',
      data: snapshot,
    });

    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  } catch (error) {
    console.error('容留廣播失敗:', error);
  }
}
