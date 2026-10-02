#!/usr/bin/env node
/**
 * 錢包流水稽核（唯讀）：每位會員自第一筆新制 WalletLedger（cashBefore 非 null）起
 *  1. 連續性：上一筆 cashAfter／bonusAfter 與下一筆 cashBefore／bonusBefore 差 < 0.005（流水斷鏈＝有人繞過 walletMutation 改餘額）
 *  2. 單筆恆等：before＋delta＝after（DB CHECK 已保證，此處再驗）
 *  3. 期末：最後一筆 after 等於目前 Member.cashWallet／bonusWallet
 * 有異常 exit 1。用法：npm run wallet:audit [-- --member=123] [-- --limit=100]
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const TOL = 0.005;

/** @param {import('pg').ClientBase} client */
export async function auditWallets(client, { memberId = null } = {}) {
  const params = memberId ? [memberId] : [];
  const memberWhere = memberId ? 'AND l."memberId" = $1' : '';

  const { rows: [stats] } = await client.query(
    `SELECT count(*)::int AS rows, count(DISTINCT "memberId")::int AS members
       FROM "WalletLedger" l WHERE l."cashBefore" IS NOT NULL ${memberWhere}`,
    params,
  );

  const { rows: breaks } = await client.query(
    `WITH seq AS (
       SELECT l.id, l."memberId", l."reasonCode", l."createdAt",
              l."cashBefore", l."cashDelta", l."cashAfter", l."bonusBefore", l."bonusDelta", l."bonusAfter",
              lag(l.id) OVER w AS "prevId", lag(l."cashAfter") OVER w AS "prevCash", lag(l."bonusAfter") OVER w AS "prevBonus"
         FROM "WalletLedger" l
        WHERE l."cashBefore" IS NOT NULL ${memberWhere}
       WINDOW w AS (PARTITION BY l."memberId" ORDER BY l.id)
     )
     SELECT *,
            CASE
              WHEN abs("cashBefore" + "cashDelta" - "cashAfter") >= ${TOL}
                OR abs("bonusBefore" + "bonusDelta" - "bonusAfter") >= ${TOL} THEN 'ROW_MATH'
              ELSE 'CHAIN_BREAK'
            END AS kind
       FROM seq
      WHERE abs("cashBefore" + "cashDelta" - "cashAfter") >= ${TOL}
         OR abs("bonusBefore" + "bonusDelta" - "bonusAfter") >= ${TOL}
         OR ("prevId" IS NOT NULL AND (abs("prevCash" - "cashBefore") >= ${TOL} OR abs("prevBonus" - "bonusBefore") >= ${TOL}))
      ORDER BY "memberId", id`,
    params,
  );

  const { rows: tails } = await client.query(
    `SELECT DISTINCT ON (l."memberId")
            l."memberId", l.id AS "ledgerId", l."cashAfter", l."bonusAfter", m."cashWallet", m."bonusWallet"
       FROM "WalletLedger" l
       JOIN "Member" m ON m.id = l."memberId"
      WHERE l."cashBefore" IS NOT NULL ${memberWhere}
      ORDER BY l."memberId", l.id DESC`,
    params,
  );
  const tailMismatch = tails.filter(
    (t) => Math.abs(t.cashAfter - t.cashWallet) >= TOL || Math.abs(t.bonusAfter - t.bonusWallet) >= TOL,
  );

  return { stats, breaks, tailMismatch };
}

function report({ stats, breaks, tailMismatch }, { memberId, limit }) {
  console.log(`[wallet:audit] 新制流水 ${stats.rows} 筆／會員 ${stats.members} 位${memberId ? `（僅會員 #${memberId}）` : ''}`);
  if (!breaks.length && !tailMismatch.length) {
    console.log('[wallet:audit] ✓ 流水連續、單筆恆等、期末餘額一致');
    return true;
  }
  if (breaks.length) {
    console.log(`[wallet:audit] ✗ 流水異常 ${breaks.length} 筆（顯示前 ${Math.min(limit, breaks.length)}）`);
    for (const b of breaks.slice(0, limit)) {
      console.log(
        `  ${b.kind} member#${b.memberId} ledger#${b.id}（前筆 #${b.prevId ?? '—'}）${b.reasonCode} ${b.createdAt.toISOString()}`
          + ` 本金 前筆後 ${b.prevCash ?? '—'} → 本筆前 ${b.cashBefore}｜運動金 前筆後 ${b.prevBonus ?? '—'} → 本筆前 ${b.bonusBefore}`,
      );
    }
  }
  if (tailMismatch.length) {
    console.log(`[wallet:audit] ✗ 期末餘額不符 ${tailMismatch.length} 位（顯示前 ${Math.min(limit, tailMismatch.length)}）`);
    for (const t of tailMismatch.slice(0, limit)) {
      console.log(
        `  member#${t.memberId} 最後流水 #${t.ledgerId}：本金 ${t.cashAfter} vs 餘額 ${t.cashWallet}｜運動金 ${t.bonusAfter} vs 餘額 ${t.bonusWallet}`,
      );
    }
  }
  return false;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const memberId = arg('member') ? parseInt(arg('member'), 10) : null;
  const limit = Math.max(1, parseInt(arg('limit') || '50', 10) || 50);

  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await auditWallets(client, { memberId });
    await client.query('COMMIT');
    if (!report(result, { memberId, limit })) process.exitCode = 1;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[wallet:audit] 執行失敗：', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
