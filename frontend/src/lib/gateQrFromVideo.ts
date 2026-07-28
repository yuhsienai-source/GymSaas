/**
 * 從既有 video 串流解 QR（不再另開 getUserMedia）。
 * 使用 barcode-detector ponyfill，Safari／無原生 BarcodeDetector 也可跑。
 */
import { BarcodeDetector } from 'barcode-detector/ponyfill';

type Detector = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
};

let detectorPromise: Promise<Detector> | null = null;

function getDetector(): Promise<Detector> {
  if (!detectorPromise) {
    detectorPromise = Promise.resolve(
      new BarcodeDetector({ formats: ['qr_code'] }) as Detector,
    );
  }
  return detectorPromise;
}

export type GateQrScanLoopOptions = {
  video: HTMLVideoElement;
  /** 回傳 true 表示可繼續掃下一幀；false 表示暫停循環（busy／cooldown） */
  enabled: () => boolean;
  onCode: (rawValue: string) => void;
  /** 毫秒；預設約 4fps，兼顧耗電與辨識 */
  intervalMs?: number;
};

/**
 * 對 video 做週期性 QR 偵測。回傳 stop()。
 */
export function startGateQrScanLoop(opts: GateQrScanLoopOptions): () => void {
  const intervalMs = opts.intervalMs ?? 250;
  let stopped = false;
  let timer: number | null = null;
  let lastRaw = '';
  let lastAt = 0;

  const tick = async () => {
    if (stopped) return;
    try {
      if (
        opts.enabled() &&
        opts.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        opts.video.videoWidth > 0
      ) {
        const detector = await getDetector();
        if (stopped) return;
        const codes = await detector.detect(opts.video);
        const raw = codes[0]?.rawValue?.trim();
        if (raw) {
          const now = Date.now();
          // 同一碼短時間內只觸發一次，避免連掃
          if (raw !== lastRaw || now - lastAt > 2200) {
            lastRaw = raw;
            lastAt = now;
            opts.onCode(raw);
          }
        }
      }
    } catch {
      /* 單幀失敗略過 */
    }
    if (!stopped) {
      timer = window.setTimeout(() => void tick(), intervalMs);
    }
  };

  timer = window.setTimeout(() => void tick(), 400);

  return () => {
    stopped = true;
    if (timer != null) window.clearTimeout(timer);
  };
}
