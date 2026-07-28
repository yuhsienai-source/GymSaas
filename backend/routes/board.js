// routes/board.js — 數位看板 REST（公開唯讀快照）
import express from 'express';
import { getOccupancySnapshot, getBoardCapacity } from '../lib/occupancy.js';

const router = express.Router();

// GET /api/board/occupancy
router.get('/occupancy', async (req, res) => {
  try {
    const data = await getOccupancySnapshot();
    res.json({
      status: 'success',
      data,
      meta: {
        wsPath: '/ws/occupancy',
        capacityEnv: getBoardCapacity(),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取容留人數失敗' });
  }
});

export default router;
