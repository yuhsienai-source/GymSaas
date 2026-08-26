# 體育客 Frontend（SPA Only）

獨立 Vite + React 前端。**不內嵌後端**；開發時透過 proxy 呼叫 `backend`。

視覺語言為 **Adaptive Tech-Sport**（`src/index.css`）：管理端／閘機用運動海軍藍 `#1A2332`＋玻璃擬態；會員端亮灰透氣＋深色頂欄＋螢光Mint 漸層錢包／門禁卡。員工後台支援 Ctrl/⌘K、教練週曆拖拉改期。

分流：`landing--member`（`/`、`/auth*`、`/pay*`）與 `.member-app` 為亮色；`/portal`、`/staff/*`、閘機為深色。

## 啟動

```bash
npm run dev
# 預設 HTTPS（basicSsl）→ https://localhost:5173
# 手機請用電腦區網 IP：https://192.168.x.x:5173（勿用手機上的 localhost）
# 首次請先開啟 /api/health 並信任自簽憑證，再登入
# /api、/ws → http://127.0.0.1:8000
npm run lint   # ESLint（eslint.config.js）
```

## 與後端契約

| 前端路由 | 後端 env |
|----------|----------|
| `/auth/callback` | `FRONTEND_AUTH_CALLBACK_PATH` |
| `/pay/return` | `FRONTEND_PAY_RETURN_PATH` |
| `/board` | 連 `/ws/occupancy` 或 `GET /api/board/occupancy` |

後端 `FRONTEND_URL` 必須指向本前端網域（本機 `https://localhost:5173`）。

## 禁令

- 不修改 `backend/`
- 會員／門禁不傳 `memberId`
- 儲值不傳任意金額，只傳 `promotionId`
- 閘機進出場以裝置配對為主（優先掃總部配對 QR），不自選任意分店冒充場館；刷臉只送 `faceImage`（禁 `memberId`）。通行頁只開一路相機，同畫面可刷臉並軟體解會員 QR。

守則：`frontend/.cursorrules`
