// 測試環境：每個測試檔第一個 import。強制改用本機獨立測試庫（<db>_test），禁止連到開發／雲端資料庫
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(backendRoot, '.env'), quiet: true });

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** TEST_DATABASE_URL 優先；否則以 DATABASE_URL 之庫名加 _test。非本機或庫名非 _test 結尾一律拒絕 */
export function resolveTestDatabaseUrl() {
  const raw = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!raw) throw new Error('缺少 DATABASE_URL（或 TEST_DATABASE_URL），無法建立測試庫');
  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`測試僅允許本機 PostgreSQL，拒絕連線 ${url.hostname}（請設定 TEST_DATABASE_URL）`);
  }
  let db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!process.env.TEST_DATABASE_URL && !db.endsWith('_test')) db = `${db}_test`;
  if (!/^[A-Za-z0-9_]+_test$/.test(db)) throw new Error(`測試庫名稱必須以 _test 結尾：${db}`);
  url.pathname = `/${db}`;
  return url.toString();
}

process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.ID_PHOTO_STORAGE = 'local';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'gymsaas-test-only-secret';
