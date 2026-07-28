// lib/papago.js — PAPAGO Face8 台灣臉霸人臉辨識 API 封裝
// 正式環境請向研勤科技取得 API 文件與金鑰；未設定金鑰時自動進入 Mock 模式供開發測試

const PAPAGO_API_BASE_URL = (process.env.PAPAGO_API_BASE_URL || 'https://api.face8.ai/v1').replace(/\/$/, '');
const PAPAGO_API_KEY = (process.env.PAPAGO_API_KEY || '').trim();
const PAPAGO_GROUP_ID = (process.env.PAPAGO_GROUP_ID || 'gymsaas-members').trim();
const PAPAGO_SIMILARITY_THRESHOLD = parseFloat(process.env.PAPAGO_SIMILARITY_THRESHOLD || '0.85');
const PAPAGO_MOCK_MODE = process.env.PAPAGO_MOCK_MODE === 'true' || !PAPAGO_API_KEY;

const ENDPOINTS = {
  register: process.env.PAPAGO_REGISTER_PATH || '/face/enroll',
  identify: process.env.PAPAGO_IDENTIFY_PATH || '/face/identify',
  verify: process.env.PAPAGO_VERIFY_PATH || '/face/verify',
  liveness: process.env.PAPAGO_LIVENESS_PATH || '/face/liveness',
};

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${PAPAGO_API_KEY}`,
    'X-API-Key': PAPAGO_API_KEY,
  };
}

async function callPapagoApi(path, body) {
  const url = `${PAPAGO_API_BASE_URL}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data.message || data.error || `Face8 API 錯誤 (${response.status})`;
    throw new Error(message);
  }

  return data;
}

function normalizeFaceResult(raw) {
  const faceId = raw.faceId || raw.face_id || raw.personId || raw.person_id || raw.id;
  const confidence = raw.confidence ?? raw.similarity ?? raw.score ?? 0;
  const livenessPassed = raw.livenessPassed ?? raw.liveness_passed ?? raw.isLive ?? true;

  return { faceId, confidence: Number(confidence), livenessPassed: Boolean(livenessPassed) };
}

/**
 * 臨櫃註冊：將會員人臉照片註冊至 Face8 群組
 * @returns {{ faceId: string, confidence: number }}
 */
export async function registerFace({ imageBase64, externalId, displayName }) {
  if (!imageBase64) {
    throw new Error('缺少人臉影像');
  }

  if (PAPAGO_MOCK_MODE) {
    const faceId = `MOCK_FACE_${externalId}`;
    console.log(`[PAPAGO Mock] 註冊人臉 externalId=${externalId} -> faceId=${faceId}`);
    return { faceId, confidence: 1.0 };
  }

  const data = await callPapagoApi(ENDPOINTS.register, {
    groupId: PAPAGO_GROUP_ID,
    externalId: String(externalId),
    displayName: displayName || `Member-${externalId}`,
    image: imageBase64,
  });

  const result = normalizeFaceResult(data.data || data.result || data);
  if (!result.faceId) {
    throw new Error('Face8 註冊成功但未回傳 faceId，請確認 API 回應格式');
  }

  return result;
}

/**
 * 門禁 1:N 辨識：從閘機鏡頭擷取的人臉影像比對群組
 * @returns {{ faceId: string, confidence: number, livenessPassed: boolean }}
 */
export async function identifyFace({ imageBase64 }) {
  if (!imageBase64) {
    throw new Error('缺少人臉影像');
  }

  if (PAPAGO_MOCK_MODE) {
    // Mock：僅接受 btoa(`MOCK_FACE_${memberId}`)；真實相機 JPEG 不會通過
    try {
      const decoded = Buffer.from(imageBase64, 'base64').toString('utf8');
      if (decoded.startsWith('MOCK_FACE_')) {
        return { faceId: decoded, confidence: 0.99, livenessPassed: true };
      }
    } catch {
      /* ignore */
    }
    throw new Error(
      'PAPAGO Mock 模式不接受真實相機影像。請在閘機頁用「模擬刷臉」輸入已綁臉會員 ID，或設 PAPAGO_MOCK_MODE=false 接正式 Face8。',
    );
  }

  const data = await callPapagoApi(ENDPOINTS.identify, {
    groupId: PAPAGO_GROUP_ID,
    image: imageBase64,
    threshold: PAPAGO_SIMILARITY_THRESHOLD,
    livenessCheck: true,
  });

  const candidates = data.data?.candidates || data.candidates || data.results || [data.data || data.result || data];
  const best = candidates[0];

  if (!best) {
    return { faceId: null, confidence: 0, livenessPassed: false };
  }

  const result = normalizeFaceResult(best);
  if (result.confidence < PAPAGO_SIMILARITY_THRESHOLD) {
    return { faceId: null, confidence: result.confidence, livenessPassed: result.livenessPassed };
  }

  return result;
}

/**
 * 1:1 驗證：比對指定 faceId 與現場影像
 */
export async function verifyFace({ imageBase64, faceId }) {
  if (!imageBase64 || !faceId) {
    throw new Error('缺少人臉影像或 faceId');
  }

  if (PAPAGO_MOCK_MODE) {
    const expected = faceId;
    try {
      const decoded = Buffer.from(imageBase64, 'base64').toString('utf8');
      const matched = decoded === expected;
      return { matched, confidence: matched ? 0.99 : 0, livenessPassed: matched };
    } catch {
      return { matched: false, confidence: 0, livenessPassed: false };
    }
  }

  const data = await callPapagoApi(ENDPOINTS.verify, {
    faceId,
    image: imageBase64,
    threshold: PAPAGO_SIMILARITY_THRESHOLD,
    livenessCheck: true,
  });

  const result = normalizeFaceResult(data.data || data.result || data);
  return {
    matched: result.confidence >= PAPAGO_SIMILARITY_THRESHOLD,
    confidence: result.confidence,
    livenessPassed: result.livenessPassed,
  };
}

export function isMockMode() {
  return PAPAGO_MOCK_MODE;
}

export function getSimilarityThreshold() {
  return PAPAGO_SIMILARITY_THRESHOLD;
}
