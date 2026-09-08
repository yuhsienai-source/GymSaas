// routes/board.js — 數位看板 REST（公開唯讀快照）
import express from 'express';
import {
  getOccupancySnapshot,
  getBoardCapacity,
  getOccupancyDisplaySettings,
} from '../lib/occupancy.js';

const router = express.Router();

// GET /api/board/occupancy-settings?branchId=
router.get('/occupancy-settings', async (req, res) => {
  try {
    const branchId = req.query?.branchId;
    const data = await getOccupancyDisplaySettings({
      branchId: branchId != null && branchId !== '' ? branchId : null,
    });
    res.json({ status: 'success', data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取容留顯示設定失敗' });
  }
});

// GET /api/board/occupancy
router.get('/occupancy', async (req, res) => {
  try {
    const settings = await getOccupancyDisplaySettings({
      branchId: req.query?.branchId,
    });
    if (!settings.isDisplay) {
      return res.json({
        status: 'success',
        data: null,
        meta: {
          isDisplay: false,
          wsPath: '/ws/occupancy',
          capacityEnv: getBoardCapacity(),
        },
        message: '容留人數顯示已關閉',
      });
    }
    const data = await getOccupancySnapshot();
    res.json({
      status: 'success',
      data,
      meta: {
        isDisplay: true,
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
