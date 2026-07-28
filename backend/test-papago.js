// test-papago.js
// 嚴格遵守 v26 標準，執行指令：node --env-file=.env test-papago.js

const FACE8_API_URL = process.env.FACE8_API_URL || "https://poat.pakka.ai"; // 替換為實際 API 根目錄
const TEST_TOKEN = "94648eae070d46468ed60fed7a00e112";

async function verifyPapagoToken() {
  try {
    // 選擇一個無破壞性的 API 端點進行 GET 測試
    const response = await fetch(`${FACE8_API_URL}/groups`, { 
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error("❌ Token 驗證失敗，Face8 拒絕連線:", data);
      return;
    }
    
    console.log("✅ Token 驗證通過，連線正常:", data);
  } catch (error) {
    console.error("❌ 網路或系統錯誤:", error.message);
  }
}

verifyPapagoToken();