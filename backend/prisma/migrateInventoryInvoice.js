#!/usr/bin/env node
/**
 * 進銷存／多營業人電子發票 資料遷移（phase 1 schema 之後、phase 2 schema 之前執行；可重跑）
 *  1. 依分店發票統編建立 LegalEntity，回填 Branch.legalEntityId
 *  2. 分店商品 → 商品主檔（同 SKU 合併）＋ BranchStock
 *  3. StockMovement 補 branchId／qtyDelta／balanceAfter／reason
 *  4. SaleOrder 補 legalEntityId；SaleItem 補 unitCost
 *  5. 舊發票欄位 → InvoiceRequest／EInvoice
 * 用法：node --env-file=.env prisma/migrateInventoryInvoice.js
 */
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
const client = await pool.connect();

const hasColumn = async (table, column) => {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column],
  );
  return rows.length > 0;
};

const sanitizeOrderNo = (raw) => String(raw || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 20);
const periodKeyOf = (d) => {
  const dt = new Date(d);
  const tw = new Date(dt.getTime() + 8 * 3600 * 1000);
  const m = tw.getUTCMonth() + 1;
  const start = m % 2 === 0 ? m - 1 : m;
  return `${tw.getUTCFullYear()}${String(start).padStart(2, '0')}`;
};
const genId = (prefix) =>
  `${prefix}${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8)}${Math.floor(100000 + Math.random() * 900000)}`;

try {
  await client.query('BEGIN');

  // ── 1. LegalEntity ───────────────────────────────────────────
  if (await hasColumn('Branch', 'invoiceSellerUbn')) {
    const { rows: branches } = await client.query(
      `SELECT id, name, code, type, "parentId", address, "invoiceSellerName", "invoiceSellerUbn", "legalEntityId"
         FROM "Branch" ORDER BY (CASE WHEN "parentId" IS NULL THEN 0 ELSE 1 END), id`,
    );
    const envUbn = (process.env.INVOICE_SELLER_UBN || '').trim() || null;
    const envMerchant = (process.env.EZPAY_MERCHANT_ID || '').trim() || null;
    let merchantAssigned = false;
    const { rows: existingMerchant } = await client.query(
      `SELECT 1 FROM "LegalEntity" WHERE "ezpayMerchantId" = $1`,
      [envMerchant],
    );
    if (existingMerchant.length) merchantAssigned = true;

    for (const b of branches) {
      if (b.legalEntityId) continue;
      const ubn = b.invoiceSellerUbn || envUbn;
      if (!ubn) {
        console.warn(`⚠️  分店 ${b.name} 無發票統編，未綁營業人（開票將排入佇列待設定）`);
        continue;
      }
      let { rows: [entity] } = await client.query(`SELECT id FROM "LegalEntity" WHERE ubn = $1`, [ubn]);
      if (!entity) {
        const code = String(b.code || `B${b.id}`).toUpperCase().replace(/[^A-Z0-9]/g, '') || `B${b.id}`;
        const name =
          (b.invoiceSellerName || '').trim() ||
          (process.env.INVOICE_SELLER_NAME || '').trim() ||
          `體育客 ${b.name}`;
        const merchantId = !merchantAssigned && envMerchant ? envMerchant : null;
        if (merchantId) merchantAssigned = true;
        ({ rows: [entity] } = await client.query(
          `INSERT INTO "LegalEntity" (code, name, ubn, address, "ezpayMerchantId", "isActive", "createdAt", "updatedAt")
           VALUES ($1,$2,$3,$4,$5,true,now(),now()) RETURNING id`,
          [code, name, ubn, b.address || null, merchantId],
        ));
        console.log(`✓ 營業人 ${code} ${name}（${ubn}）${merchantId ? `← ezPay ${merchantId}` : ''}`);
      }
      await client.query(`UPDATE "Branch" SET "legalEntityId" = $1 WHERE id = $2`, [entity.id, b.id]);
    }
  }

  // ── 2/3. 商品主檔＋分店庫存＋流水 ─────────────────────────────
  if (await hasColumn('Product', 'stockQty')) {
    const { rows: products } = await client.query(
      `SELECT id, "branchId", sku, price, cost, "stockQty", "safetyStock", "listPrice" FROM "Product" ORDER BY id`,
    );
    // 流水先補 branchId（依舊商品分店）
    await client.query(
      `UPDATE "StockMovement" m SET "branchId" = p."branchId"
         FROM "Product" p WHERE m."productId" = p.id AND m."branchId" IS NULL AND p."branchId" IS NOT NULL`,
    );
    for (const p of products) {
      if (p.branchId == null) continue;
      await client.query(
        `INSERT INTO "BranchStock" ("branchId","productId","salePrice","onHand","avgCost","safetyStock","isListed","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,true,now(),now())
         ON CONFLICT ("branchId","productId") DO NOTHING`,
        [p.branchId, p.id, Math.round(Number(p.price) || 0), Math.max(0, p.stockQty || 0), Number(p.cost) || 0, p.safetyStock],
      );
      if (!p.listPrice) {
        await client.query(`UPDATE "Product" SET "listPrice" = $1 WHERE id = $2`, [Math.round(Number(p.price) || 0), p.id]);
      }
    }
    // 同 SKU 合併：保留最小 id
    const { rows: dups } = await client.query(
      `SELECT sku, array_agg(id ORDER BY id) ids FROM "Product" GROUP BY sku HAVING count(*) > 1`,
    );
    for (const d of dups) {
      const [master, ...others] = d.ids;
      for (const oid of others) {
        await client.query(`UPDATE "BranchStock" SET "productId" = $1 WHERE "productId" = $2`, [master, oid]);
        await client.query(`UPDATE "SaleItem" SET "productId" = $1 WHERE "productId" = $2`, [master, oid]);
        await client.query(`UPDATE "StockMovement" SET "productId" = $1 WHERE "productId" = $2`, [master, oid]);
        await client.query(`DELETE FROM "Product" WHERE id = $1`, [oid]);
      }
      console.log(`✓ 合併 SKU ${d.sku}：${others.join(',')} → ${master}`);
    }

    // 流水帶號＋餘額（由現量倒推）
    const { rows: moves } = await client.query(
      `SELECT id, "branchId", "productId", type, qty, note, "qtyDelta" FROM "StockMovement" ORDER BY id DESC`,
    );
    const running = new Map();
    for (const m of moves) {
      let delta = m.qtyDelta;
      if (delta == null) {
        const qty = Number(m.qty) || 0;
        if (m.type === 'IN') delta = qty;
        else if (m.type === 'OUT') delta = -qty;
        else {
          const hit = /帳面\s*(-?\d+)\s*→\s*實盤\s*(-?\d+)/.exec(m.note || '');
          delta = hit ? Number(hit[2]) - Number(hit[1]) : 0;
        }
      }
      const key = `${m.branchId}:${m.productId}`;
      if (!running.has(key)) {
        const { rows: [s] } = await client.query(
          `SELECT "onHand" FROM "BranchStock" WHERE "branchId" = $1 AND "productId" = $2`,
          [m.branchId, m.productId],
        );
        running.set(key, s ? s.onHand : 0);
      }
      const after = running.get(key);
      await client.query(
        `UPDATE "StockMovement" SET "qtyDelta" = $1, "balanceAfter" = COALESCE("balanceAfter", $2), reason = COALESCE(reason, note) WHERE id = $3`,
        [delta, after, m.id],
      );
      running.set(key, after - delta);
    }
  }

  // ── 4. 銷貨單營業人／成本快照 ───────────────────────────────────
  await client.query(
    `UPDATE "SaleOrder" s SET "legalEntityId" = b."legalEntityId"
       FROM "Branch" b WHERE s."branchId" = b.id AND s."legalEntityId" IS NULL`,
  );
  await client.query(
    `UPDATE "SaleItem" i SET "unitCost" = m."unitCost"
       FROM "StockMovement" m
      WHERE i."unitCost" IS NULL AND m."refType" = 'SALE' AND m."refId" = i."saleOrderId" AND m."productId" = i."productId"`,
  );

  // ── 5. 舊發票欄位 → InvoiceRequest／EInvoice ─────────────────────
  if (await hasColumn('SaleOrder', 'invoiceNumber')) {
    const legacyBuyer = async (table, refType) => {
      const { rows } = await client.query(
        `SELECT id, "carrierNum", "buyerUbn", "loveCode" FROM "${table}"
          WHERE "carrierNum" IS NOT NULL OR "buyerUbn" IS NOT NULL OR "loveCode" IS NOT NULL`,
      );
      for (const r of rows) {
        await client.query(
          `INSERT INTO "InvoiceRequest" ("refId","refType","buyerUbn","carrierNum","loveCode","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,now(),now()) ON CONFLICT ("refId") DO NOTHING`,
          [r.id, refType, r.buyerUbn, r.carrierNum, r.loveCode],
        );
      }
    };
    await legacyBuyer('SaleOrder', 'SALE');
    await legacyBuyer('CheckoutSession', 'CHECKOUT');

    const insertInvoice = async ({ refType, refId, leg, checkoutSessionId, memberId, branchId, legalEntityId, amount, itemDesc, buyerUbn, carrierNum, loveCode, invoiceNumber, status, createdAt, items }) => {
      if (!legalEntityId) {
        console.warn(`⚠️  ${refId} 無營業人，略過舊發票遷移`);
        return;
      }
      const { rows: exist } = await client.query(
        `SELECT 1 FROM "EInvoice" WHERE "refId" = $1 AND leg = $2`,
        [refId, leg],
      );
      if (exist.length) return;
      const total = Math.round(Number(amount) || 0);
      if (total <= 0) return;
      const sales = Math.round(total / 1.05);
      const isB2B = Boolean(buyerUbn);
      const id = genId('EIV');
      await client.query(
        `INSERT INTO "EInvoice" (id,"legalEntityId","branchId","refType","refId",leg,seq,"checkoutSessionId","memberId","merchantOrderNo",
           category,"buyerUbn","carrierType","carrierNum","loveCode","printFlag","taxType","taxRate","salesAmount","taxAmount","totalAmount",
           "itemDesc",status,"invoiceNumber","issuedAt","periodKey","nextRetryAt","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,'1',5,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,now())`,
        [
          id, legalEntityId, branchId, refType, refId, leg, checkoutSessionId, memberId, sanitizeOrderNo(refId),
          isB2B ? 'B2B' : 'B2C', buyerUbn, carrierNum ? (carrierNum.startsWith('/') ? '0' : '1') : null, carrierNum, loveCode,
          isB2B || (!carrierNum && !loveCode) ? 'Y' : 'N',
          sales, total - sales, total, String(itemDesc || '').slice(0, 200), status, invoiceNumber,
          status === 'ISSUED' ? createdAt : null, status === 'ISSUED' ? periodKeyOf(createdAt) : null,
          status === 'FAILED' ? new Date() : null, createdAt,
        ],
      );
      let lineNo = 1;
      for (const it of items || [{ name: itemDesc, qty: 1, unitPrice: total, amount: total }]) {
        await client.query(
          `INSERT INTO "EInvoiceItem" ("einvoiceId","lineNo",name,qty,unit,"unitPrice",amount,"taxType","productId")
           VALUES ($1,$2,$3,$4,'個',$5,$6,'1',$7)`,
          [id, lineNo++, String(it.name || '商品').slice(0, 30), it.qty, Math.round(it.unitPrice), Math.round(it.amount), it.productId || null],
        );
      }
      console.log(`✓ 發票 ${invoiceNumber || '(待補開)'} → EInvoice ${refId}/${leg}`);
    };

    const { rows: sales } = await client.query(
      `SELECT s.*, b."legalEntityId" AS "entityId" FROM "SaleOrder" s JOIN "Branch" b ON b.id = s."branchId"
        WHERE s.status = 'PAID' AND (s."invoiceNumber" IS NOT NULL OR s."invoiceStatus" = 'FAILED')`,
    );
    for (const s of sales) {
      const { rows: items } = await client.query(
        `SELECT "productId", name, qty, "unitPrice", "lineTotal" AS amount FROM "SaleItem" WHERE "saleOrderId" = $1 ORDER BY id`,
        [s.id],
      );
      const inv = String(s.invoiceNumber || '');
      const real = inv && !inv.startsWith('SPLIT:') && !inv.includes(',');
      await insertInvoice({
        refType: 'SALE', refId: s.id, leg: s.checkoutSessionId ? 'SALE' : 'ALL',
        checkoutSessionId: s.checkoutSessionId, memberId: s.memberId, branchId: s.branchId,
        legalEntityId: s.entityId, amount: s.amount, itemDesc: s.itemDesc,
        buyerUbn: s.buyerUbn, carrierNum: s.carrierNum, loveCode: s.loveCode,
        invoiceNumber: real ? inv : null, status: real ? 'ISSUED' : 'FAILED', createdAt: s.updatedAt,
        items,
      });
    }

    // 舊版合併單一發票（非 SPLIT 且與子單號不同）
    const { rows: sessions } = await client.query(
      `SELECT c.*, b."legalEntityId" AS "entityId" FROM "CheckoutSession" c LEFT JOIN "Branch" b ON b.id = c."branchId"
        WHERE c.status = 'PAID' AND c."invoiceNumber" IS NOT NULL AND c."invoiceNumber" NOT LIKE 'SPLIT:%'`,
    );
    for (const c of sessions) {
      const { rows: child } = await client.query(`SELECT 1 FROM "EInvoice" WHERE "invoiceNumber" = $1`, [c.invoiceNumber]);
      if (child.length) continue;
      await insertInvoice({
        refType: 'CHECKOUT', refId: c.id, leg: 'ALL', checkoutSessionId: c.id, memberId: c.memberId,
        branchId: c.branchId, legalEntityId: c.entityId, amount: c.amount, itemDesc: c.itemDesc,
        buyerUbn: c.buyerUbn, carrierNum: c.carrierNum, loveCode: c.loveCode,
        invoiceNumber: c.invoiceNumber, status: 'ISSUED', createdAt: c.updatedAt,
      });
    }
  }

  await client.query('COMMIT');
  console.log('✓ migrateInventoryInvoice 完成');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('✗ migrateInventoryInvoice 失敗：', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
