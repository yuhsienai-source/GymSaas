# 體育客 (GymSaaS) Backend API

純後端 API（前後端絕對分離）。**不託管 UI**（無 `public/`、無 HTML）。

## 啟動

```bash
npm run setup  # 含 prisma db push（schema 變更後務必執行）
npm run dev
```

健康檢查：`GET /api/health`（JSON）。`GET /` 亦回 JSON。

資安基線：正式環境必填 `CORS_ORIGIN`（可逗號分隔多個前端來源）；`OTP_DEV_REVEAL` 僅限非正式環境，正式環境不回傳／不記錄 OTP 明碼。

進銷存：HQ `products`／`purchases`；櫃檯 `POST /api/ops/pos/checkout`（CASH／CARD／WALLET_CASH）。服務類商品 `productKind=SERVICE` 不控庫存；`GET /ops/products` 須回傳 `productKind`。

交接班：早／中／晚；底金＝上一班實點；超商式流程（盲點面額點鈔→對帳→檢核清單→簽核）；支付分欄；操作人員紀錄；差額僅店長／總部；可列印結算單。

報表：`GET /api/hq/reports/{orders|topup|gate|sales|course-purchases|trainer|analytics}`；課程購買報表展開 `CheckoutSession.ptItems`（含獨立私教 Order）。
一般儲值報表（`/hq/reports/topup`）回傳 `planName`（由訂單快照 `itemDesc` 解析）供前端顯示「方案」欄。

教練分店：`POST /api/hq/trainers/assign` — 一般教練（NORMAL）綁定指定分店（可多間）；主管教練（MANAGER）不限分店（`branchIds` 可空）。

團課期班：`ClassSeries`；`POST /api/pt/schedule-group-class` Body：`startDate`／`endDate`／`weekdays`／`startTime`／`endTime`（展開多堂 GROUP `Class`）。

分店購案歸屬（`lib/branchShare.js`）：私教上課依購案分店（**HP↔HR** 共享）。**會員綁定分店**（`MemberBranch`）：`POST/PATCH /api/ops/members` 須 `branchIds`；進出場掃碼／刷臉優先 `deviceCode`＋`deviceKey`（`GateDevice` 綁定分店），相容 `branchId`／`GATE_BRANCH_ID`；須∈綁定場館（**AC↔HP** 可互進），否則 403。

進出場裝置：HQ `GET/POST /api/hq/gate-devices`、`PATCH /api/hq/gate-devices/:id`、`POST .../rotate-key`（明文金鑰僅建立／輪替回傳一次）；閘機 `POST /api/gate/device/pair` 配對驗證。

分店／場地刪除：`DELETE /api/hq/branches/:id`（有關聯則軟刪停用，否則硬刪）、`DELETE /api/hq/venues/:id`（有課程／期班則 409）。

方案刪除：`DELETE /api/hq/promotions/:id`（有訂閱則下架）、`DELETE /api/hq/course-plans/:id`（上架先下架，再刪永久移除）。

定期定額週期：以天數遞延計算 `nextChargeAt`（W=+7 天、M=+30 天、Y=+365 天；起始日算第 1 天）。
單號規則：一般儲值（TIMED）`TYK...`；訂閱制月卡（UNLIMITED）與定期定額（RECURRING）訂單／續扣 `CRS...`。
取消訂閱結算：`:id` 可用訂閱編號 `CRS`，或以訂單號（`CRS`／舊 `TYK`）反查；一次付清／現金月卡（無定期定額）亦可用訂單號做效期結算（KEEP／CUT）。
私教取消：`POST /api/ops/cancel-pt-purchase`（`checkoutId` 或 `orderId`；`prefer=void|allowance`）；一般報表列可直接取消沖回／退費折讓。
合併結帳軟拆：購物車仍一次付款（CHK／PayUNi），ezPay **分腿開票**（SAL／購案／私教各一張，MerchantOrderNo＝子單號）；異動各自作廢／折讓。舊版「整張 CHK 發票」仍禁止在有存活兄弟單時作廢。

櫃檯在場：`GET /api/ops/check-ins/active?branchId=`；補登出場 `POST /api/ops/check-ins/:logId/check-out`（依進場快照計費）；取消進場 `POST /api/ops/cancel-gate`（在場不計費；已出場退費限 DUTY+）。

開發 CORS：`CORS_ORIGIN` 之外，非正式環境另允許區網 Vite Origin（`https://192.168.x.x:5173` 等），方便手機連本機前端。

教練排休：`TrainerTimeOff`；教練服務台「排休」分頁；`GET/POST/PATCH/DELETE /api/trainer/time-offs`；團課／私教排課重疊則 409；會員 `GET /api/member/trainers/:trainerId/time-offs`（需有該教練進行中私教合約）。

諮詢客人：`ConsultGuest`（姓名＋電話）；`POST /api/trainer/schedule-consult` 自選日期／時間開 CONSULT 代約（無需選課程、無需私教合約）；亦可 `POST /api/trainer/book-consult` 對既有 CONSULT 堂代約。私教代約：`POST /api/trainer/schedule-private`（`contractId`＋場地＋時段，扣堂）。會員 LINE 約課：`GET /api/member/classes`、`POST /api/member/book-class`、`GET /api/member/reservations`、`POST /api/member/reservations/:id/cancel`（前端 `/member/book`）。

LINE OAuth：`/api/auth/line/callback` 302 回前端時改帶一次性 `auth_code`（短效、單次可用），前端再呼叫 `POST /api/auth/exchange-auth-code` 換 JWT。

分店發票抬頭：`invoiceSellerName`／`invoiceSellerUbn`（統編選填；有填須通過財政部檢查碼：權重 1,2,1,2,1,2,4,1，總和被 5 整除；空白＝清除／用環境變數預設）。

員工／教練：`name`＝真實姓名（總部／交接班）；`displayName`＝對外顯示（預設「匿名」）。會員約課／LINE／員工側欄用顯示名稱。

分店代碼：`Branch.code`（建立必填、唯一）；員工／櫃檯／報表關聯顯示代碼；會員介面／LINE／發票一律用 `Branch.name`。

守則：`backend/.cursorrules`
