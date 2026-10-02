/**
 * 折讓簽名防偽浮水印：於記憶體 Canvas 合成（不落盤、不轉 Base64），輸出 PNG Blob 後立即釋放畫布。
 * 浮水印為品牌色低透明度（灰階約 220），須淺於後端筆跡門檻（灰階 < 128），空白簽名才不會因浮水印通過檢查。
 */
const WATERMARK_COLOR = 'rgba(8, 61, 79, 0.16)';

const TW_DATETIME = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function allowanceWatermarkText(branchLabel: string, at: Date) {
  return `僅供體育客電子發票折讓憑證｜${branchLabel || '—'}｜${TW_DATETIME.format(at)}`;
}

export async function watermarkSignature(source: HTMLCanvasElement, text: string): Promise<Blob> {
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('無法建立簽名畫布');
  try {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0);

    const scale = window.devicePixelRatio || 1;
    const fontPx = Math.round(13 * scale);
    ctx.save();
    ctx.fillStyle = WATERMARK_COLOR;
    ctx.font = `600 ${fontPx}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((-18 * Math.PI) / 180);
    const stepX = ctx.measureText(text).width + 48 * scale;
    const stepY = fontPx * 3.2;
    const span = Math.hypot(out.width, out.height);
    for (let y = -span / 2; y <= span / 2; y += stepY) {
      const offset = (Math.round(y / stepY) % 2) * (stepX / 2);
      for (let x = -span / 2 - offset; x <= span / 2; x += stepX) ctx.fillText(text, x, y);
    }
    ctx.restore();

    return await new Promise<Blob>((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('簽名影像輸出失敗'))), 'image/png');
    });
  } finally {
    out.width = 0;
    out.height = 0;
  }
}
