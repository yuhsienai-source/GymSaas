#!/usr/bin/env node
// 重建本機測試庫：DROP／CREATE <db>_test → prisma db push（空庫，無資料遺失）→ db:constraints
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { backendRoot } from './helpers/env.js';

const testUrl = process.env.DATABASE_URL;
const dbName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
const adminUrl = new URL(testUrl);
adminUrl.pathname = '/postgres';

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
} finally {
  await admin.end();
}

function run(cmd, args) {
  const out = spawnSync(cmd, args, {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: testUrl },
    encoding: 'utf8',
  });
  if (out.status !== 0) {
    process.stderr.write(out.stdout || '');
    process.stderr.write(out.stderr || '');
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} 失敗（exit ${out.status}）`);
  }
}

run(path.join(backendRoot, 'node_modules/.bin/prisma'), ['db', 'push']);
run(process.execPath, ['prisma/applyGateConstraints.js']);
console.log(`✓ 測試庫 ${dbName} 已重建`);
