import express from 'express';
import prisma from '../lib/prisma.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { verifyStaff, requireAdmin } from '../middleware/jwtAuth.js';
import { staffAuthInclude, toJwtPayload, toStaffAuthPayload } from '../lib/staffAccess.js';
import { readStaffAvatar } from '../lib/staffPhoto.js';
import { resolveDutyStatus } from '../lib/attendanceService.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { opsResetMemberDevice } from '../lib/deviceReset.js';
import { clientIp, clientUserAgent } from '../lib/memberDeviceAudit.js';

const router = express.Router();
const loginLimiter = createRateLimiter({
  keyPrefix: 'admin-login',
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: (req) => req.ip || 'unknown',
  message: '登入嘗試過於頻繁，請稍後再試',
});

// ==========================================
// 【系統冷啟動】無任何員工時可建立第一位 ADMIN
// POST /api/admin/bootstrap
// ==========================================
router.post('/bootstrap', async (req, res) => {
  const { account, password, name } = req.body;
  if (!account || !password || !name) {
    return res.status(400).json({ status: 'error', message: '帳號、密碼與姓名皆為必填' });
  }

  try {
    const count = await prisma.staff.count();
    if (count > 0) {
      return res.status(403).json({
        status: 'error',
        message: '系統已有員工帳號，請改用 /api/admin/login 或由 ADMIN 建立新帳號',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newStaff = await prisma.staff.create({
      data: {
        account,
        password: hashedPassword,
        name,
        role: 'ADMIN',
        isActive: true,
      },
    });

    res.status(201).json({
      status: 'success',
      message: '系統管理員已建立，請立即登入',
      data: { id: newStaff.id, account: newStaff.account, name: newStaff.name, role: newStaff.role },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '初始化失敗' });
  }
});

// ==========================================
// 【廠館維運端】建立員工（需 ADMIN）
// POST /api/admin/staff/init
// ==========================================
router.post('/staff/init', verifyStaff, requireAdmin, async (req, res) => {
  const { account, password, name } = req.body;

  // 1. 基本防呆：確保必填欄位都有值
  if (!account || !password || !name) {
    return res.status(400).json({ status: 'error', message: '帳號、密碼與姓名皆為必填' });
  }

  try {
    // 2. 檢查帳號是否已經存在
    const existingStaff = await prisma.staff.findUnique({ where: { account } });
    if (existingStaff) {
      return res.status(400).json({ status: 'error', message: '此帳號已被使用' });
    }

    // 3. 密碼加密 (加鹽次數設為 10，兼顧安全性與效能)
    const hashedPassword = await bcrypt.hash(password, 10);

    // 4. 寫入資料庫，並強制賦予 ADMIN 權限
    const newStaff = await prisma.staff.create({
      data: {
        account,
        password: hashedPassword,
        name,
        role: 'ADMIN' // 預設給予最高權限
      }
    });

    // 5. 回傳成功訊息 (🚨 極度關鍵：絕對不可將 password 回傳給前端)
    res.status(201).json({
      status: 'success',
      message: '管理員帳號建立成功',
      data: {
        id: newStaff.id,
        account: newStaff.account,
        name: newStaff.name,
        role: newStaff.role
      }
    });

  } catch (error) {
    console.error("建立員工帳號失敗:", error);
    res.status(500).json({ status: 'error', message: '系統錯誤，無法建立帳號' });
  }
});

// ==========================================
// 【廠館維運端】員工登入
// ==========================================
router.post('/login', loginLimiter, async (req, res) => {
  const { account, password } = req.body;

  // 1. 基本防呆
  if (!account || !password) {
    return res.status(400).json({ status: 'error', message: '請輸入帳號與密碼' });
  }

  try {
    // 2. 尋找帳號
    const staff = await prisma.staff.findUnique({
      where: { account },
      include: staffAuthInclude,
    });
    
    // 資安觀念：帳號不存在或密碼錯誤，一律回傳相同的模糊錯誤，防止駭客猜測帳號是否存在
    if (!staff) {
      return res.status(401).json({ status: 'error', message: '帳號或密碼錯誤' });
    }

    // 3. 檢查帳號是否被停權 (離職)
    if (!staff.isActive) {
      return res.status(403).json({ status: 'error', message: '此帳號已被停權，請洽管理員' });
    }

    // 4. 驗證密碼 (使用 bcrypt 的比對功能)
    const isPasswordValid = await bcrypt.compare(password, staff.password);
    if (!isPasswordValid) {
      return res.status(401).json({ status: 'error', message: '帳號或密碼錯誤' });
    }

    const trainerId =
      staff.trainerProfile?.isActive === false ? null : staff.trainerProfile?.id ?? null;

    // 5. 發行 JWT
    const payload = toJwtPayload(staff, { trainerId });
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

    // 6. 班表值勤判定（非值勤仍可登入，業務模組由 staffDutyGate 鎖定）
    let duty = null;
    try {
      duty = await resolveDutyStatus(payload);
    } catch (err) {
      console.error('員工登入值勤判定失敗:', err.message);
    }

    res.json({
      status: 'success',
      message: duty && !duty.onDuty ? `登入成功（非值勤：${duty.message}）` : '登入成功',
      data: {
        token,
        staff: toStaffAuthPayload(staff, { trainerId }),
        duty,
      },
    });

  } catch (error) {
    console.error("員工登入失敗:", error);
    res.status(500).json({ status: 'error', message: '系統錯誤，無法登入' });
  }
});

// ==========================================
// 【員工端】取得目前登入者資訊（含分店與權限）
// GET /api/admin/me
// ==========================================
router.get('/me', verifyStaff, async (req, res) => {
  try {
    const staff = await prisma.staff.findUnique({
      where: { id: req.user.id },
      include: staffAuthInclude,
    });
    if (!staff || !staff.isActive) {
      return res.status(403).json({ status: 'error', message: '帳號不存在或已停權' });
    }
    const trainerId =
      staff.trainerProfile?.isActive === false ? null : staff.trainerProfile?.id ?? null;
    res.json({ status: 'success', data: toStaffAuthPayload(staff, { trainerId }) });
  } catch (error) {
    console.error('讀取員工資訊失敗:', error);
    res.status(500).json({ status: 'error', message: '系統錯誤' });
  }
});

// 本人頭像縮圖（JSON data URL；無照片回 null）
router.get('/me/photo', verifyStaff, async (req, res) => {
  try {
    const avatar = await readStaffAvatar(req.user.id);
    res.json({ status: 'success', data: avatar });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取頭像失敗' });
  }
});

// ==========================================
// 【廠館維運端】重置會員綁定裝置
// ==========================================
router.post('/members/:memberId/reset-device', verifyStaff, requireAdmin, async (req, res) => {
  const { memberId } = req.params;

  // 🚨 修正關鍵：將路由參數(字串)轉換為整數
  const numericId = parseInt(memberId, 10);

  // 防呆：如果網址亂打(例如 /members/abc/reset-device)，就提早擋下
  if (isNaN(numericId)) {
    return res.status(400).json({ status: 'error', message: '無效的會員 ID 格式' });
  }

  try {
    const result = await opsResetMemberDevice({
      memberId: numericId,
      operatorId: req.user?.id ?? null,
      reason: 'ADMIN 重置裝置綁定',
      ip: clientIp(req),
      userAgent: clientUserAgent(req),
      action: 'ADMIN_RESET',
    });

    res.json({
      status: 'success',
      message: result.message,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ status: 'error', message: error.message });
    }
    console.error('重置裝置綁定失敗:', error);
    res.status(500).json({ status: 'error', message: '系統錯誤，無法重置裝置' });
  }
});

export default router;