#!/usr/bin/env node
/**
 * 退費快照回填（prisma db push 之後、db:constraints 之後執行；可重跑）
 *  1. Order.grantedCash／grantedBonus：計時儲值訂單自 itemDesc 當下快照（現金+X / 運動金+Y）回填
 *  2. PTContract.orderId：私教購案訂單 ↔ 合約（同會員、同方案、同金額、建立時間 ±10 秒、唯一候選才連結）
 *     課程定期定額：首期訂單 ↔ 合約（同會員、同方案、訂單建立後 3 日內、唯一候選才連結）
 *  3. EInvoiceItem.saleItemId：銷貨發票明細依稅別分張與行序對應 SaleItem（筆數不符者略過）
 * 用法：node --env-file=.env prisma/migrateRefundSnapshots.js [--dry-run]
 */
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');

const pool = new pg.Pool({ connectionString });
const client = await pool.connect();

const isTaxFree = (t) => ['TAX_FREE', 'FREE', '3'].includes(String(t || '').toUpperCase());

try {
  await client.query('BEGIN');

  // ── 1. 計時儲值入帳快照 ───────────────────────────────────────
  const { rows: topups } = await client.query(
    `SELECT id, "itemDesc" FROM "Order"
      WHERE "grantedCash" IS NULL AND "itemDesc" LIKE '%| TIMED |%' AND status IN ('PAID', 'REFUNDED')`,
  );
  let grants = 0;
  let grantSkipped = 0;
  for (const o of topups) {
    const cash = String(o.itemDesc).match(/現金\+(\d+)/);
    const bonus = String(o.itemDesc).match(/運動金\+(\d+)/);
    if (!cash || !bonus) {
      grantSkipped += 1;
      continue;
    }
    await client.query(`UPDATE "Order" SET "grantedCash" = $2, "grantedBonus" = $3 WHERE id = $1`, [
      o.id,
      parseInt(cash[1], 10),
      parseInt(bonus[1], 10),
    ]);
    grants += 1;
  }
  console.log(`1. 儲值快照：回填 ${grants} 筆，無法解析 ${grantSkipped} 筆（原單取消將回 409 TOPUP_GRANT_UNKNOWN）`);

  // ── 2. 私教合約 ↔ 訂單 ───────────────────────────────────────
  const { rows: ptOrders } = await client.query(
    `SELECT o.id, o."memberId", o.amount, o."itemDesc", o."createdAt"
       FROM "Order" o
      WHERE o."itemDesc" LIKE '私教購案%'
        AND NOT EXISTS (SELECT 1 FROM "PTContract" c WHERE c."orderId" = o.id)`,
  );
  let linked = 0;
  let ambiguous = 0;
  for (const o of ptOrders) {
    const planMatch = String(o.itemDesc).match(/方案#(\d+)/);
    const { rows: cands } = await client.query(
      `SELECT id FROM "PTContract"
        WHERE "orderId" IS NULL AND source = 'PURCHASE' AND "memberId" = $1
          AND ABS("pricePaid" - $2) < 0.01
          AND ($3::int IS NULL OR "coursePlanId" = $3)
          AND "createdAt" BETWEEN $4::timestamptz - interval '10 seconds' AND $4::timestamptz + interval '10 seconds'`,
      [o.memberId, Number(o.amount), planMatch ? parseInt(planMatch[1], 10) : null, o.createdAt],
    );
    if (cands.length !== 1) {
      ambiguous += 1;
      continue;
    }
    await client.query(`UPDATE "PTContract" SET "orderId" = $2 WHERE id = $1`, [cands[0].id, o.id]);
    linked += 1;
  }
  console.log(`2. 私教合約：連結 ${linked} 筆，無唯一候選 ${ambiguous} 筆（退費將回 409 PT_CONTRACT_UNLINKED，須人工處理）`);

  // ── 2b. 課程定期定額合約 ↔ 首期訂單（合約於首期入帳時建立：同會員、同方案、訂單建立後 3 日內、唯一候選）
  const { rows: subOrders } = await client.query(
    `SELECT o.id, o."memberId", o."itemDesc", o."createdAt"
       FROM "Order" o
      WHERE o."itemDesc" LIKE '課程定期定額首期%'
        AND o.status IN ('PAID', 'REFUNDED')
        AND NOT EXISTS (SELECT 1 FROM "PTContract" c WHERE c."orderId" = o.id)`,
  );
  let subLinked = 0;
  let subAmbiguous = 0;
  for (const o of subOrders) {
    const planMatch = String(o.itemDesc).match(/課程方案#(\d+)/);
    if (!planMatch) {
      subAmbiguous += 1;
      continue;
    }
    const { rows: cands } = await client.query(
      `SELECT id FROM "PTContract"
        WHERE "orderId" IS NULL AND source = 'PURCHASE' AND "memberId" = $1 AND "coursePlanId" = $2
          AND "createdAt" BETWEEN $3::timestamptz - interval '10 seconds' AND $3::timestamptz + interval '3 days'`,
      [o.memberId, parseInt(planMatch[1], 10), o.createdAt],
    );
    if (cands.length !== 1) {
      subAmbiguous += 1;
      continue;
    }
    await client.query(`UPDATE "PTContract" SET "orderId" = $2 WHERE id = $1`, [cands[0].id, o.id]);
    subLinked += 1;
  }
  console.log(`2b. 課程分期合約：連結 ${subLinked} 筆，無唯一候選 ${subAmbiguous} 筆（退費將回 409 PT_CONTRACT_UNLINKED，須人工處理）`);

  // ── 3. 銷貨發票明細 ↔ SaleItem ───────────────────────────────
  const { rows: invoices } = await client.query(
    `SELECT e.id, e."refId", e.leg FROM "EInvoice" e
      WHERE e."refType" = 'SALE'
        AND EXISTS (SELECT 1 FROM "EInvoiceItem" i WHERE i."einvoiceId" = e.id AND i."saleItemId" IS NULL)`,
  );
  let mapped = 0;
  let mismatched = 0;
  for (const inv of invoices) {
    const free = String(inv.leg).endsWith('_FREE');
    const { rows: saleItems } = await client.query(
      `SELECT id, "taxType" FROM "SaleItem" WHERE "saleOrderId" = $1 AND "unitPrice" > 0 ORDER BY id`,
      [inv.refId],
    );
    const group = saleItems.filter((s) => isTaxFree(s.taxType) === free);
    const { rows: items } = await client.query(
      `SELECT id FROM "EInvoiceItem" WHERE "einvoiceId" = $1 ORDER BY "lineNo"`,
      [inv.id],
    );
    if (group.length !== items.length) {
      mismatched += 1;
      continue;
    }
    for (let i = 0; i < items.length; i += 1) {
      await client.query(`UPDATE "EInvoiceItem" SET "saleItemId" = $2 WHERE id = $1`, [items[i].id, group[i].id]);
    }
    mapped += 1;
  }
  console.log(`3. 發票明細：對應 ${mapped} 張，筆數不符 ${mismatched} 張（退貨折讓改依品名／金額分攤）`);

  if (dryRun) {
    await client.query('ROLLBACK');
    console.log('（--dry-run：已回滾）');
  } else {
    await client.query('COMMIT');
    console.log('✓ migrateRefundSnapshots 完成');
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('✗ migrateRefundSnapshots failed:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
