// 測試用簽名 PNG（以 raw RGBA 繪製，不依賴字型／SVG）
import sharp from 'sharp';

/**
 * @param {{ width?: number, height?: number, background?: number[], strokes?: Array<{ x: number, y: number, w: number, h: number, rgba?: number[] }> }} opts
 */
export function makePng({ width = 400, height = 200, background = [255, 255, 255, 255], strokes = [] } = {}) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) buf.set(background, i * 4);
  for (const s of strokes) {
    const rgba = s.rgba || [0, 0, 0, 255];
    for (let y = s.y; y < Math.min(height, s.y + s.h); y += 1) {
      for (let x = s.x; x < Math.min(width, s.x + s.w); x += 1) buf.set(rgba, (y * width + x) * 4);
    }
  }
  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/** 一筆約 600 像素之深色筆跡 */
export const inkedSignature = () => makePng({ strokes: [{ x: 50, y: 100, w: 300, h: 2 }] });
