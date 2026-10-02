-- 交易取消／退費／折讓 DB 約束（run after prisma db push）
-- npm run db:constraints

-- 1) 同一子單同時只允許一張未結案退費單（防並發雙退）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_refund_per_ref
  ON "RefundRequest" ("refType", "refId")
  WHERE status NOT IN ('COMPLETED', 'ABORTED');

-- 1b) 乙禾 RRN 一筆端末交易只能認列一次（收款暫存／退刷各自唯一，防並發雙認列）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_yipay_refund_rrn
  ON "RefundPayment" (rrn)
  WHERE method = 'YIPAY' AND status = 'REFUNDED';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_yipay_capture_rrn
  ON "YipayTerminalCapture" (rrn)
  WHERE rrn IS NOT NULL AND status IN ('PENDING_CONFIRM', 'CONFIRMED');

DO $$
BEGIN
  -- 2) 退貨數量上限
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_item_refunded_qty_range') THEN
    ALTER TABLE "SaleItem" ADD CONSTRAINT sale_item_refunded_qty_range CHECK ("refundedQty" BETWEEN 0 AND qty);
  END IF;

  -- 3) 已退金額不得超過單據金額
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_order_refunded_range') THEN
    ALTER TABLE "SaleOrder" ADD CONSTRAINT sale_order_refunded_range CHECK ("refundedAmount" BETWEEN 0 AND amount);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_refunded_range') THEN
    ALTER TABLE "Order" ADD CONSTRAINT order_refunded_range CHECK ("refundedAmount" >= 0 AND "refundedAmount" <= CEIL(amount));
  END IF;

  -- 4) 退費單／退款管道狀態與金額（每次重建狀態清單，以納入 GATEWAY_RETRYING）
  ALTER TABLE "RefundRequest" DROP CONSTRAINT IF EXISTS refund_request_status_enum;
  ALTER TABLE "RefundRequest" ADD CONSTRAINT refund_request_status_enum CHECK (
    status IN ('PAYMENT_PENDING', 'AWAITING_TERMINAL', 'PAYMENT_FAILED', 'INVOICE_PENDING',
               'INVOICE_FAILED', 'SIGNATURE_PENDING', 'GATEWAY_RETRYING', 'COMPLETED', 'ABORTED')
    AND "grossAmount" >= 0 AND "payoutAmount" >= 0 AND "payoutAmount" <= "grossAmount"
    AND length(btrim(reason)) > 0
  );
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refund_payment_rules') THEN
    ALTER TABLE "RefundPayment" ADD CONSTRAINT refund_payment_rules CHECK (
      amount > 0
      AND method IN ('CASH', 'WALLET_CASH', 'LINEPAY', 'PAYUNI', 'YIPAY', 'VOUCHER')
      AND status IN ('PENDING', 'PROCESSING', 'AWAITING_TERMINAL', 'REFUNDED', 'FAILED', 'FORFEITED', 'REVERSED', 'CANCELLED')
      AND (method <> 'YIPAY' OR status <> 'REFUNDED' OR (rrn IS NOT NULL AND "authCode" IS NOT NULL AND "cardLast4" IS NOT NULL))
    );
  END IF;

  -- 5) 折讓明細金額
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allowance_item_amount_rules') THEN
    ALTER TABLE "InvoiceAllowanceItem" ADD CONSTRAINT allowance_item_amount_rules CHECK (
      qty > 0 AND amount >= 0 AND "taxAmt" >= 0 AND "grossAmount" = amount + "taxAmt"
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'einvoice_item_allowed_range') THEN
    ALTER TABLE "EInvoiceItem" ADD CONSTRAINT einvoice_item_allowed_range CHECK ("allowedQty" >= 0 AND "allowedAmount" >= 0);
  END IF;

  -- 7) 錢包流水：新制列（lib/walletMutation.js）雙錢包 before＋delta＝after（Float 容差 0.005）、after ≥ 0、不得空異動；舊制單錢包列保留
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_ledger_balance_math') THEN
    ALTER TABLE "WalletLedger" ADD CONSTRAINT wallet_ledger_balance_math CHECK (
      ("cashBefore" IS NULL AND "cashDelta" IS NULL AND "cashAfter" IS NULL
        AND "bonusBefore" IS NULL AND "bonusDelta" IS NULL AND "bonusAfter" IS NULL
        AND wallet IS NOT NULL AND delta IS NOT NULL AND "balanceAfter" IS NOT NULL)
      OR (
        "cashBefore" IS NOT NULL AND "cashDelta" IS NOT NULL AND "cashAfter" IS NOT NULL
        AND "bonusBefore" IS NOT NULL AND "bonusDelta" IS NOT NULL AND "bonusAfter" IS NOT NULL
        AND abs("cashBefore" + "cashDelta" - "cashAfter") < 0.005
        AND abs("bonusBefore" + "bonusDelta" - "bonusAfter") < 0.005
        AND "cashAfter" >= 0 AND "bonusAfter" >= 0
        AND ("cashDelta" <> 0 OR "bonusDelta" <> 0)
        AND length(btrim(coalesce(reason, ''))) > 0
      )
    );
  END IF;

  -- 8) 門禁差額／實扣拆分不得為負；實扣拆分合計＝出場費（未扣款之舊紀錄兩欄皆 0）
  ALTER TABLE "CheckInLog" DROP CONSTRAINT IF EXISTS checkin_arrears_nonneg;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkin_wallet_amounts') THEN
    ALTER TABLE "CheckInLog" ADD CONSTRAINT checkin_wallet_amounts CHECK (
      "shortfallAmt" >= 0 AND "deductedCash" >= 0 AND "deductedBonus" >= 0
      AND (("deductedCash" = 0 AND "deductedBonus" = 0) OR abs("deductedCash" + "deductedBonus" - fee) < 0.005)
    );
  END IF;
END $$;

-- 6) 稽核／流水 append-only
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_ledger_append_only ON "WalletLedger";
CREATE TRIGGER wallet_ledger_append_only BEFORE UPDATE OR DELETE ON "WalletLedger"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

DROP TRIGGER IF EXISTS tx_audit_append_only ON "TransactionAuditLog";
CREATE TRIGGER tx_audit_append_only BEFORE UPDATE OR DELETE ON "TransactionAuditLog"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
