# 體育客 (GymSaaS) Backend API

純後端 API（前後端絕對分離）。**不託管 UI**（無 `public/`、無 HTML）。

## 啟動

```bash
npm run setup  # generate + db push + db:constraints + seed（schema／閘機約束變更後務必執行）
npm run dev
npm run doctor # prisma validate → eslint → node --check
npm test       # 重建本機 <db>_test → node:test 單元＋整合測試（不碰開發庫）
npm run test:unit # 只跑純函式單元測試（免 DB）
```

測試庫：預設取 `DATABASE_URL` 之庫名加 `_test`（如 `gymsaas_test`），每次 `npm test` 會 DROP／CREATE 後 `prisma db push`＋`db:constraints`；只允許 localhost，可用 `TEST_DATABASE_URL` 指定（庫名須以 `_test` 結尾）。需本機 PostgreSQL 帳號具建庫權限。

健康檢查：`GET /api/health`（JSON）。`GET /` 亦回 JSON。

Neon 額度：定期定額排程預設每 60 秒查 DB，會讓 Neon compute 無法休眠。**本機開發請在 `.env` 設 `CARD_RECURRING_SCHEDULER=false`**（正式環境勿設；需要時可 `POST /api/ops/card-subscriptions/run-due` 手動補跑）。Prisma 指令一律在 `backend/` 內執行（`npm run db:*`），勿在根目錄 `npx prisma`（會抓到非專案版本）。

PayUNi：`ReturnURL`＝瀏覽器回流（優先 `FRONTEND_URL/api/ops/payuni/return`，回 HTML 自動跳轉櫃檯）；`NotifyURL`＝背景入帳（`API_PUBLIC_URL/api/ops/payuni/webhook`，須公網）。兩者可同網域（ngrok→Vite 且 proxy `/api`）。`localhost` 不能當 Notify。商店後台「串接設定」也建議填相同 Return／Notify。缺 Notify 不會擋跳回，只會讓訂單晚入帳／不入帳。

**續期收款例外**：PayUNi 定期定額支付頁成功後**不會**打 ReturnURL（畫面只有買家專區連結）。櫃檯改為另開金流分頁，入帳只認 Notify；前端以 `GET /api/ops/checkout/:id`（`:id`＝`CHK…` 或訂單號）輪詢至 `PAID`。續期 Notify 常無 `TradeStatus`、且 `MerTradeNo` 為 PayUNi 自編：後端以 `Status=SUCCESS`＋`ResCode=00`／`AuthAmt` 判定成功，並以 `ProdDesc` 前置本系統單號（或近期同額 PENDING RECURRING）對應入帳。

資安基線：正式環境必填 `CORS_ORIGIN`（可逗號分隔多個前端來源）；`OTP_DEV_REVEAL` 僅限非正式環境揭示 **LOGIN／REGISTER** Email OTP；正式環境與換機碼一律不回傳／不記錄 OTP 明碼。

會員自助登入／註冊：主流程 `POST /api/onboarding/lookup` 帶 **`phone`＋`idNumber`** 辨識新舊；未綁 Email → 補登／新客先驗證 Email（`otp/send|verify` 或 `email-enroll/*`）；未完成註冊一律續走註冊（契約→證件→選用綁 LINE→裝置）。相容舊客戶端 `identity`（手機或 Email）。`POST /onboarding/register` 必填 `phone`＋`idNumber`（身分證／居留證／護照／國籍證件）。LINE 一鍵登入僅限已綁定者；新客不可用 LINE 起註冊。臨櫃開卡同理必填手機與證件。換機：身分＋Email OTP（不依賴 SMS）。

換機（禁僅靠 Email）：`POST /api/auth/device-reset/request-email`（`identity`＝證件或註冊手機＋`email`，可選 `resetTicket`）→ 相符才寄信；`POST /api/auth/device-reset/verify-email`（OTP＋同核身）通過後才改綁並遞增 `deviceAuthVersion`；未簽 `NEW_MEMBER` 回 403。**自助換機頻率熔斷**：預設 **24 小時內 1 次**、**近 30 日最多 2 次**實際改綁（`DEVICE_RESET_COOLDOWN_HOURS`／`DEVICE_RESET_MONTHLY_MAX`）；超限 **429 `DEVICE_RESET_RATE_LIMITED`**，須櫃檯 DUTY+。限流：IP＋目標。備援：`POST /api/ops/members/:id/reset-device`（DUTY+，不計入自助上限）。SMTP：`SMTP_HOST`／`SMTP_USER`／`SMTP_PASS`／`MAIL_FROM`（未設則 mock，body 仍 redact）。

閘機防潛回（Anti-passback）：進場時若已有 `checkOutAt=null` 且 `status=ACTIVE` 的在場紀錄 → **403 `ANTI_PASSBACK`**，禁止再次刷開進場閘（防遞碼／尾隨後二次刷入）。進／出場交易對 `Member`（出場另對 ACTIVE `CheckInLog`）做 **`SELECT … FOR UPDATE`**；DB partial unique `uniq_active_member_checkin` + 錢包 `CHECK (>=0)`（`npm run db:constraints`，含於 `setup`）。出場雙錢包經 `lib/walletMutation.js` 先扣運動金再扣本金，禁止負餘額，實扣拆分記於 `CheckInLog.deductedBonus`／`deductedCash`；餘額不足則**不扣款、仍在場**，差額記入 **`CheckInLog.shortfallAmt`**，回 **`gateOpen=false`**＋`settled=false`＋`feeDetails.shortfall` 並推播 `EXIT_SHORTFALL`，會員儲值後再刷出一次全額扣款。錢包每次異動寫 `WalletLedger`（兩錢包前／變動／後＋原因＋經辦）；`npm run wallet:audit` 檢查流水連續與期末餘額（異常 exit 1）。出場若查無 `ACTIVE` 在場紀錄 → **409 `NO_ACTIVE_CHECKIN`**（拒開門）並經 **`/ws/gate-alert`** 推播櫃檯「異常滯留」。未簽入會契約 → **403 `CONTRACT_REQUIRED`**（禁 `qrToken`／禁進場）。計時餘額門檻 **$50**。閘機 `GET /gate/sync-time`（QR 容許 ±5s）；DAV 短 TTL 快取（改綁須驅除）。

乙禾暫存／發票佇列：端末成功 → `POST /ops/yipay/captures`；日結 `GET /ops/yipay/reconcile?branchId=&edcCount=&edcAmount=`（系統 YIPAY 認列 vs EDC 結算單）。開票紀錄 `EInvoice`（佇列＝FAILED 列）；失敗可 `POST /ops/invoice-jobs/:id/retry`。櫃檯 UI：交接班「刷卡機日結核對」＋頂部發票 FAILED 橫條（顯示開立營業人）。


進銷存（總部 `/api/hq`，ADMIN，`routes/hqInventory.js`）：營業人 `GET/POST /legal-entities`、`PATCH /legal-entities/:id`；商品主檔 `GET/POST /products`、`PATCH /products/:id`；分店上架／售價／安全庫存 `GET/PUT /branch-stocks`；`GET /stock-movements`、`POST /stock-transfers`（同營業人）；供應商 `GET/POST /suppliers`、`PATCH /suppliers/:id`；採購單 `GET/POST /purchase-orders`、`GET/PATCH /purchase-orders/:id`（僅草稿）、`POST /purchase-orders/:id/{order|cancel|close}`；驗收 `GET/POST /purchase-receipts`（可無採購單、可覆寫進價）、`PATCH /purchase-receipts/:id/supplier-invoice`；應付 `GET /payables`、`GET /payables/aging`、`POST /payables/:id/void`；付款 `GET/POST /supplier-payments`（`allocations` 合計＝金額）；發票 `GET /einvoices`、`POST /einvoices/:id/retry`；ezPay 呼叫紀錄 `GET /einvoices/:id/logs`（單張全部嘗試）、`GET /einvoice-logs?result=&action=&legalEntityId=&from=&to=`（預設僅失敗）。
門市（`/api/ops/inventory`，DUTY+，限可操作分店）：`GET /stocks`、`POST /stock-adjustments`（LOSS／GAIN／COUNT＋原因）、`GET /stock-movements`、`GET /purchase-orders`（待驗收）、`GET/POST /receipts`（必帶 `purchaseOrderId`，明細僅 `poItemId`／`productId`／`qty`）、`POST /transfers`。
DB 約束：`npm run db:constraints` 同時套用 `sql/inventory_invoice.sql`（庫存非負、發票金額勾稽／同腿唯一、採購數量、應付範圍）。舊版資料（分店商品／分店發票欄位）遷移腳本 `prisma/migrateInventoryInvoice.js`：須在新增欄位、尚未刪舊欄位之過渡 schema 下執行（可重跑），完成後才可推送現行 schema（會刪舊欄位，屬破壞性）。

櫃檯合併結帳 `POST /api/ops/checkout`（CASH／**YIPAY 乙禾現場刷卡**／CARD＝PayUNi 僅定期定額／LINEPAY／WALLET_CASH／VOUCHER）；獨立 POS `POST /api/ops/pos/checkout` 同付款碼（臨櫃一次刷卡請用 YIPAY，端末後 `POST /api/ops/confirm-yipay`）。服務類商品 `productKind=SERVICE` 不控庫存；`GET /ops/products` 須回傳 `productKind`。

交接班：早／晚（`MIDDAY` 僅歷史）；未開班時 `POST /ops/checkout`、`/ops/pos/checkout`、`/ops/topup` 回 409 `SHIFT_NOT_OPEN`（交班與收款以列鎖互斥）；交班彙整含合併結帳、單獨 POS 銷貨與單獨臨櫃儲值，上一班交班後才完成付款（乙禾確認／刷卡回呼）者計入下一班；底金＝上一班實點；超商式流程（盲點面額點鈔→對帳→檢核清單→簽核）；支付分欄；操作人員紀錄；差額僅店長／總部；可列印結算單。

報表：`GET /api/hq/reports/{orders|topup|gate|sales|course-purchases|trainer|analytics}`；課程購買報表展開 `CheckoutSession.ptItems`（含獨立私教 Order）。

門市發票對帳（ADMIN，交付會計師）：`GET /api/hq/reports/sales-reconciliation?from=2026-09-01&to=2026-10-31&branchId=1&includeCancelled=0`。`from`／`to` 必填（台灣日，最長 366 日），`branchId` 省略＝全部門市。回傳：
- `invoices`：門市**全部發票**（商品 SAL、會籍／儲值 TYK、月卡／定期定額 CRS、私教、團課 GRP、舊制合併 CHK），依開立日期；含本期作廢（作廢日期）、開立失敗／待開立。欄位含來源類別／單號、開立方式（統編／手機條碼／自然人憑證／捐贈／紙本）、銷售額、稅額、總計、已折讓。
- `invoiceItems`：發票品項（未稅／稅額依整張發票分攤）。
- `allowances`：本期折讓單（原發票號、折讓未稅／稅額／總額）。
- `rows`：商品銷貨明細（依銷貨日期，品名、數量、未稅、稅額、總額、發票號碼）。
- `summary.invoices`：有效發票（應稅／免稅、依來源）、本期作廢、待開立、折讓、淨額。

前端 HQ「進銷存 → 發票對帳」可選發票期別（雙月），匯出 Excel（摘要／發票清冊／發票品項／折讓單／商品銷貨明細）或單一分頁 CSV。

應付帳款：每張驗收入庫單（`POST /api/hq/purchase-receipts` 或門市依採購單驗收）在同一交易內自動立一筆 `SupplierPayable`（`APY…`，金額＝驗收含稅總額、到期日依供應商付款條件）；分批到貨每批各一筆，採購單到齊才轉 `RECEIVED`。
銷售分析（`/hq/reports/analytics`）：必有日期區間（缺省近 30 日、最長 366 日）；概覽用 DB aggregate，明細類仍限該區間。
一般儲值報表（`/hq/reports/topup`）回傳 `planName`（由訂單快照 `itemDesc` 解析）供前端顯示「方案」欄。
櫃檯會員：`GET /api/ops/members?q=&take=&skip=&id=&lite=` 分頁搜尋（`lite=1` 略過契約板，供 Cmd+K）。

教練分店：`POST /api/hq/trainers/assign` — 一般教練（NORMAL）綁定指定分店（可多間）；主管教練（MANAGER）不限分店（`branchIds` 可空）；可選 `level`（`GOLD`／`SILVER`）。

分店（`POST/PATCH /api/hq/branches`）：可帶 `type`（`GYM`／`CLASS`／`ACADEMY`，預設 GYM）與 `parentId`；`CLASS` 必須隸屬 GYM（僅一層）。`GET /api/hq/branches` 回傳 `parent` 與 `_count.children`。有啟用中隸屬分店不可停用／刪除。套用 schema：`npm run db:push`。

員工職位（`/api/hq/staff` 的 `role`）：`ADMIN` 總公司、`GM` 店務部主管、`FM` 教練部主管（三者免綁分店、可跨店）、`STORE_MANAGER` 店長（舊值 `MANAGER` 相容）、`DUTY` 值班、`STAFF` 一般場務、`TRAINER` 教練（後四者須 `branchId`）。職位須符合分店類型（店長僅 GYM；場務不可綁 ACADEMY；員工不可綁 CLASS）。GYM 員工登入後可操作其隸屬 CLASS（JWT `branchIds`）。種子分店依組織圖：`HP` 和平店、`HR` 熱河教室（隸屬 HP）、`AC` 體適能學院、`FD` 輔大店（含統編；舊 `FJU`／`ACADEMY` 代碼由 seed 自動改名）。種子帳號：`gm`／`fm`／`hp_mgr`／`fd_mgr`／`fd_duty`／`fd_staff`／`ac_coach`（密碼 `staff1234`；舊 `fju_*` 由 seed 自動改名）。

團課付費期班（`lib/groupClassRules.js`／`lib/groupClassService.js`）：
- 開班 `POST /api/pt/schedule-group-class` Body：`coursePlanId`（上架中 GROUP 方案）、`venueId`、`trainerId`、`startDate`／`endDate`／`weekdays`／`startTime`／`endTime`，選填 `title`（預設方案名）、`capacity`（預設方案）、`stationId`、`enrollDeadline`（預設開課前 2 日）；展開堂數須等於方案 `sessions`。GROUP 方案（`/api/hq/course-plans`）另有 `dropInPrice`（單堂價，null＝不開放）、`minEnrollment`。
- 總部 `GET /api/pt/group-series?includeEnded=1`（報名統計、`belowMinimum`／`needsDecision`）、`GET /api/pt/group-series/:id/roster`、`POST /api/pt/group-series/:id/cancel { reason }`（ADMIN；已報名者未履約全退）。
- 會員 `/api/member/group`：`GET /series?branchId=`、`GET /series/:id`、`GET /me`；`POST /enroll { seriesId, kind: TERM|DROP_IN, classId?, payMethod: CARD|LINEPAY, carrierNum?, buyerUbn?, loveCode? }` → PayUNi `actionUrl`＋`payload` 或 LINE Pay `paymentUrl`（保留 30 分）；`POST /waitlist { seriesId }`、`POST /waitlist/:id/cancel`；`POST /reservations/:id/leave`（≥24h 取得補課權）；`GET /makeup-credits/:id/options`、`POST /makeup { creditId, classId }`。付款回流 `FRONTEND_PAY_RETURN_PATH?pay=done|cancelled&kind=group`。
- 櫃檯 `/api/ops/group`：`GET /sellable?branchId=&memberId=`、`GET /series/:id?memberId=`、`GET /members/:memberId`、`POST /waitlist { memberId, seriesId }`；`GET /enrollments/:id/refund-preview`、`POST /enrollments/:id/refund { reason }`（DUTY+）。POS `POST /api/ops/checkout` 可帶 `groupItems: [{ seriesId, kind, classId? }]`（需 `memberId`、不可錢包、獨立 `GROUP` 發票腿，回 `groupEnrollmentIds`）。
- 排程 env：`GROUP_CLASS_TICK_MS`（預設 60000；保留逾時、遞補逾時、補課權過期）。

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
交易取消／退費／折讓（`routes/opsRefunds.js`，DUTY+，`reason` 必填，金額一律後端反算）：
- 查單 `GET /api/ops/refund-lookup?orderId=|invoiceNumber=`（CHK／SAL／訂單號或發票號 → 子單清單、可用動作、未結案退費單、折讓單）。
- 計時儲值方案不可用零錢包付款：`POST /api/ops/topup`、`/api/ops/checkout` 帶 `WALLET_CASH` 回 400 `TOPUP_NO_WALLET`（無限使用方案、商品、私教不受影響）。
- 待付款作廢（DUTY+）：`POST /api/ops/pending-payments/:id/cancel { reason, checked: true }`，`:id`＝`CHK…`／`SAL…`／儲值單號（PENDING 才可）；回 `{ id, kind, walletRestored, memberWallet }`。端末已有刷卡暫存 409 `YIPAY_CAPTURED`、未勾確認 409 `PAYMENT_CHECK_REQUIRED`、合併結帳子單 409 `USE_CHECKOUT_CANCEL`。
- 計時儲值原單取消：`GET /api/ops/topups/:id/cancel-preview`、`POST /api/ops/topups/:id/cancel { quoteToken, reason, buyerEmail? }`。錢包須仍留有完整入帳本金＋贈送運動金，否則 409 `WALLET_INSUFFICIENT_FOR_VOID`（改用子單退費 `UNUSED`）。
- 子單退費：`GET /api/ops/sub-orders/:subOrderId/refund-preview?scope=&items=[{"orderItemId":1,"qty":1}]`、`POST /api/ops/sub-orders/:subOrderId/refund { quoteToken, scope: FULL|UNUSED|ITEMS, items?, reason, buyerEmail? }`。SAL 支援 `FULL`／`ITEMS`（退貨回補庫存）；會籍／私教 `FULL`（未使用）或 `UNUSED`（實付 − 已用 − `min(未履約×20%, 5000)`，7 日內未使用免手續費）；計時儲值 `UNUSED`（實付 − 已用本金 − 已消耗運動金 − 手續費，不倒貼）。
- 退費單：`GET /api/ops/refunds?status=OPEN|…`、`GET /api/ops/refunds/:id`、`POST …/retry { checked? }`、`POST …/retry-gateway { confirmGatewayNotRefunded?, checked?, retryNote? }`（同一檢查點；短交易 `FOR UPDATE NOWAIT` 認領為 `GATEWAY_RETRYING`，已退成之線上腿不再打金流，回 `reconciledAction`／`stepSummary`／`refundOrder`；同時重試 409 `REFUND_RETRY_IN_PROGRESS`）、`POST …/payments/:paymentId/yipay-confirm { rrn, authCode, cardLast4, terminalRef? }`、`POST …/payments/:paymentId/cash-fallback { reason, confirmGatewayNotRefunded? }`、`POST …/invoice-resolve { einvoiceId, outcome: 'ISSUED'|'NOT_ISSUED', ezPayAllowanceNo?, allowanceNo?, confirmEzPayNotIssued?, reason }`（ezPay 折讓結果不明時，核對藍新後台後補登折讓號或確認未開立；待核對資訊見退費單 `invoiceResolve`，此期間重試與中止皆 409 `INVOICE_RESULT_UNKNOWN`）、`POST …/abort { reason }`、`POST …/signature-preview`（無 body；回後端組好之折讓明細／稅額／錢包扣回＋`requestId`、`previewToken`〔10 分鐘〕供客顯）、`POST …/signature`（`multipart/form-data`：`signature`＝PNG 檔、`previewToken`、`requestId`；token 失效 400 `PREVIEW_TOKEN_INVALID`／409 `PREVIEW_EXPIRED`、預覽後資料變動 409 `PREVIEW_STALE`、空白簽名 400 `SIGNATURE_REQUIRED`）。狀態：`PAYMENT_PENDING`／`AWAITING_TERMINAL`／`PAYMENT_FAILED` → `INVOICE_PENDING`／`INVOICE_FAILED`（回 `PARTIAL_INVOICE`）→ `SIGNATURE_PENDING`（僅 B2B 折讓）→ `COMPLETED`；或 `ABORTED`。折價券份額一律註銷（`FORFEITED`）不折現；現金退款計入本班交班「班內現金退款」。乙禾腿 `payments[].original` 回原刷卡 RRN／授權碼／末四碼／金額供核對。查單之子單 `invoices[]` 含 `status`、`allowanceTotal`、`issuedAt`。
- 折讓單：`GET /api/ops/allowances?from=&to=&branchId=&allowanceNo=&invoiceNumber=&member=&subOrderId=&refundId=&source=&q=&take=`（`{ items, columns, rows }`，含 `printCount`／`exportedToAcctAt`）、`POST /api/ops/allowances/export`（body：`from`、`to` 必填＋同列表篩選＋`exportState`＋`markExported`；回 `{ items, columns, rows, exported: { total, firstTime, exportedAt, truncated, marked } }`，僅 `markExported: true` 時首次匯出者標記 `exportedToAcctAt`）、`GET /api/ops/allowances/:id/print-payload?purpose=print|display`（`:id`＝折讓單 id 或折讓號；`print` 計列印次數，回 `print: { count, isReprint }`，前端排 A4 四聯／80mm 熱感）。
- 退費建單（`POST /api/ops/topups/:id/cancel`、`POST /api/ops/sub-orders/:subOrderId/refund`）須帶 Header `Idempotency-Key`（16～64 字英數／`-`／`_`）；同鍵重送回原退費單（`data.replayed=true`）。body 須帶試算回傳之 `quoteToken`（10 分鐘）；送出時後端重算，與試算不符 409 `QUOTE_STALE`、逾時 409 `QUOTE_EXPIRED`、缺少／偽造 400 `QUOTE_TOKEN_REQUIRED`／`QUOTE_TOKEN_INVALID`，皆不寫入任何資料，請重新試算。
- 舊端點 `POST /ops/refund`、`/ops/cancel-sale`、`/ops/cancel-pt-purchase`、`GET /ops/allowances/:allowanceNo` 已回 410。
- PayUNi 退款 env：`PAYUNI_TRADE_CLOSE_URL`（預設 `{API_BASE}/api/trade/close`）、`PAYUNI_PARTIAL_REFUND`（預設 `true`；**部分退款規格尚未經 PayUNi 測試環境驗證**，上線前未驗證請設 `false`，部分退之 PayUNi 腿會失敗並可改臨櫃現金）。
- Schema 變更後執行順序：`npm run db:push` → `npm run db:constraints`（退費單唯一、金額 CHECK、流水／稽核 append-only trigger）→ `npm run db:migrate-refunds -- --dry-run` → `npm run db:migrate-refunds`（回填舊儲值單入帳快照、私教合約 `orderId`）。
30 日月卡／訂閱終止退費（CUT_UNUSED）：30 日為一期；未滿十五日＝`已繳金額 ×（剩餘天數／契約總天數）− 手續費$500`；滿／逾十五日以一期計、無法退費。
**ezPay env（多營業人）**：每個營業人（`LegalEntity.code`，如 `HP`）一組 `EZPAY_{CODE}_HASH_KEY`（32）、`EZPAY_{CODE}_HASH_IV`（16），選填 `EZPAY_{CODE}_MERCHANT_ID`（覆寫 DB 之 MerchantID）、`EZPAY_{CODE}_INVOICE_URL`；營業人 MerchantID 等於舊 `EZPAY_MERCHANT_ID` 時沿用 `EZPAY_HASH_KEY`／`EZPAY_HASH_IV`／`EZPAY_INVOICE_URL`。金鑰**只放 env**（DB／API 只見 `configured`／`missing`）。測試=`https://cinv.ezpay.com.tw/Api/invoice_issue`；正式=`https://inv.ezpay.com.tw/Api/invoice_issue`。**金鑰須與環境一致**（測試店配 cinv、正式店配 inv）。發票由**提供服務分店**所屬營業人開立；分店未綁營業人或缺金鑰 → 該腿 FAILED（`PARTIAL_INVOICE`），**不沖回已收款**。

合併結帳軟拆：購物車仍一次付款（CHK／PayUNi），ezPay **分腿開票**（SAL／購案／私教／團課各一張，MerchantOrderNo＝子單號；同腿不同課稅別再分張）。**開票失敗不沖回已收款**（防漏稅懸空）：失敗腿 `EInvoice.status=FAILED` 並自動重試，API 回 `code: PARTIAL_INVOICE`；手動補開 `GET/POST /ops/invoice-jobs…/retry`。重試前先以 ezPay `invoice_search` 查自訂編號，已開過就直接補登號碼與隨機碼（不重開）；參數錯誤類（如 `INV10003`）與 CheckCode 不符不自動重試，修正後手動補開。每次 ezPay 呼叫寫 `EInvoiceLog`（不含金鑰），新增表後須 `npm run db:push`。異動各自作廢／折讓。舊版「整張 CHK 發票」仍禁止在有存活兄弟單時作廢。**退費折讓**（子單退費、儲值原單取消、CUT_UNUSED）僅在開票成功（有真實發票號）後生效；未開票僅全額退可取消發票，部分退回 409 `INVOICE_NOT_ISSUED`。

櫃檯會員：`GET /api/ops/members?q=&take=&skip=&id=&lite=`（回傳 `{ items, total, take, skip }`；`lite=1` 略過合約板，供 Cmd+K）。櫃檯在場：`GET /api/ops/check-ins/active?branchId=`；補登出場 `POST /api/ops/check-ins/:logId/check-out`（依進場快照計費）；取消進場 `POST /api/ops/cancel-gate`（在場不計費；已出場退費限 DUTY+）。

開發 CORS：`CORS_ORIGIN` 與 `FRONTEND_URL` 會合併；非正式環境另自動加入 localhost:5173／4173，並允許區網／`.local` 的 Vite Origin。被拒時後端 log 會印 `denied origin=…`。

## 擴充模組（系統需求參考）

**CMS**（`/api/cms`）：公告、FAQ、場館介紹、教練公開資料、留言板（`POST /contact` → `STAFF_INBOX` MAIL）。ADMIN 管理同路由 POST/PATCH。

**會員延伸**（`/api/member` + `/api/member/marketing`）：消費／銷課紀錄、課程請假／補課、自助請假／取消訂閱、點數／禮物卡／抽獎／InBody。

**教練延伸**（`/api/trainer/ext`）：課堂 QR 簽到、訓練紀錄、場地預約、Google 日曆連結（OAuth 待接）。

**HQ 行銷**（`/api/hq/marketing`）：沉睡名單、推播活動、推薦價、加價購、家庭卡、禮物卡、抽獎。

**HQ HR**（`/api/hq/hr`）／**員工自助**（`/api/staff/hr`）：考勤（比對班表）、打卡、請假審核、國定假日、排班、工資核算匯出；薪資系統 `/api/hq/payroll`（員工薪資單 `/api/staff/hr/payslips`）；員工通知與 LINE 推播 `/api/staff/notifications`。

**HQ 教練業績**（`/api/hq/coach`，ADMIN；`lib/coachPerformance.js`）：教練為受僱員工，底薪一律於薪資設定，此處僅業績獎金。
- `GET /commission-rules?trainerId=`（生效規則）、`PUT /commission-rules` `{ trainerId|null, courseKind: PRIVATE|GROUP, tierRates?[{minRevenue, rate}], sessionBonus?, perHeadRate? }`（同教練同課型取代舊規則；null＝全體預設）、`DELETE /commission-rules/:id`（停用）。含 `baseSalary` 400 `BASE_SALARY_IN_PAYROLL`；`hourlyRate`／`deductRates`／`payModel=HOURLY` 400 `NON_EMPLOYMENT_TERMS`
- `GET /performance?month=YYYY-MM` → `{ month, items[{ trainerId, staff, basePay, performance, flags[NOT_EMPLOYED|NO_PAY_PROFILE|COACH_BASE_PAY|NO_LABOR_INS] }] }`；教練本人 `GET /api/trainer/performance?month=`
- 計算：私教＝當月已結束且有到課之私教堂 × 合約單堂價（`pricePaid ÷ totalSessions`，依 `Class.ptContractId`），階梯達標全額適用；授課獎金＝每執行堂固定額；團課人頭＝到課人次 × 單價。舊 `commission-ledger` 端點已移除

**週班表：轉正教練＋店長／GM／FM**（勞基法 §30／§35／§36／§34；`lib/coachSchedule.js`、`lib/coachScheduleService.js`；ADMIN 免排班）
- 本人（非實習 TRAINER／STORE_MANAGER／GM／FM，否則 403 `COACH_PLAN_NOT_ALLOWED`；路徑 `week-plans`，舊 `coach-plans` 為別名）：`GET /api/staff/hr/week-plans` → `{ rules, statuses, planRole: COACH|MANAGER, planRoleLabel, approverLabel, today, staff, branches, defaultBranchId, allowNoBranch, weeks[本週起 8 週] }`；`PUT /api/staff/hr/week-plans/:weekStart`（週一）`{ regularOffDate, restDayDate, slots[{date, start: HH:mm, end: HH:mm, branchId?}], note? }` 存草稿並回 `evaluation`；`POST …/:weekStart/submit`（有違規 409 `COACH_PLAN_INVALID`，`data.issues`）、`POST …/:weekStart/withdraw`。送審中／已核准改動 409 `COACH_PLAN_LOCKED`，改已過日期 409 `COACH_PLAN_PAST`
- 審核（教練 → FM 或該分店店長，ADMIN 可代審；店長／GM／FM → 僅 ADMIN；GM 無審核權、不得審本人 → 403 `WEEK_PLAN_REVIEW_FORBIDDEN`）：`GET /api/staff/week-plans?status=SUBMITTED|APPROVED|REJECTED|ALL&kind=COACH|MANAGER&branchId=&from=` → `{ kinds, items[含 planRole、staffRole、canReview] }`、`POST /api/staff/week-plans/:id/approve`、`/reject { reason }`、`/reopen { reason }`（撤回核准回草稿）。審核端點受值勤海關管制（ADMIN 除外）
- 送審通知：教練 → 該店（CLASS 取上層 GYM）店長＋全部 FM；店長／GM／FM → 總公司 ADMIN
- 僅核准週班表生效；可預約＝已核准出勤 − 已核准請假 − 不開放預約時段，所有開課／約課／改期不符回 409 `COACH_NOT_EMPLOYED`／`OUTSIDE_WORK_SCHEDULE`／`COACH_ON_LEAVE`／`COACH_UNAVAILABLE`
- 新表 `CoachWeekPlan`、`StaffSchedule.coachPlanId`、`CoachCommissionRule.sessionBonus`、`Class.ptContractId`，更新後須 `npm run db:push`；種子教練未綁員工帳號者不可排課

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

**員工照片（頭像／人臉辨識）**（ADMIN）
- `GET /api/hq/staff/:id/photo` → `{ dataUrl, photoUpdatedAt }`（縮圖）；本人 `GET /api/admin/me/photo`
- 電子同意書：`GET /api/hq/staff-consent/biometrics`（條文＋`bodyHash`）；`GET /api/hq/staff/:id/face-consent`（有效簽署含簽名影像）；`POST /api/hq/staff/:id/face-consent` body `{ signatureData: PNG dataURL, bodyHash }`（員工親簽；條文過期 409 `CONSENT_VERSION_CHANGED`）
- `POST /api/hq/staff/:id/photo` body `{ image: dataURL, enrollFace: boolean }`；`enrollFace=true` 須已有有效簽署（否則 403 `FACE_CONSENT_REQUIRED`），同步註冊 Face8 員工群組
- `DELETE /api/hq/staff/:id/photo`（連同人臉，同意書保留）、`DELETE /api/hq/staff/:id/face`（撤回同意：簽署標記撤回＋刪人臉，保留頭像）
- 儲存沿用 `ID_PHOTO_STORAGE`（前綴 `staff-photos/`）；env `PAPAGO_STAFF_GROUP_ID`（預設 `gymsaas-staff`）、`PAPAGO_REMOVE_PATH`（預設 `/face/delete`）
- 新增 `Staff` 欄位與 `StaffConsentSignature` 表，更新後須 `npm run db:push`

**員工勞動條件與假勤**（ADMIN）
- `POST/PATCH /api/hq/staff` 另收 `employmentType`（FULL_TIME｜PART_TIME｜INTERN）、`hireDate`（YYYY-MM-DD，新增必填）、`weeklyHours`（兼職必填 <40）、`laborActApplies`（實習無勞雇關係填 false；教練一律適用勞基法，填 false 回 400）
- `GET /api/hq/staff` 每筆附 `leaveBalance`：`seniority`、`annualLeave`（週年制年度、`entitledHours`／`usedHours`、`unit` DAY／HOUR）、`nationalHoliday`（`entitledDays`／`usedDays`；兼職 `entitledDays=null`）
- 考勤（`lib/attendanceService.js`）：`GET /api/hq/hr/attendance?from=&to=&branchId=&staffId=&flag=` → `{ summary, rows[], absences[], byStaff[] }`（台北日期，預設近 7 日、最長 62 日）；每筆打卡優先歸屬打卡時綁定之班次（`scheduleId`；同班次多段僅首段判遲到、末段判早退），舊紀錄與已生效班表（已發布四週排班／已核准週班表／臨時排班）就近配對，旗標 `LATE`／`EARLY_LEAVE`（寬限 5 分）、`MISSED_PUNCH_OUT`（逾 16 小時未下班）、`OPEN`、`UNSCHEDULED`、`CORRECTED`、`BACKFILLED`；`absences`＝已結束班次無打卡且無核准請假（`flag=ABSENT` 只看曠職）。補登 `POST /api/hq/hr/attendance` `{ staffId, punchIn, punchOut?, branchId?, scheduleId?, reason }`（`scheduleId` 須為該員工已生效班次，否則 400 `SCHEDULE_INVALID`）、更正 `PATCH /api/hq/hr/attendance/:id` `{ punchIn?, punchOut?, reason }`：原因必填（400 `REASON_REQUIRED`）、≤16h、不得晚於現在、不得與既有打卡重疊（409 `ATTENDANCE_OVERLAP`）
- 班表值勤判定：`POST /api/admin/login` 回傳 `data.duty`；`GET /api/staff/hr/duty-status` → `{ exempt, onDuty, state, message, shift, nextShift, open, canPunchIn, canPunchOut, leave, earlyMinutes }`，`state`＝`EXEMPT`（ADMIN）／`CLOCKED_IN`／`IN_WINDOW`（班次開始前 30 分～結束，未打卡）／`ON_LEAVE`／`BRANCH_SCOPE`（班次分店不在登入權限，需重新登入）／`OFF_SHIFT`。非值勤員工呼叫業務 API（`/api/ops`、`/api/pt`、`/api/trainer`、`/api/staff/roster`、`/api/hq/reports` 等）一律 403 `OFF_DUTY`（`data.duty`）；可用 `/api/admin/me`、`/api/staff/hr/*`、`/api/staff/notifications/*`。店長／FM／GM 亦須班表（本人提報週班表、ADMIN 核准），僅 ADMIN 免判定
- 員工自助打卡：`POST /api/staff/hr/punch-in`（非 ADMIN 須在值勤窗內：綁定班次 `scheduleId` 與班次分店；班外 409 `NOT_ON_DUTY`（`data.nextShift`）、請假中 409 `ON_LEAVE`、分店不符 409 `BRANCH_NOT_SCHEDULED`；已上班 409 `ALREADY_PUNCHED_IN`；逾 16 小時之舊卡自動標記未打下班卡並回 `staleClosedId`；回應含 `shift`、`duty`）、`POST /api/staff/hr/punch-out`（不限值勤窗；無上班卡 409 `NOT_PUNCHED_IN`；舊卡逾 16 小時 409 `OPEN_SHIFT_STALE`；回應含 `duty`）；`GET /api/staff/hr/my-attendance` → 打卡狀態、今日／下一班、近 30 日考勤與曠職
- 請假（`lib/staffLeaveService.js`）：`GET /api/hq/hr/leaves?status=&branchId=&staffId=&from=&to=` → `{ counts, rows[] }`（待審優先，每筆附 `conflicts`＝重疊之已生效班次）；`POST /api/hq/hr/leaves`（代登即核准）、`POST /api/staff/hr/leave-request`（待審）收 `leaveType`（ANNUAL、NATIONAL_HOLIDAY、PERSONAL、SICK…）、`hours`、`reason`；特休／國休超額 400 `LEAVE_QUOTA_EXCEEDED`、與待審／已核准重疊 409 `LEAVE_OVERLAP`、單筆 ≤31 日。審核 `PATCH /api/hq/hr/leaves/:id` `{ status, note? }`：待審 → `APPROVED`／`REJECTED`，已核准 → `CANCELLED`（額度回補），其餘 409 `LEAVE_STATE`；拒絕／撤銷必填 `note`。員工 `GET /api/staff/hr/my-leaves`（額度＋申請）、`POST /api/staff/hr/my-leaves/:id/cancel`（僅本人待審）
- 國定假日曆：`GET /api/hq/hr/holidays?year=` → `{ holidays[{ date, name, weekday, past }], missingDefaults, defaultYears }`、`POST /api/hq/hr/holidays` `{ date, name }`（重複 409 `HOLIDAY_EXISTS`）、`PATCH /api/hq/hr/holidays/:id` `{ name }`、`POST /api/hq/hr/holidays/defaults` `{ year }`（僅補該年內建預設；無則 404 `NO_DEFAULTS`）、`DELETE /api/hq/hr/holidays/:id`；`npm run db:seed` 亦會補入。農曆節日逐年不同，須於年底前建立次年假日
- `StaffAttendance`（`source`、`missedPunchOut`、更正欄位）與 `StaffLeave`（`reviewedByStaffId`、`reviewedAt`、`reviewNote`、`createdByStaffId`）新欄位須 `npm run db:push`

**場務四週變形排班**（`/api/staff/roster`；STORE_MANAGER 以上，店長限本店＋隸屬分店，GM／FM／ADMIN 跨店；DUTY 以下 403）
- `GET /meta`（班別、格值、規則常數）、`GET /configs`（可管理分店之設定）、`PUT /configs/:branchId` `{ cycleAnchorDate, morningHeadcount, eveningHeadcount }`（人力 2–10；已有期別不可改起算日）
- `GET /?branchId=&date=` → 該日所屬週期：`cycle`、`period`、`staff[]`（`cells`、`leaveDays`、`stats`、`issues`）、`coverage`、`summary.errors/warnings`
- `POST /periods` `{ branchId, startDate }`（須對齊週期）、`POST /periods/:id/generate`（覆蓋草稿自動排班）、`PUT /periods/:id/cells` `{ staffId, date, value: MORNING|EVENING|REGULAR_OFF|REST_DAY|OFF|null }`
- `POST /periods/:id/publish`（有違規 409 `ROSTER_VIOLATIONS`，`data` 附檢查結果）、`POST /periods/:id/unpublish` `{ reason }`；他店期別 403
- 排假申請（員工本人）：`GET /api/staff/hr/off-requests` → `{ eligible, maxOffDays, offRequestDeadlineDays, ackHours, branch, configured, cycles[本期, 下一期, 下下期] }`（每期 `period`、`offRequestDeadline`、`locked`、`request`、已發布才有 `cells` 與 `ack`、`leaveDays`）；`PUT /api/staff/hr/off-requests` `{ cycleStartDate, dates: [YYYY-MM-DD], note? }`（`dates: []` 撤回；**每期開始前 14 日截止** 409 `OFF_REQUEST_CLOSED`、超額 400 `OFF_REQUEST_LIMIT`、發布後 409 `ROSTER_PUBLISHED`、非編制 403 `OFF_REQUEST_NOT_ALLOWED`）
- 班表確認（員工本人，發布後 72 小時內）：`POST /api/staff/hr/roster-ack` `{ cycleStartDate, status: CONFIRMED|DISPUTED, message? }`（異議必填說明；未發布 409 `ROSTER_NOT_PUBLISHED`；本人無排班 403 `NOT_IN_ROSTER`；逾期仍可回覆，`late=true`）。撤回重發後須重新確認。**逾 72 小時未回覆自動視為同意**：API 啟動即掛排程（預設每 5 分鐘，env `ROSTER_ACK_TICK_MS` 可調），補寫 `autoConfirmed=true` 之確認紀錄；新增欄位須 `npm run db:push`
- 店長端 `GET /api/staff/roster` 另回 `cycle.offRequestDeadline`、`staff[].offRequest`／`ack`、`stats.requestedOffUnmet`、`summary.offRequests { submitted, total }`、`summary.acks { deadline, confirmed, disputed, pending, overdue }`（發布後）；新表 `RosterOffRequest`、`RosterAcknowledgement` 須 `npm run db:push`
- 員工自助：`GET /api/staff/hr/my-schedule` 只回已生效班表（已發布四週排班、已核准週班表、臨時排班）；轉正教練與店長／GM／FM 改用「週班表」（舊自由排班 POST／DELETE 已移除）
- 總部班表總覽（ADMIN）：`GET /api/hq/hr/schedules?from=&to=&branchId=&staffId=&source=ROSTER|FREE|MANUAL&includeOff=1` → `{ from, to, truncated, rows[] }`（預設今日起 14 日、最長 62 日；每列附 `source`／`sourceLabel`／`label`（早班、晚班、例假…）／`rosterStatus`／`deletable`）；`POST /api/hq/hr/schedules` `{ staffId, startAt, endAt, branchId?, note? }` 總部臨時排班（已無適用對象：場務／實習教練 409 `USE_ROSTER`、轉正教練 409 `USE_COACH_PLAN`、店長／GM／FM 409 `USE_WEEK_PLAN`、ADMIN 409 `SCHEDULE_EXEMPT`；重疊 409 `SCHEDULE_OVERLAP`、撞核准請假 409 `LEAVE_CONFLICT`、≤12h）；`PATCH`／`DELETE /api/hq/hr/schedules/:id` 遇四週排班格 409 `ROSTER_MANAGED`、週班表 409 `COACH_PLAN_MANAGED`（列另附 `coachPlanStatus`）。`StaffSchedule.createdByStaffId` 新欄位須 `npm run db:push`
- 新增 `BranchRosterConfig`、`RosterPeriod` 與 `StaffSchedule` 欄位，更新後須 `npm run db:push`；`npm run db:seed` 為和平（HP）、輔大（FD）建立設定（起算 2026-01-05、2＋2 人），並補示範帳號 `{hp|fd}_floor1..3`（場務）、`{hp|fd}_intern1..2`（實習教練週 24h），密碼 `staff1234`

**員工通知＋LINE 推播**（`/api/staff/notifications`；員工本人，身分取自 JWT）
- 事件（`lib/staffNotifyEvents.js`）：班表發布（附確認期限、未能排休之申請日）／撤回、員工異議 → 店長、全員回覆齊或逾期自動同意 → 店長彙整、逾期自動同意 → 本人；排假遞交／撤回 → 店長；請假申請 → 總部 ADMIN＋店長（**不含事由**）、審核結果 → 本人、核准請假與已生效班表衝突 → 店長；週班表送審 → 教練：店長＋FM／管理職：ADMIN，核准／退回／撤回核准 → 提報人本人（標示審核者職稱）。收件督導＝本店（CLASS 取上層 GYM）店長；ACADEMY → FM；GYM 無店長 → GM
- 排程（`lib/staffNotificationScheduler.js`，預設每 10 分鐘，env `STAFF_NOTIFY_TICK_MS`）：確認期限前 24h 提醒未回覆者、排假截止前 3 日提醒未遞交者、截止後彙整給店長、FAILED 推播重試（上限 5 次）。每事件以 `dedupeKey` 去重
- 所有通知寫入 `StaffNotification`（站內通知匣）；已綁 LINE 且開啟推播 → Messaging API push，否則 `SKIPPED`
- `GET /` → `{ items[最近 50], unread }`、`POST /read` `{ ids? }`（省略＝全部）
- `GET /line` → `{ bound, displayName, notifyEnabled, loginConfigured, pushConfigured }`；`POST /line/bind-url` → `{ url }`（LINE Login，state HMAC 簽章綁本人、10 分鐘單次）；`POST /line/bind` `{ code, state }`（他人 state 403 `LINE_BIND_STATE_MISMATCH`、該 LINE 已綁他人 409 `LINE_ALREADY_BOUND`）；`PATCH /line` `{ notifyEnabled }`、`DELETE /line`、`POST /line/test`
- env：沿用 `LINE_CHANNEL_ID`／`LINE_CHANNEL_SECRET`（Login）與 `LINE_CHANNEL_ACCESS_TOKEN`（Messaging）；`LINE_STAFF_CALLBACK_URL`（選填，預設 `${FRONTEND_URL}/staff/line/callback`）須登錄於 LINE Login Channel 之 Callback URL。Login 與 Messaging Channel 須同一 Provider，員工須加官方帳號好友
- LINE 綁定**僅作推播收件**，禁止用於員工登入

**工資核算匯出**（ADMIN）：`GET /api/hq/hr/payroll-export?month=YYYY-MM&branchId=` → `{ from, to, warnings[], totals, summary{ columns, rows }, detail{ columns, rows } }`（`lib/payrollExport.js`）。彙總每人：排定班次／工時、實際工時（僅已打下班卡）、遲到／早退次數與分鐘、延後下班分鐘、未打下班卡、曠職班次／工時、未排班出勤、國定假日／休息日／例假出勤時數、各假別時數（已核准，跨月依重疊比例）、需人工確認；明細每筆打卡／曠職一列。只彙整事實、**不計薪資金額**；打卡依上班日歸月，分店依員工所屬分店。每次產生寫 `PayrollExportLog`；CSV 由前端組檔

- 新增 `Staff.lineUserId` 等欄位與 `StaffNotification`、`PayrollExportLog` 表，更新後須 `npm run db:push`

**薪資系統**（ADMIN，`/api/hq/payroll`；計算 `lib/payrollRules.js`、服務 `lib/payrollService.js`）：
- `GET/PUT /config`：勞保（含就保）、職災、健保、平均眷口、勞退提繳率、基本工資；未設定沿用預設值（**須依勞保局／健保署／勞動部公告核對**）
- `GET /profiles`、`PUT/DELETE /profiles/:staffId`：`payType`（MONTHLY／HOURLY）、`monthlySalary`／`hourlyWage`、`allowances[{label,amount}]`、`laborInsuredSalary`、`healthInsuredSalary`、`healthDependents`、`pensionWage`、`pensionSelfRate`（0～0.06）
- `GET/POST /runs { month }`、`GET/DELETE /runs/:id`（僅刪草稿）、`POST /runs/:id/recalculate`、`/finalize`、`/reopen { reason }`；`PUT /runs/:id/overtime { mode: SUGGESTED|REJECT }`（整批未核定者）、`PUT /runs/:id/items/:itemId/overtime { decisions[{key, approvedMinutes|null}] | mode }`、`POST/DELETE /runs/:id/items/:itemId/adjustments[/:adjId]`（`BONUS`／`ALLOWANCE`／`OTHER_EARNING`／`INCOME_TAX`／`OTHER_DEDUCTION`）
- 計算口徑：時薪基準＝月薪÷30÷8；月薪制到職當月按日÷30、事假／家庭照顧假全扣、病假／生理假半扣、遲到早退與曠職按時薪比例扣；時薪制＝已配對班次工時（不含延後下班）＋未排班出勤＋帶薪假。加班倍率：延長工時 4/3→5/3；休息日 4/3→5/3→8/3；國定假日／例假 8h 內加發 1 倍（時薪制 2 倍）、逾 8h 4/3→5/3。加班費時薪基數＝（月薪＋固定津貼＋業績獎金）÷240（時薪制＝時薪＋其他經常性給與÷正常工時）。勞保／勞退依在職日÷30，健保整月；投保薪資／提繳工資低於當月工資列 `INSURED_SALARY_LOW`／`PENSION_WAGE_LOW` 警示。教練業績獎金依「HQ 教練業績」規則自動帶入 `PERF_PT`／`PERF_SESSION`／`PERF_GROUP_SESSION`／`PERF_GROUP_HEAD` 明細（表格欄 `performance`）；教練薪資設定：正職須月薪 ≥ 基本工資、兼職時薪 ≥ 基本時薪（400 `COACH_BASE_PAY`，未合規列結算阻擋）
- 結算阻擋（409）：`PAYROLL_MONTH_OPEN`、`PAYROLL_BLOCKED`（有出勤員工未設定薪資等）、`PAYROLL_UNREVIEWED`（加班未核定）、`PAYROLL_ATTENDANCE_REVIEW`（未打下班卡／上班中）；已結算修改 409 `PAYROLL_FINALIZED`
- 員工本人：`GET /api/staff/hr/payslips`、`GET /api/staff/hr/payslips/:month`（僅已結算）；結算／撤銷寫 `PAYSLIP_READY`／`PAYSLIP_REOPENED` 通知（不含金額）
- 未涵蓋：病假年度 30 日上限、兼職國定假日未出勤之工資、離職日欄位（停用員工以警示＋手動扣款處理）
- 新增 `StaffPayProfile`、`PayrollConfig`、`PayrollRun`、`PayrollItem` 表，更新後須 `npm run db:push`

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

教練不開放預約時段：`TrainerTimeOff`（工時內行政作業／備課／外出公務／其他，≤24h；休假類原因 400 `USE_LEAVE`，休假請走請假或週班表例假／休息日）；教練服務台「工時」分頁；`GET/POST/PATCH/DELETE /api/trainer/time-offs`；團課／私教排課重疊則 409；會員 `GET /api/member/trainers/:trainerId/time-offs`（需有該教練進行中私教合約）。教練儀表板另回 `employed`、`workSlots`（未來 14 日已生效出勤）。

諮詢客人：`ConsultGuest`（姓名＋電話）；`POST /api/trainer/schedule-consult` 自選日期／時間開 CONSULT 代約（無需選課程、無需私教合約）；亦可 `POST /api/trainer/book-consult` 對既有 CONSULT 堂代約。私教代約：`POST /api/trainer/schedule-private`（`contractId`＋場地＋時段，扣堂）。課表改期：`PATCH /api/trainer/classes/:id/reschedule`（時間／場地；不重扣堂；教練／場地防衝堂 409）。會員 LINE 約課：`GET /api/member/classes`、`POST /api/member/book-class`、`GET /api/member/reservations`、`POST /api/member/reservations/:id/cancel`（前端 `/member/book`）。

閘機業務錯誤可附 `memberId`／`code`（如 `EXPIRED_BALANCE`、`BALANCE_INSUFFICIENT`），供櫃檯續約深連；前端仍禁自傳 `memberId` 進場。

LINE OAuth：`/api/auth/line/callback` 302 回前端時改帶一次性 `auth_code`（短效、單次可用），前端再呼叫 `POST /api/auth/exchange-auth-code` 換 JWT。

分店營業人：`POST/PATCH /api/hq/branches` 帶 `legalEntityId`（發票由該營業人統編／ezPay 商店開立；仍有庫存不可改綁，409 `BRANCH_HAS_STOCK`）。營業人統編須通過財政部檢查碼（權重 1,2,1,2,1,2,4,1，總和被 5 整除），已開過發票不可改代碼／統編（409 `LEGAL_ENTITY_LOCKED`）。

員工／教練：`name`＝真實姓名（總部／交接班）；`displayName`＝對外顯示（預設「匿名」）。會員約課／LINE／員工側欄用顯示名稱。

分店代碼：`Branch.code`（建立必填、唯一）；員工／櫃檯／報表關聯顯示代碼；會員介面／LINE／發票一律用 `Branch.name`。
分店類型／隸屬：`POST/PATCH /api/hq/branches` 可帶 `type`（`GYM`／`CLASS`／`ACADEMY`，預設 GYM）與 `parentId`（僅 CLASS 可掛在 GYM 下，一層）；`GET` 回傳 `parent` 與 `_count.children`。種子分店依組織圖：HP 和平店、FD 輔大店（GYM）、AC 體適能學院（ACADEMY）、HR 熱河教室（CLASS，隸屬 HP），各綁所屬營業人（`legalEntityId`）。

守則：`backend/.cursorrules`
