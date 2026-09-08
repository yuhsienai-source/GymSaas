// routes/memberMarketing.js — 會員行銷自助（掛於 /api/member/marketing）
import express from 'express';
import prisma from '../lib/prisma.js';

const router = express.Router();

// GET /api/member/marketing/gift-cards/mine
router.get('/gift-cards/mine', async (req, res) => {
  const memberId = req.user.memberId;

  try {
    const [purchased, redeemed] = await Promise.all([
      prisma.giftCard.findMany({
        where: { purchaserId: memberId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.giftCard.findMany({
        where: { redeemerId: memberId },
        orderBy: { redeemedAt: 'desc' },
      }),
    ]);
    res.json({
      status: 'success',
      data: { purchased, redeemed },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取禮物卡失敗' });
  }
});

// POST /api/member/marketing/gift-cards/redeem — { code }
router.post('/gift-cards/redeem', async (req, res) => {
  const memberId = req.user.memberId;
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ status: 'error', message: '請提供兌換碼' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const card = await tx.giftCard.findUnique({ where: { code } });
      if (!card || card.status !== 'ACTIVE') {
        const err = new Error('兌換碼無效或已使用');
        err.statusCode = 404;
        throw err;
      }
      if (card.expiresAt && card.expiresAt < new Date()) {
        const err = new Error('禮物卡已過期');
        err.statusCode = 400;
        throw err;
      }

      const updated = await tx.giftCard.update({
        where: { id: card.id },
        data: {
          status: 'REDEEMED',
          redeemerId: memberId,
          redeemedAt: new Date(),
        },
      });

      const member = await tx.member.update({
        where: { id: memberId },
        data: { cashWallet: { increment: card.amount } },
        select: { id: true, cashWallet: true, bonusWallet: true },
      });

      return { card: updated, member };
    });

    res.json({
      status: 'success',
      message: `已兌換 $${result.card.amount} 至現金錢包`,
      data: result,
    });
  } catch (error) {
    const code = error.statusCode || 500;
    console.error(error);
    res.status(code).json({ status: 'error', message: error.message || '兌換失敗' });
  }
});

// GET /api/member/marketing/points/ledger
router.get('/points/ledger', async (req, res) => {
  const memberId = req.user.memberId;

  try {
    const items = await prisma.memberPointsLedger.findMany({
      where: { memberId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取點數紀錄失敗' });
  }
});

// GET /api/member/marketing/lottery/entries
router.get('/lottery/entries', async (req, res) => {
  const memberId = req.user.memberId;

  try {
    const items = await prisma.lotteryEntry.findMany({
      where: { memberId },
      include: {
        pool: { select: { id: true, name: true, status: true, drawAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取抽獎資格失敗' });
  }
});

// GET /api/member/marketing/inbody-vouchers
router.get('/inbody-vouchers', async (req, res) => {
  const memberId = req.user.memberId;

  try {
    const items = await prisma.inBodyVoucher.findMany({
      where: { memberId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ status: 'success', data: items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'error', message: '讀取 InBody 兌換券失敗' });
  }
});

export default router;
