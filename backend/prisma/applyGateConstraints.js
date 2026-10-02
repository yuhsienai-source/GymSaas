#!/usr/bin/env node
/**
 * 套用 Prisma schema 無法表達的 DB 約束（partial unique／CHECK）：
 *  - gate_concurrency.sql：閘機防雙進＋錢包非負
 *  - inventory_invoice.sql：庫存非負、發票金額勾稽／同腿唯一、採購數量、應付已付範圍
 *  - refund_constraints.sql：同子單單一未結案退費、退貨數量／已退金額上限、退款管道規則、流水／稽核 append-only
 * 用法：node --env-file=.env prisma/applyGateConstraints.js
 * 或：npm run db:constraints
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILES = ['gate_concurrency.sql', 'inventory_invoice.sql', 'refund_constraints.sql'];
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });

try {
  for (const file of SQL_FILES) {
    const sql = fs.readFileSync(path.join(__dirname, 'sql', file), 'utf8');
    await pool.query(sql);
    console.log(`✓ ${file} applied`);
  }
} catch (err) {
  console.error('✗ applyGateConstraints failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
