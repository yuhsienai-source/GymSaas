// lib/memberPrivacy.js — 會員權益／隱私權同意版本（註冊必勾；僅存版本號＋時間，不存多餘個資）
export const MEMBER_RIGHTS_VERSION = 'RIGHTS_v1';
export const PRIVACY_POLICY_VERSION = 'PRIVACY_v1';

/** 公開可讀摘要（前端 Modal）；正式全文可由 CMS 取代 */
export const MEMBER_RIGHTS_SUMMARY = `會員權益摘要（${MEMBER_RIGHTS_VERSION}）

一、會員得以帳號密碼、LINE 或經核准之方式登入會員中心，使用門禁、課程與會籍相關服務。
二、會籍效期、請假、訂閱與退費依館方契約與當期促銷／方案條件辦理。
三、一機一帳：門禁動態 QR 僅限已綁定裝置；借用帳號屬違約，館方得暫停服務。
四、本摘要非完整契約；入會契約與生物辨識同意書以電子簽署版本為準。`;

export const PRIVACY_POLICY_SUMMARY = `隱私權宣告摘要（${PRIVACY_POLICY_VERSION}）

一、蒐集目的：會員身分驗證、會籍／課程／金流履約、門禁安全與客服聯繫。
二、蒐集項目（最小必要）：手機、E-mail（會員帳號）、姓名、緊急聯絡人；生物辨識僅於您同意並簽署後處理。
三、利用期間：會籍存續期間及法令保留年限；證件影像依館方保存政策（會籍結束＋法定年限）。
四、您得依法請求查詢、閱覽、製給複製本、補充更正、停止蒐集／處理／利用或刪除；門禁與契約義務範圍內可能無法立即刪除。
五、密碼僅存 bcrypt 雜湊；驗證碼／OTP 不寫入明碼日誌；禁止將 Facebook／LINE 存取權杖寫入資料庫。
六、除法令或金流／簡訊等必要委託處理外，不對外販售個資。`;

export function assertRegistrationConsents(body) {
  const acceptPrivacy = body?.acceptPrivacy === true || body?.acceptPrivacy === 'true';
  const acceptMemberRights =
    body?.acceptMemberRights === true || body?.acceptMemberRights === 'true';
  if (!acceptPrivacy || !acceptMemberRights) {
    const err = new Error('請先同意「會員權益」及「隱私權宣告」');
    err.statusCode = 400;
    throw err;
  }
  const now = new Date();
  return {
    privacyConsentAt: now,
    privacyConsentVersion: PRIVACY_POLICY_VERSION,
    memberRightsConsentAt: now,
    memberRightsConsentVersion: MEMBER_RIGHTS_VERSION,
  };
}
