// lib/prisma.js
import { PrismaClient } from '@prisma/client'; // 🚨 這是唯一正確的引入方式
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// 1. 使用原生的 pg 套件建立連線池
const connectionString = process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString });

// 2. 將連線池裝上 Prisma 配接器
const adapter = new PrismaPg(pool);

// 3. 把 adapter 傳給 PrismaClient
const prisma = new PrismaClient({ adapter, log: ['info', 'warn', 'error'] });

// 將設定好的 prisma 實體匯出，供其他檔案共用
export default prisma;

/** 外部建立之連線池不隨 prisma.$disconnect() 關閉；需完整結束行程（腳本／測試）時另行 end() */
export async function closePrisma() {
  await prisma.$disconnect();
  await pool.end();
}