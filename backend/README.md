# 體育客 (GymSaaS) Backend API

純後端 API（前後端絕對分離）。**不託管 UI**（無 `public/`、無 HTML）。

## 啟動

```bash
npm run setup  # generate + db push + db:constraints + seed（schema／閘機約束變更後務必執行）
npm run dev
npm run doctor # prisma validate → eslint → node --check
```

健康檢查：`GET /api/health`（JSON）。`GET /` 亦回 JSON。

PayUNi：`ReturnURL`＝瀏覽器回流（優先 `FRONTEND_URL/api/ops/payuni/return`，回 HTML 自動跳轉櫃檯）；`NotifyURL`＝背景入帳（`API_PUBLIC_URL/api/ops/payuni/webhook`，須公網）。兩者可同網域（ngrok→Vite 且 proxy `/api`）。`localhost` 不能當 Notify。商店後台「串接設定」也建議填相同 Return／Notify。缺 Notify 不會擋跳回，只會讓訂單晚入帳／不入帳。

**續期收款例外**：PayUNi 定期定額支付頁成功後**不會**打 ReturnURL（畫面只有買家專區連結）。櫃檯改為另開金流分頁，入帳只認 Notify；前端以 `GET /api/ops/checkout/:id`（`:id`＝`CHK…` 或訂單號）輪詢至 `PAID`。續期 Notify 常無 `TradeStatus`、且 `MerTradeNo` 為 PayUNi 自編：後端以 `Status=SUCCESS`＋`ResCode=00`／`AuthAmt` 判定成功，並以 `ProdDesc` 前置本系統單號（或近期同額 PENDING RECURRING）對應入帳。

資安基線：正式環境必填 `CORS_ORIGIN`（可逗號分隔多個前端來源）；`OTP_DEV_REVEAL` 僅限非正式環境揭示 **LOGIN／REGISTER** Email OTP；正式環境與換機碼一律不回傳／不記錄 OTP 明碼。

會員自助登入／註冊：主流程 `POST /api/onboarding/lookup` 帶 **`phone`＋`idNumber`** 辨識新舊；未綁 Email → 補登／新客先驗證 Email（`otp/send|verify` 或 `email-enroll/*`）；未完成註冊一律續走註冊（契約→證件→選用綁 LINE→裝置）。相容舊客戶端 `identity`（手機或 Email）。`POST /onboarding/register` 必填 `phone`＋`idNumber`（身分證／居留證／護照／國籍證件）。LINE 一鍵登入僅限已綁定者；新客不可用 LINE 起註冊。臨櫃開卡同理必填手機與證件。換機：身分＋Email OTP（不依賴 SMS）。

換機（禁僅靠 Email）：`POST /api/auth/device-reset/request-email`（`identity`＝證件或註冊手機＋`email`，可選 `resetTicket`）→ 相符才寄信；`POST /api/auth/device-reset/verify-email`（OTP＋同核身）通過後才改綁並遞增 `deviceAuthVersion`；未簽 `NEW_MEMBER` 回 403。**自助換機頻率熔斷**：預設 **24 小時內 1 次**、**近 30 日最多 2 次**實際改綁（`DEVICE_RESET_COOLDOWN_HOURS`／`DEVICE_RESET_MONTHLY_MAX`）；超限 **429 `DEVICE_RESET_RATE_LIMITED`**，須櫃檯 DUTY+。限流：IP＋目標。備援：`POST /api/ops/members/:id/reset-device`（DUTY+，不計入自助上限）。SMTP：`SMTP_HOST`／`SMTP_USER`／`SMTP_PASS`／`MAIL_FROM`（未設則 mock，body 仍 redact）。

閘機防潛回（Anti-passback）：進場時若已有 `checkOutAt=null` 且 `status=ACTIVE` 的在場紀錄 → **403 `ANTI_PASSBACK`**，禁止再次刷開進場閘（防遞碼／尾隨後二次刷入）。進／出場交易對 `Member`（出場另對 ACTIVE `CheckInLog`）做 **`SELECT … FOR UPDATE`**；DB partial unique `uniq_active_member_checkin` + 錢包 `CHECK (>=0)`（`npm run db:constraints`，含於 `setup`）。出場雙錢包以條件式 SQL 遞減，禁止負餘額；不足扣則結算釋放在場但 **`gateOpen=false`**＋`feeDetails.shortfall`。出場若查無 `ACTIVE` 在場紀錄 → **409 `NO_ACTIVE_CHECKIN`**（拒開門）並經 **`/ws/gate-alert`** 推播櫃檯「異常滯留」。未簽入會契約 → **403 `CONTRACT_REQUIRED`**（禁 `qrToken`／禁進場）。計時餘額門檻 **$50**。閘機 `GET /gate/sync-time`（QR 容許 ±5s）；DAV 短 TTL 快取（改綁須驅除）。

乙禾暫存／發票佇列：端末成功 → `POST /ops/yipay/captures`；日結 `GET /ops/yipay/reconcile?branchId=&edcCount=&edcAmount=`（系統 YIPAY 認列 vs EDC 結算單）。開票 `InvoiceIssueJob`；失敗可 `POST /ops/invoice-jobs/:id/retry`。櫃檯 UI：交接班「刷卡機日結核對」＋頂部發票 FAILED 橫條。


進銷存：HQ `products`／`purchases`；櫃檯合併結帳 `POST /api/ops/checkout`（CASH／**YIPAY 乙禾現場刷卡**／CARD＝PayUNi 僅定期定額／LINEPAY／WALLET_CASH／VOUCHER）；獨立 POS `POST /api/ops/pos/checkout` 同付款碼（臨櫃一次刷卡請用 YIPAY，端末後 `POST /api/ops/confirm-yipay`）。服務類商品 `productKind=SERVICE` 不控庫存；`GET /ops/products` 須回傳 `productKind`。

交接班：早／中／晚；底金＝上一班實點；超商式流程（盲點面額點鈔→對帳→檢核清單→簽核）；支付分欄；操作人員紀錄；差額僅店長／總部；可列印結算單。

報表：`GET /api/hq/reports/{orders|topup|gate|sales|course-purchases|trainer|analytics}`；課程購買報表展開 `CheckoutSession.ptItems`（含獨立私教 Order）。
銷售分析（`/hq/reports/analytics`）：必有日期區間（缺省近 30 日、最長 366 日）；概覽用 DB aggregate，明細類仍限該區間。
一般儲值報表（`/hq/reports/topup`）回傳 `planName`（由訂單快照 `itemDesc` 解析）供前端顯示「方案」欄。
櫃檯會員：`GET /api/ops/members?q=&take=&skip=&id=&lite=` 分頁搜尋（`lite=1` 略過契約板，供 Cmd+K）。

教練分店：`POST /api/hq/trainers/assign` — 一般教練（NORMAL）綁定指定分店（可多間）；主管教練（MANAGER）不限分店（`branchIds` 可空）。

團課期班：`ClassSeries`；`POST /api/pt/schedule-group-class` Body：`startDate`／`endDate`／`weekdays`／`startTime`／`endTime`（展開多堂 GROUP `Class`）。

分店購案歸屬（`lib/branchShare.js`）：私教上課依購案分店（**HP↔HR** 共享）。**會員綁定分店**（`MemberBranch`）：`POST/PATCH /api/ops/members` 須 `branchIds`；進出場掃碼／刷臉優先 `deviceCode`＋`deviceKey`（`GateDevice` 綁定分店），相容 `branchId`／`GATE_BRANCH_ID`；須∈綁定場館（**AC↔HP** 可互進），否則 403。

進出場裝置：HQ `GET/POST /api/hq/gate-devices`、`PATCH /api/hq/gate-devices/:id`、`POST .../rotate-key`（明文金鑰僅建立／輪替回傳一次）；閘機 `POST /api/gate/device/pair` 配對驗證。

分店／場地刪除：`DELETE /api/hq/branches/:id`（有關聯則軟刪停用，否則硬刪）、`DELETE /api/hq/venues/:id`（有課程／期班則 409）。

方案刪除：`DELETE /api/hq/promotions/:id`（有訂閱則下架）、`DELETE /api/hq/course-plans/:id`（上架先下架，再刪永久移除）。
合規補償（ADMIN）：`POST /api/hq/members/:id/compensate-bonus`（僅 `promotionId`＋`reason`，專案須 `kind=COMPENSATION`、`price=0`）、`.../compensate-course`（僅 `coursePlanId`＋`trainerId`＋`reason`，課程須 `kind=COMPENSATION`、`price=0`；建立 `PTContract.source=COMPENSATION` 與付費購案區隔）、`.../compensate-expire`（`days`＋`reason`）、`.../clear-alert`（`reason`）；日誌 `GET /api/hq/compensation-logs`；會員搜尋 `GET /api/hq/members/search?q=`。客訴補償專案／課程不出現在櫃檯／會員可售列表；櫃檯 `PATCH /ops/members` 不可直接 `isAlert=false`。
課程方案定期定額（`POST/PATCH /api/hq/course-plans`）：`enableCardRecurring`；`recurringPeriods` 為可選期數 bitmask（`2`＝僅2期、`4`＝僅4期、`6`＝可選2或4期；亦接受陣列 `[2,4]`）；`recurringAmount`（2期＝第2期）、`recurringAmount4`（4期＝第1~3期共用）、`recurringAmountFinal`（4期＝第4期）。各選項期數金額加總需等於 `price`。櫃檯 `GET /api/ops/course-plans` 須回傳上述定期定額欄位；結帳依方案排程計首期／續扣，禁止臨櫃覆寫金額。
儲值方案定期定額（無限使用／月卡）：首期＝`price`；後續扣款＝`recurringAmount`（啟用時必填，可與首期不同；舊資料未填則回退 `price`）；總扣款期數固定＝有效期 `periodCount`（後端結帳／建訂閱強制，前端不可覆寫）。**臨櫃流程＝乙禾收首期 → confirm 後開 PayUNi 續期頁約定**（`TradeAmt`＝`FAmt`＝驗證授權，預設 `$1`／`PAYUNI_BIND_VERIFY_AMT`；Notify 後 `trade_cancel` 取消授權不請款；`PeriodAmt`＝`recurringAmount` 自第 2 期、期數＝`periodCount−1`；已 PAID 的 Notify 只回寫 `CreditHash`）。續期收款支付頁 Notify 常無 `CreditHash`：仍建立 `CardSubscription`（`creditHash=PERIOD:…` 佔位），本機排程不幕後扣；取消訂閱可用訂閱號或訂單號（缺訂閱列時會補建或改走效期結算）。`GET /ops/card-subscriptions`（篩選優先 `memberNo`，相容 `memberId`）會對已付款缺訂閱列自動補建，並以方案／課程 `branchId` 過濾分店。請假：`GET/POST /ops/member-leaves` 同以 `memberNo` 為主。
櫃檯結帳選定期定額：儲值或課程皆可；**首期臨櫃走乙禾（YIPAY）**，確認入帳後另開 **PayUNi 續期頁**（`bindOnly`：臨櫃 `TradeAmt`＝`FAmt`＝`$1` 驗證授權→`trade_cancel`；`PeriodAmt`＝原價自第 2 期；未來 `Date`／`FDate`）。**臨櫃與會員線上必須用不同續期 Hash**：臨櫃＝方案 `payuniPeriodHash`／`PAYUNI_PERIOD_HASH`／`PAYUNI_PERIOD_HASHES`（`promo:12`）；線上＝`payuniPeriodHashOnline`／`PAYUNI_PERIOD_HASH_ONLINE`／`promo:12:online`（互不回退）。勿用 UPP 收首期。臨櫃一次付清／商品刷卡請改選 **YIPAY（乙禾）**。**約定結果只靠 Notify**（該支付頁不回流 Return）；櫃檯另開分頁＋輪詢 `GET /ops/checkout/:id`（`hasCreditHash`）。商店端亦可另以 `CreditHash` 幕後續扣（排程 `CARD_RECURRING_SCHEDULER`）；課程首期收第1期金額、堂數一次給滿；續扣僅收款（4 期最末期用 `amountFinal`）。手動補跑：`POST /api/ops/card-subscriptions/run-due`。
定期定額週期：本機幕後續扣以天數遞延 `nextChargeAt`（W=+7、M=+30、Y=+365）。**PayUNi 續期頁訂閱（`PERIOD:…`）的「下次扣款」以金流 `DateList`／`period/query` 的 `ExpAuthDT` 為準**（Notify 寫入；列表會再同步），勿用 +30 天估算對齊畫面。請假：`expireDate`／`nextChargeAt` 皆整段 `+days`（PERIOD 請假會暫停 PayUNi）。
單號規則：一般儲值（TIMED）`TYK...`；訂閱制月卡（UNLIMITED）與定期定額（RECURRING）訂單／續扣 `CRS...`。
取消訂閱結算：`:id` 可用訂閱編號 `CRS`，或以訂單號（`CRS`／舊 `TYK`）反查；一次付清／現金月卡（無定期定額）亦可用訂單號做效期結算（KEEP／CUT）。**PayUNi 續期頁訂閱（`PERIOD:…`）取消／暫停／恢復會先對齊金流**：狀態異動打 [`/api/period/mdfStatus`](https://docs.payuni.com.tw/web/#/7/311)（`ReviseTradeStatus`=`end`終止／`suspend`暫停／`restart`啟用；Header `User-Agent: payuni`），再以 `period/query` 確認。未對齊成功回 **409**；緊急可 `forceLocalOnly=true`。查詢／重試：`GET /ops/card-subscriptions/:id/payuni-period`、`POST …/stop-payuni`。
私教取消：`POST /api/ops/cancel-pt-purchase`（`checkoutId` 或 `orderId`；`prefer=void|allowance`）；一般報表列可直接取消沖回／退費折讓。
計時儲值退費（`POST /api/ops/refund`）：`退費金額 = 實付金額 − 實際使用額度 − 手續費$100`（實際使用＝已用本金＋已消耗運動金）。
30 日月卡／訂閱終止退費（CUT_UNUSED）：30 日為一期；未滿十五日＝`已繳金額 ×（剩餘天數／契約總天數）− 手續費$500`；滿／逾十五日以一期計、無法退費。
**ezPay env**：`EZPAY_MERCHANT_ID`、`EZPAY_HASH_KEY`（32）、`EZPAY_HASH_IV`（16）、`EZPAY_INVOICE_URL`。測試=`https://cinv.ezpay.com.tw/Api/invoice_issue`；正式=`https://inv.ezpay.com.tw/Api/invoice_issue`。**金鑰須與環境一致**（測試店配 cinv、正式店配 inv）。字軌不足會使該腿開票失敗並入 `InvoiceIssueJob`（`PARTIAL_INVOICE`），**不沖回已收款**。

合併結帳軟拆：購物車仍一次付款（CHK／PayUNi），ezPay **分腿開票**（SAL／購案／私教各一張，MerchantOrderNo＝子單號）。**開票失敗不沖回已收款**（防漏稅懸空）：失敗腿寫入 `InvoiceIssueJob`（`status=FAILED`）並自動重試，API 回 `code: PARTIAL_INVOICE`；手動補開 `GET/POST /ops/invoice-jobs…/retry`。異動各自作廢／折讓。舊版「整張 CHK 發票」仍禁止在有存活兄弟單時作廢。**退費折讓**（`POST /ops/refund`、CUT_UNUSED、`prefer=allowance`）僅在開票成功（有真實發票號）後生效；未開票不可折讓退費。

櫃檯會員：`GET /api/ops/members?q=&take=&skip=&id=&lite=`（回傳 `{ items, total, take, skip }`；`lite=1` 略過合約板，供 Cmd+K）。櫃檯在場：`GET /api/ops/check-ins/active?branchId=`；補登出場 `POST /api/ops/check-ins/:logId/check-out`（依進場快照計費）；取消進場 `POST /api/ops/cancel-gate`（在場不計費；已出場退費限 DUTY+）。

開發 CORS：`CORS_ORIGIN` 與 `FRONTEND_URL` 會合併；非正式環境另自動加入 localhost:5173／4173，並允許區網／`.local` 的 Vite Origin。被拒時後端 log 會印 `denied origin=…`。

## 擴充模組（系統需求參考）

**CMS**（`/api/cms`）：公告、FAQ、場館介紹、教練公開資料、留言板（`POST /contact` → `STAFF_INBOX` MAIL）。ADMIN 管理同路由 POST/PATCH。

**會員延伸**（`/api/member` + `/api/member/marketing`）：消費／銷課紀錄、課程請假／補課、自助請假／取消訂閱、點數／禮物卡／抽獎／InBody。

**教練延伸**（`/api/trainer/ext`）：課堂 QR 簽到、訓練紀錄、場地預約、Google 日曆連結（OAuth 待接）。

**HQ 行銷**（`/api/hq/marketing`）：沉睡名單、推播活動、推薦價、加價購、家庭卡、禮物卡、抽獎。

**HQ HR**（`/api/hq/hr`）／**員工自助**（`/api/staff/hr`）：打卡、請假、排班。

**HQ 教練拆帳**（`/api/hq/coach`）：抽成規則、績效試算 ledger。

**櫃檯延伸**（`/api/ops` DUTY+）：會員群組、備註、效期調整、扣款黑名單、發票分鐘級查詢、訂閱扣款日／人工 Token、**證件原圖調閱（presign）與清除核准**。

**換卡**：`POST /api/ops/card-subscriptions/:id/rebind`（臨櫃續期 Hash，DUTY+；$1 驗證授權後 `trade_cancel`）／`POST /api/member/subscriptions/:id/rebind`（會員線上 Hash；預設 `$0`）；開 PayUNi bindOnly 頁，Notify 回寫 `CreditHash`；輪詢 `GET …/rebind-status`（`rebindPending`／`creditUpdated`）。人工貼 Token：`PATCH /api/ops/card-subscriptions/:id/credit-hash`。

**證件歸檔（個資）**
- 上傳：`POST /api/member/id-photo`（`side`、`consent=true`）；臨櫃代辦：`POST /api/ops/members/:id/id-photo`（須 `consentSignatureId`，櫃檯 ops）
- 狀態：`GET /api/ops/members/:id/id-photos`（無影像；ops）
- 原圖調閱（DUTY+）：`POST /api/ops/members/:id/id-photos/:side/presign` body `{ reason }` → `{ url, expiresAt, mode }`（R2 Presigned 或 local token）；兌換 `GET /api/ops/id-photo-access/:token`（無 JWT）
- 相容：`GET …/preview?reason=` → 302 至短效 URL
- 保存：會籍結束後 **3 年**；重傳歷史版 **1 年**；排程 purge
- 儲存：`ID_PHOTO_STORAGE=local|r2`；可選 `ID_PHOTO_PRESIGN_TTL_SEC`（180–300，預設 240）、`ID_PHOTO_ACCESS_SECRET`
- R2：`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET_ID_PHOTOS`（或 `R2_BUCKET`）
- 表：`MemberIdPhoto`、`IdPhotoDeleteRequest`、`IdPhotoAccessLog`；禁止 static 公開

**容留顯示開關**：`Branch.showOccupancy`（CMS／HQ 場館內容可改）；公開 `GET /api/board/occupancy-settings?branchId=` 回 `isDisplay`；關閉時 `GET /occupancy` 回 `data: null`，前端不得硬顯示 0。

**會籍自助請假**：`POST /api/member/leave-application`（`startDate`／`endDate`／可選證明圖 multipart 欄位 `proof` 或 JSON `proofImage`）；身分只從 JWT。相容舊路徑 `POST /subscription-leave`（`days`）。證明寫入 `MemberLeave.proofStorageKey`（同證件 local／R2 管線）。

**報表延伸**：`GET /hq/reports/analytics/yoy`、`.../members`、`GET /hq/reports/card-subscriptions/batch`。

**MAIL env**（選填）：`SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`MAIL_FROM`（相容 `EMAIL_FROM`）、`STAFF_INBOX`。Elastic Email 範例：`SMTP_HOST=smtp.elasticemail.com`、`SMTP_PORT=2525`，`MAIL_FROM` 須為已驗證網域。未設 SMTP 時 mock 寫 log。

**LinePay**（選填）：`LINEPAY_CHANNEL_ID`、`LINEPAY_CHANNEL_SECRET`、`LINEPAY_SANDBOX`（預設 true）、可選 `LINEPAY_DEVICE_PROFILE_ID`。

| 通路 | 模式 | 作法 |
|------|------|------|
| 臨櫃一次刷卡 | **乙禾 YIPAY** | `payments` 含 `YIPAY` → PENDING → 端末成功後 `POST /ops/confirm-yipay`（`checkoutId`／`saleId`／`orderId`） |
| 臨櫃月卡／課程定期定額 | **乙禾＋PayUNi 約定** | 首期 `YIPAY`＋`cardMode=RECURRING` → confirm 回 `actionUrl`（`TradeAmt=0` 僅約定）開續期頁；與 `LINEPAY` 互斥 |
| 會員線上刷卡／定期 | **PayUNi CARD** | 續期收款頁或 UPP |
| 臨櫃 `POST /ops/checkout`、`/ops/topup` | **LinePay POS Offline v4** | 掃會員「付款碼／My Code」→ `linePayOneTimeKey`；與 `CARD`／`YIPAY` 互斥；扣款成功即 fulfill／開票 |
| 會員 `POST /member/orders` `payMethod=LINEPAY` | **Online v3** | 回 `paymentUrl` 導向付款；Confirm／Cancel：`/api/ops/linepay/confirm|cancel?client=member` |

沙盒產生測試 My Code：`https://sandbox-web-pay.line.me/web/sandbox/payment/oneTimeKey?countryCode=TW`（不可用真實 App 碼）。未設 Channel 時選 LinePay 會回 500。

**團課 CRM**：`GET /api/hq/reports/group-class-crm?from=&to=&branchId=`（到課率／請假率／補課／續課代理）。

**尚未接入**：Google Calendar OAuth 雙向同步、推播 APNs/FCM（目前 LINE／MAIL mock）。

教練排休：`TrainerTimeOff`；教練服務台「排休」分頁；`GET/POST/PATCH/DELETE /api/trainer/time-offs`；團課／私教排課重疊則 409；會員 `GET /api/member/trainers/:trainerId/time-offs`（需有該教練進行中私教合約）。

諮詢客人：`ConsultGuest`（姓名＋電話）；`POST /api/trainer/schedule-consult` 自選日期／時間開 CONSULT 代約（無需選課程、無需私教合約）；亦可 `POST /api/trainer/book-consult` 對既有 CONSULT 堂代約。私教代約：`POST /api/trainer/schedule-private`（`contractId`＋場地＋時段，扣堂）。課表改期：`PATCH /api/trainer/classes/:id/reschedule`（時間／場地；不重扣堂；教練／場地防衝堂 409）。會員 LINE 約課：`GET /api/member/classes`、`POST /api/member/book-class`、`GET /api/member/reservations`、`POST /api/member/reservations/:id/cancel`（前端 `/member/book`）。

閘機業務錯誤可附 `memberId`／`code`（如 `EXPIRED_BALANCE`、`BALANCE_INSUFFICIENT`），供櫃檯續約深連；前端仍禁自傳 `memberId` 進場。

LINE OAuth：`/api/auth/line/callback` 302 回前端時改帶一次性 `auth_code`（短效、單次可用），前端再呼叫 `POST /api/auth/exchange-auth-code` 換 JWT。

分店發票抬頭：`invoiceSellerName`／`invoiceSellerUbn`（統編選填；有填須通過財政部檢查碼：權重 1,2,1,2,1,2,4,1，總和被 5 整除；空白＝清除／用環境變數預設）。

員工／教練：`name`＝真實姓名（總部／交接班）；`displayName`＝對外顯示（預設「匿名」）。會員約課／LINE／員工側欄用顯示名稱。

分店代碼：`Branch.code`（建立必填、唯一）；員工／櫃檯／報表關聯顯示代碼；會員介面／LINE／發票一律用 `Branch.name`。

守則：`backend/.cursorrules`
