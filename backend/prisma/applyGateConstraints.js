#!/usr/bin/env node
/**
 * 套用閘機並發／錢包 CHECK（Prisma schema 無法表達 partial unique）。
 * 用法：node --env-file=.env prisma/applyGateConstraints.js
 * 或：npm run db:constraints
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, 'sql', 'gate_concurrency.sql');
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, 'utf8');
const pool = new pg.Pool({ connectionString });

try {
  await pool.query(sql);
  console.log('✓ gate concurrency constraints applied (uniq_active_member_checkin + wallet CHECK)');
} catch (err) {
  console.error('✗ applyGateConstraints failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
