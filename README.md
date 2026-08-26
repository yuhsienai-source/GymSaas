# 體育客 (GymSaaS)

前後端**絕對分離**的 monorepo。根目錄不是伺服器。

```text
GymSaas/
├── .cursorrules          # monorepo 憲法
├── .cursor/rules/        # Cursor 範圍規則
├── backend/              # 純 API（Express + Prisma + WS）
└── frontend/             # 獨立 SPA（Vite + React）
```

## 啟動

```bash
# Terminal A — API :8000
npm run dev:api

# Terminal B — 前端（Vite HTTPS，proxy /api 與 /ws）
npm run dev:web
```

Lint（前後端各自設定，根目錄僅轉發）：

```bash
npm run lint        # frontend + backend
npm run lint:web
npm run lint:api
npm run doctor:api  # backend：prisma validate → eslint → syntax
```

| 變數（在 `backend/.env`） | 意義 |
|---------------------------|------|
| `API_PUBLIC_URL` / `BASE_URL` | 後端公開網址（PayUNi Return／Notify、LINE Callback）— **必須是 API，勿與前端共用錯隧道** |
| `FRONTEND_URL` | **獨立**前端網域（刷卡回流 303 目標；本機預設 `https://localhost:5173`） |
| `CORS_ORIGIN` | 允許的前端 Origin（建議設成 `FRONTEND_URL`） |
| `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` | LINE Login（會員綁定／登入） |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API 推播（代約課通知）；未設則略過推播 |

### LINE 約課推播（2024/09/04 起）

自 2024-09-04 起，**無法**再於 LINE Developers Console 直接「新建 Messaging API Channel」。請改走官方帳號後台：

1. 到 [LINE Official Account Manager](https://manager.line.biz/) 建立／選取官方帳號  
2. **設定 → Messaging API → 啟用 Messaging API**，綁定既有 Provider（或新建）  
3. 啟用後回到 [LINE Developers Console](https://developers.line.biz/) 該 Provider 下會出現對應 Messaging API Channel  
4. 在 Channel 的 Messaging API 分頁核發 **Channel access token**（建議 long-lived），寫入 `backend/.env` 的 `LINE_CHANNEL_ACCESS_TOKEN`  
5. 學員須**加入該官方帳號為好友**，且會員已綁定 LINE（`Member.lineId`），推播才會送達  

LINE Login（登入／綁定）與 Messaging API（推播）可以是同一 Provider 下的不同 Channel；Access Token 一定要用 **Messaging API** 那組，不是 Login Channel。

禁止把 `FRONTEND_URL` 設成與 API 相同網址。

詳見：`backend/README.md`、`frontend/README.md`、各目錄 `.cursorrules`。
