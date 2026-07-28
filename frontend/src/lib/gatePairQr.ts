/** 閘機裝置配對 QR 編碼／解析（HQ 顯示 → /gate 掃碼） */

const PREFIX = 'GYMSAAS:GATE:v1:';

export type GatePairCredentials = {
  deviceCode: string;
  deviceKey: string;
};

function toBase64Url(utf8: string): string {
  const bytes = new TextEncoder().encode(utf8);
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(raw: string): string {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeGatePairQr(deviceCode: string, deviceKey: string): string {
  const payload = JSON.stringify({
    c: String(deviceCode || '').trim().toUpperCase(),
    k: String(deviceKey || '').trim(),
  });
  return `${PREFIX}${toBase64Url(payload)}`;
}

/**
 * 解析配對 QR 內容。
 * 支援：GYMSAAS:GATE:v1:<base64url({c,k})>、純 JSON、或「代碼|金鑰」
 */
export function parseGatePairQr(raw: string): GatePairCredentials | null {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (text.startsWith(PREFIX)) {
    try {
      const obj = JSON.parse(fromBase64Url(text.slice(PREFIX.length))) as {
        c?: string;
        k?: string;
      };
      if (obj?.c && obj?.k) {
        return {
          deviceCode: String(obj.c).trim().toUpperCase(),
          deviceKey: String(obj.k).trim(),
        };
      }
    } catch {
      return null;
    }
  }

  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as {
        c?: string;
        k?: string;
        code?: string;
        deviceCode?: string;
        key?: string;
        deviceKey?: string;
      };
      const deviceCode = obj.c || obj.code || obj.deviceCode;
      const deviceKey = obj.k || obj.key || obj.deviceKey;
      if (deviceCode && deviceKey) {
        return {
          deviceCode: String(deviceCode).trim().toUpperCase(),
          deviceKey: String(deviceKey).trim(),
        };
      }
    } catch {
      return null;
    }
  }

  const pipe = text.split('|');
  if (pipe.length === 2 && pipe[0] && pipe[1]) {
    return {
      deviceCode: pipe[0].trim().toUpperCase(),
      deviceKey: pipe[1].trim(),
    };
  }

  return null;
}
