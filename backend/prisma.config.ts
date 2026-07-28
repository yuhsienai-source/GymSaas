import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { defineConfig, env } from "@prisma/config";

// 無論從 monorepo 根目錄或 backend/ 執行，都載入 backend/.env
const backendRoot = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(backendRoot, ".env") });

export default defineConfig({
  schema: path.join(backendRoot, "prisma/schema.prisma"),
  datasource: {
    url: env("DATABASE_URL"),
  },
});
