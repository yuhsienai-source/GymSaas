/**
 * 折讓簽名防偽：於記憶體 Canvas 合成（不落盤、不轉 Base64），輸出 PNG Blob 後立即釋放畫布。
 * 斜向浮水印為品牌色低透明度（合成後灰階約 220），深青底欄 #083D4F 只作憑證列。
 * 兩者都不得被後端當成筆跡：浮水印淺於門檻，底欄偏青、與簽名板近黑色分開計算。
 */

const WATERMARK_COLOR = 'rgba(8, 61, 79, 0.16)';
const FOOTER_COLOR = '#083D4F';
/** 底欄高度（CSS px）；實際像素再乘 devicePixelRatio */
export const SIGNATURE_FOOTER_CSS_PX = 36;

const TW_DATETIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export type SignatureStampMeta = {
  allowanceNo: string;
  invoiceNumber: string;
  totalAmt: number;
  branchName: string;
};

export function allowanceWatermarkText(meta: SignatureStampMeta) {
  const total = Math.round(Number(meta.totalAmt) || 0);
  return `僅供體育客折讓申報查驗｜他用無效｜原發票 ${meta.invoiceNumber || '—'}｜折讓含稅 $${total}`;
}

function stampLine(meta: SignatureStampMeta, at: Date) {
  const total = Math.round(Number(meta.totalAmt) || 0);
  return `僅供體育客折讓證明｜單號:${meta.allowanceNo}｜原發票:${meta.invoiceNumber}｜折讓含稅:$${total}｜${meta.branchName || '—'}｜${TW_DATETIME.format(at)}`;
}

export async function watermarkSignature(
  source: HTMLCanvasElement,
  meta: SignatureStampMeta,
  at: Date,
): Promise<Blob> {
  const dpr = window.devicePixelRatio || 1;
  const footerH = Math.round(SIGNATURE_FOOTER_CSS_PX * dpr);
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height + footerH;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('無法建立簽名畫布');
  try {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0);

    const text = allowanceWatermarkText(meta);
    const fontPx = Math.round(13 * dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, out.width, source.height);
    ctx.clip();
    ctx.fillStyle = WATERMARK_COLOR;
    ctx.font = `600 ${fontPx}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.translate(out.width / 2, source.height / 2);
    ctx.rotate((-18 * Math.PI) / 180);
    const stepX = ctx.measureText(text).width + 48 * dpr;
    const stepY = fontPx * 3.2;
    const span = Math.hypot(out.width, source.height);
    for (let y = -span / 2; y <= span / 2; y += stepY) {
      const offset = (Math.round(y / stepY) % 2) * (stepX / 2);
      for (let x = -span / 2 - offset; x <= span / 2; x += stepX) ctx.fillText(text, x, y);
    }
    ctx.restore();

    ctx.fillStyle = FOOTER_COLOR;
    ctx.fillRect(0, source.height, out.width, footerH);
    const stamp = stampLine(meta, at);
    const pad = Math.round(12 * dpr);
    const maxW = Math.max(out.width - pad * 2, 1);
    let stampPx = Math.round(12 * dpr);
    const minPx = Math.round(8 * dpr);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${stampPx}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
    while (stampPx > minPx && ctx.measureText(stamp).width > maxW) {
      stampPx -= 1;
      ctx.font = `700 ${stampPx}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
    }
    ctx.fillText(stamp, pad, source.height + footerH / 2, maxW);

    return await new Promise<Blob>((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('簽名影像輸出失敗'))), 'image/png');
    });
  } finally {
    out.width = 0;
    out.height = 0;
  }
}
