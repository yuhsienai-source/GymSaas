-- Gate concurrency constraints (run after prisma db push)
-- npm run db:constraints

-- 1) 清理同會員多筆 ACTIVE 在場（保留最新一筆，其餘標取消）
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "memberId"
      ORDER BY "checkInAt" DESC, id DESC
    ) AS rn
  FROM "CheckInLog"
  WHERE status = 'ACTIVE'
    AND "checkOutAt" IS NULL
)
UPDATE "CheckInLog" AS c
SET
  status = 'CANCELLED',
  "cancelledAt" = NOW(),
  "cancelReason" = COALESCE(c."cancelReason", 'DEDUP_ACTIVE_CHECKIN')
FROM ranked r
WHERE c.id = r.id
  AND r.rn > 1;

-- 2) Partial unique：同一會員最多一筆 ACTIVE 在場
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_member_checkin
  ON "CheckInLog" ("memberId")
  WHERE status = 'ACTIVE' AND "checkOutAt" IS NULL;

-- 3) 雙錢包禁止負餘額（先抬升既有負數，再加約束）
UPDATE "Member" SET "cashWallet" = 0 WHERE "cashWallet" < 0;
UPDATE "Member" SET "bonusWallet" = 0 WHERE "bonusWallet" < 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'member_cash_wallet_nonneg'
  ) THEN
    ALTER TABLE "Member"
      ADD CONSTRAINT member_cash_wallet_nonneg CHECK ("cashWallet" >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'member_bonus_wallet_nonneg'
  ) THEN
    ALTER TABLE "Member"
      ADD CONSTRAINT member_bonus_wallet_nonneg CHECK ("bonusWallet" >= 0);
  END IF;
END $$;
