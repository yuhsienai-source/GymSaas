/**
 * 退費／取消／折讓錯誤明示：依後端 code／HTTP 狀態給櫃檯可執行的說明（訊息本體一律沿用後端 message）。
 * 模組 403 僅為權限不足，不得當登出；登入失效由 api.ts 攔截器處理。
 */
import { getApiErrorDetails } from './api';

export type RefundErrorInfo = {
  title: string;
  message: string;
  hint?: string;
  code?: string;
  status?: number;
  tone: 'error' | 'warning';
};

const CODE_GUIDE: Record<string, { title: string; hint?: string; tone?: 'error' | 'warning' }> = {
  WALLET_INSUFFICIENT_FOR_VOID: {
    title: '無法原單取消：錢包餘額不足',
    hint: '會員已動用本次儲值之本金或贈送運動金。請改用「子單退費（未使用退費）」，由後端依消保公式扣除已使用額度後退費。',
  },
  TOPUP_GRANT_UNKNOWN: { title: '此儲值單缺少入帳快照', hint: '無法判定原入帳金額，請洽總部人工處理。' },
  MEMBER_CHECKED_IN: {
    title: '會員目前在館內，暫不可退費',
    hint: '尚有未出場之進場紀錄。請待會員刷卡出場（計時者扣款完成）後再辦理；若為異常滯留，請先於「在場紀錄」處理該筆進場。',
    tone: 'warning',
  },
  COURSE_SESSION_IN_PROGRESS: {
    title: '課程進行中，暫不可退費',
    hint: '此合約有正在上課中的堂次，請於下課後再辦理解約退費。',
    tone: 'warning',
  },
  NOT_LATEST_MEMBERSHIP: {
    title: '此月卡之後已有續購',
    hint: '效期已疊加，請先退最新一筆月卡購案，再退此筆。',
    tone: 'warning',
  },
  COOLING_OFF_EXPIRED: { title: '已逾 7 日無條件解約期', hint: '請改選「契約第九條：未履約退費」。', tone: 'warning' },
  COURSE_SESSIONS_EXHAUSTED: { title: '堂數已全數使用', hint: '已無未上堂數可退。', tone: 'warning' },
  FEE_EXCEEDS_CONTRACT_LIMIT: {
    title: '手續費超過契約上限',
    hint: '只能調降手續費，不可高於試算顯示之契約手續費上限。',
    tone: 'warning',
  },
  DUTY_ROLE_REQUIRED_FOR_FEE_WAIVER: {
    title: '無權減免手續費',
    hint: '套用第十四條或調降手續費須值星（DUTY）以上主管操作。',
    tone: 'warning',
  },
  CLAUSE_INVALID: { title: '終止條款無效', hint: '請重新選擇終止條款。' },
  INVALID_FEE_AMOUNT: { title: '手續費格式錯誤', hint: '手續費須為 0 以上之整數。', tone: 'warning' },
  FEE_POLICY_NOT_APPLICABLE: { title: '此單據不適用手續費減免', hint: '商品退貨與儲值原單取消不收手續費，無須選條款。' },
  PT_CONTRACT_UNLINKED: { title: '私教訂單未連結合約', hint: '請洽總部人工處理。' },
  CONTRACT_REQUIRED: {
    title: '會員尚未完成入會契約簽署',
    hint: '請先引導會員於客顯完成定型化契約親簽，再辦理此作業。',
  },
  OFF_DUTY: {
    title: '目前非值勤時段',
    hint: '系統已切換為非值勤模式；請由值勤中之人員辦理，或先確認班表已核准。',
    tone: 'warning',
  },
  BRANCH_FORBIDDEN: { title: '無權操作此分店單據', hint: '僅能處理本店（含隸屬教室）之交易；跨店請由店長／總部辦理。' },
  SHIFT_NOT_OPEN: { title: '尚未開班', hint: '現金退款須有進行中班次，請先至「交接班」輸入備用金開班。', tone: 'warning' },
  SHIFT_BRANCH_REQUIRED: { title: '無法判定分店班次', hint: '請先選擇作業分店並開班。', tone: 'warning' },
  INVOICE_ISSUING: { title: '發票開立中', hint: '請稍候數秒再試。', tone: 'warning' },
  INVOICE_NOT_ISSUED: {
    title: '發票尚未開立，不得部分退費',
    hint: '請先至頂部「發票開立失敗」橫條補開發票，或改為全額退費。',
    tone: 'warning',
  },
  DUTY_ROLE_REQUIRED_FOR_RETRY: {
    title: '權限不足',
    hint: '僅限值班主管（DUTY+）以上權限可執行異常退費單同步重試。此為權限不足，不會登出。',
    tone: 'warning',
  },
  REFUND_RETRY_IN_PROGRESS: {
    title: '這筆退費單正在同步',
    hint: '另一位主管正在同步此退費單（若行程中斷將於 90 秒後解鎖）。重試按鈕先鎖定；關閉此提示後再試。',
    tone: 'warning',
  },
  YIPAY_TERMINAL_VOUCHER_REQUIRED: {
    title: '尚未登錄乙禾退貨憑證',
    hint: '請於下方乙禾端末退貨表單回填 RRN、授權碼與卡號末四碼（4 碼數字）。系統不會自動重刷。',
    tone: 'warning',
  },
  RETRY_NEEDS_CHECK: {
    title: '需先確認金流後台',
    hint: '上次退刷結果不明且沒有退款序號。請先到 LINE Pay／PayUNi 後台確認尚未退成，再勾選確認後才可重試，避免雙重退刷。',
    tone: 'warning',
  },
  EZPAY_NOT_ISSUED_UNCONFIRMED: {
    title: '尚未確認藍新未開立',
    hint: '請勾選「我已於藍新後台確認該筆折讓尚未開立」後再送出。未收到此確認，後端不會重開折讓。',
    tone: 'warning',
  },
  INVOICE_RESULT_UNKNOWN: {
    title: '藍新折讓結果不明',
    hint: '請由值班主管至藍新後台核對：已開立則補登真實折讓號；未開立則確認後再重開。期間不可重試或中止，已退款不受影響。',
    tone: 'warning',
  },
  ALLOWANCE_NO_TAKEN: { title: '此折讓單號已被其他退費單使用', hint: '請重新至藍新後台核對本張發票對應之折讓單號。' },
  ALLOWANCE_NO_INVALID: { title: '折讓單號格式錯誤', hint: '請依藍新後台所示輸入 6～20 碼英數字。', tone: 'warning' },
  ALLOWANCE_NO_REQUIRED: { title: '請填寫藍新折讓單號', tone: 'warning' },
  NO_UNRESOLVED_INVOICE: { title: '此退費單已無待核對之發票', hint: '可能已由其他人員處理，畫面已重新整理。', tone: 'warning' },
  INVOICE_MISMATCH: { title: '待核對發票已變更', hint: '畫面已重新整理，請確認發票號後再送出。', tone: 'warning' },
  ALLOWANCE_RESERVATION_MISSING: { title: '找不到可釋放之折讓預占', hint: '請勿重複送出，並洽總部核對發票折讓額度。' },
  CARD_MISMATCH: { title: '卡號末四碼與原交易不符', hint: '乙禾退貨必須退回原刷卡片；請核對簽單後重新輸入。' },
  YIPAY_RRN_DUPLICATE: { title: 'RRN 已被使用', hint: '此調閱編號已登錄於其他退款，請核對端末退貨簽單。' },
  ABORT_FORBIDDEN: { title: '不可中止此退費單', hint: '已有款項退出或發票已處理，請改用重試或改臨櫃現金。' },
  SERVICE_ALREADY_USED: { title: '已使用服務，不可全額退費', hint: '請改選「契約第九條」未履約退費。', tone: 'warning' },
  ILLEGAL_FIELDS: { title: '請求含非法欄位', hint: '退費金額一律由後端計算，請重新整理頁面後再試。' },
  SIGNATURE_REQUIRED: { title: '簽名無效', hint: '簽名為空白或格式錯誤，請顧客於客顯重新簽名。', tone: 'warning' },
  PAYLOAD_HASH_MISMATCH: {
    title: '簽名與折讓內容不符',
    hint: '顧客所簽版本與目前折讓單號或金額不一致，請重新推送客顯。',
    tone: 'warning',
  },
  PAYLOAD_HASH_REQUIRED: { title: '缺少折讓簽署摘要', hint: '請重新推送客顯簽名。', tone: 'warning' },
  SIGNATURE_EXISTS: { title: '此退費單已有簽名', tone: 'warning' },
  IDEMPOTENCY_KEY_REUSED: {
    title: '送出識別碼已用於其他單據',
    hint: '請關閉退費視窗重新查詢後再送出；請先於「處理中退費單」確認是否已建立退費單。',
    tone: 'error',
  },
  IDEMPOTENCY_KEY_REQUIRED: { title: '缺少送出識別碼', hint: '請重新整理頁面後再操作。', tone: 'error' },
  QUOTE_STALE: {
    title: '退費內容已變動',
    hint: '單據、會員餘額或發票狀態在試算後有異動，已重新試算；請核對新的金額與退款管道後再送出。',
    tone: 'warning',
  },
  QUOTE_EXPIRED: { title: '試算已逾時', hint: '已重新試算，請核對金額後再送出。', tone: 'warning' },
  SHORTFALL_SETTLEMENT_REQUIRED: {
    title: '學員尚須補繳差額',
    hint: '請選擇「已於 POS 臨櫃收訖」或「主管核准立案追償」後再送出；未選擇前不會停止續扣或終止合約。',
    tone: 'warning',
  },
  SHORTFALL_NOTE_REQUIRED: {
    title: '請填寫收款憑證',
    hint: '選擇「已於 POS 臨櫃收訖」時須填寫 POS 收款單號或收訖說明（至少 2 字）；尚未收款請改選「主管核准立案追償」。',
    tone: 'warning',
  },
  SHORTFALL_RESOLUTION_INVALID: {
    title: '補繳處置方式無效',
    hint: '請重新選擇「已臨櫃收訖」或「立案追償」後再送出。',
    tone: 'warning',
  },
  DUTY_APPROVAL_REQUIRED_FOR_SHORTFALL: {
    title: '須值班主管確認',
    hint: '應補繳差額之解約須由值班主管（DUTY+）確認收訖後送出。此為權限不足，不會登出。',
    tone: 'warning',
  },
  DUTY_APPROVAL_REQUIRED_FOR_EXPIRED_COURSE: {
    title: '逾效期課程須主管核准',
    hint: '依紙本契約逾期原則不予退費；專案退費須由值班主管（DUTY+）登入送出。此為權限不足，不會登出。',
    tone: 'warning',
  },
  SUBSCRIPTION_CANCELLED_REFUND_INCOMPLETE: {
    title: '定期定額已終止，但退費尚未完成',
    hint: '續期扣款已停止（不會再扣款），退費則未建立、未動帳。已重新試算，請核對金額後再次送出；若仍失敗請洽總部（系統已留稽核紀錄）。',
    tone: 'warning',
  },
  QUOTE_TOKEN_INVALID: { title: '試算憑證無效', hint: '已重新試算，請核對金額後再送出。', tone: 'warning' },
  QUOTE_TOKEN_REQUIRED: { title: '缺少試算憑證', hint: '請等待試算完成後再送出。', tone: 'warning' },
  DATE_RANGE_REQUIRED: { title: '請指定匯出日期區間', hint: '會計匯出須填起日與迄日。', tone: 'warning' },
};

export function describeRefundError(err: unknown, fallback = '操作失敗'): RefundErrorInfo {
  const d = getApiErrorDetails(err);
  const message = d.message || fallback;
  const guide = d.code ? CODE_GUIDE[d.code] : undefined;
  if (guide) {
    return { title: guide.title, message, hint: guide.hint, code: d.code, status: d.status, tone: guide.tone || 'error' };
  }
  if (d.status === 403) {
    return {
      title: '權限不足',
      message,
      hint: '此作業限值班主管（DUTY）以上，且僅限可操作分店。請由主管帳號辦理；無須重新登入。',
      code: d.code,
      status: d.status,
      tone: 'error',
    };
  }
  if (d.status === 409) {
    return { title: '單據狀態已變更', message, code: d.code, status: d.status, tone: 'warning' };
  }
  return { title: fallback, message, code: d.code, status: d.status, tone: 'error' };
}
