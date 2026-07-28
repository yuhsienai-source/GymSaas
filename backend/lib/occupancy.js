// lib/occupancy.js — 場內容留人數：查詢 + WebSocket 推播
import { WebSocketServer } from 'ws';
import prisma from './prisma.js';

const DEFAULT_CAPACITY = parseInt(process.env.BOARD_CAPACITY || '80', 10);

let wss = null;

export function getBoardCapacity() {
  return DEFAULT_CAPACITY;
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
    try {
      const snapshot = await getOccupancySnapshot();
      socket.send(JSON.stringify({ type: 'occupancy', data: snapshot }));
    } catch (error) {
      console.error('看板初始推播失敗:', error);
    }

    socket.on('error', (err) => console.error('WS client error:', err.message));
  });

  console.log('[體育客] WebSocket 容留看板已掛載：/ws/occupancy');
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
