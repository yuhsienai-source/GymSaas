-- 進銷存／電子發票 DB 約束（run after prisma db push）
-- npm run db:constraints

-- 1) 同一單據同一腿最多一張有效發票（作廢／取消者除外）
DROP INDEX IF EXISTS uniq_active_einvoice_leg;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_einvoice_leg
  ON "EInvoice" ("refType", "refId", leg)
  WHERE status NOT IN ('VOIDED', 'CANCELLED');

DO $$
BEGIN
  -- 2) 分店庫存禁止負數
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_stock_onhand_nonneg') THEN
    ALTER TABLE "BranchStock" ADD CONSTRAINT branch_stock_onhand_nonneg CHECK ("onHand" >= 0);
  END IF;

  -- 3) 發票金額勾稽與買受人互斥
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'einvoice_amount_balance') THEN
    ALTER TABLE "EInvoice" ADD CONSTRAINT einvoice_amount_balance CHECK (
      "totalAmount" > 0 AND "salesAmount" >= 0 AND "taxAmount" >= 0
      AND "salesAmount" + "taxAmount" = "totalAmount"
      AND "allowanceTotal" >= 0 AND "allowanceTotal" <= "totalAmount"
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'einvoice_buyer_rules') THEN
    ALTER TABLE "EInvoice" ADD CONSTRAINT einvoice_buyer_rules CHECK (
      category IN ('B2C', 'B2B')
      AND (category <> 'B2B' OR ("buyerUbn" IS NOT NULL AND "carrierNum" IS NULL AND "loveCode" IS NULL))
      AND NOT ("carrierNum" IS NOT NULL AND "loveCode" IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'einvoice_status_enum') THEN
    ALTER TABLE "EInvoice" ADD CONSTRAINT einvoice_status_enum CHECK (
      status IN ('PENDING', 'ISSUING', 'ISSUED', 'FAILED', 'VOIDED', 'CANCELLED')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'einvoice_issued_has_number') THEN
    ALTER TABLE "EInvoice" ADD CONSTRAINT einvoice_issued_has_number CHECK (
      status NOT IN ('ISSUED', 'VOIDED') OR "invoiceNumber" IS NOT NULL
    );
  END IF;

  -- 4) 採購驗收數量
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'po_item_qty_range') THEN
    ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT po_item_qty_range CHECK (
      "qtyOrdered" > 0 AND "qtyReceived" >= 0 AND "qtyReceived" <= "qtyOrdered"
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipt_item_qty_pos') THEN
    ALTER TABLE "PurchaseReceiptItem" ADD CONSTRAINT receipt_item_qty_pos CHECK (qty > 0 AND "unitCost" >= 0);
  END IF;

  -- 5) 應付已付金額不得超過應付（退貨為負向）
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payable_paid_range') THEN
    ALTER TABLE "SupplierPayable" ADD CONSTRAINT payable_paid_range CHECK (
      (amount >= 0 AND "paidAmount" BETWEEN 0 AND amount)
      OR (amount < 0 AND "paidAmount" BETWEEN amount AND 0)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_alloc_nonzero') THEN
    ALTER TABLE "SupplierPaymentAllocation" ADD CONSTRAINT payment_alloc_nonzero CHECK (amount <> 0);
  END IF;

  -- 6) 銷貨明細
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_item_qty_pos') THEN
    ALTER TABLE "SaleItem" ADD CONSTRAINT sale_item_qty_pos CHECK (qty > 0 AND "lineTotal" >= 0);
  END IF;
END $$;
