import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Button } from '../ui';

/** 呼叫端取記憶體 Canvas（壓浮水印、toBlob）與筆跡點數（防空白送出） */
export type SignaturePadHandle = {
  getCanvas: () => HTMLCanvasElement | null;
  pointCount: () => number;
  clear: () => void;
};

type Props = {
  /** 傳入才會在每筆結束時輸出 PNG data URL；Blob 流程請改用 padRef */
  onChange?: (dataUrl: string | null) => void;
  /** 筆跡點數變動（含清除歸零） */
  onStrokeChange?: (points: number) => void;
  padRef?: Ref<SignaturePadHandle>;
  disabled?: boolean;
  height?: number;
  /** 由呼叫端自行提供清除按鈕 */
  hideClear?: boolean;
};

/** 臨櫃觸控／滑鼠簽名板 */
export default function SignaturePad({ onChange, onStrokeChange, padRef, disabled, height = 160, hideClear }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const points = useRef(0);
  const onChangeRef = useRef(onChange);
  const onStrokeRef = useRef(onStrokeChange);
  const ready = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
    onStrokeRef.current = onStrokeChange;
  }, [onChange, onStrokeChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || ready.current) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(rect.width, 1);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = '100%';
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cssW, height);
    ready.current = true;
  }, [height]);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function emit() {
    onStrokeRef.current?.(points.current);
    const canvas = canvasRef.current;
    if (!canvas || !onChangeRef.current) return;
    onChangeRef.current(canvas.toDataURL('image/png'));
  }

  function endStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    try {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    emit();
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, rect.width, height);
    points.current = 0;
    onStrokeRef.current?.(0);
    onChangeRef.current?.(null);
  }

  useImperativeHandle(
    padRef,
    () => ({
      getCanvas: () => canvasRef.current,
      pointCount: () => points.current,
      clear: clearCanvas,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearCanvas 只讀 ref 與 height
    [height],
  );

  return (
    <div className="form-stack">
      <canvas
        ref={canvasRef}
        className="signature-pad"
        style={{
          width: '100%',
          height,
          touchAction: 'none',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          background: '#fff',
          cursor: disabled ? 'not-allowed' : 'crosshair',
          display: 'block',
        }}
        onPointerDown={(e) => {
          if (disabled) return;
          e.preventDefault();
          e.stopPropagation();
          drawing.current = true;
          const ctx = canvasRef.current?.getContext('2d');
          if (!ctx) return;
          const p = pos(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          points.current += 1;
          (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drawing.current || disabled) return;
          e.preventDefault();
          const ctx = canvasRef.current?.getContext('2d');
          if (!ctx) return;
          const p = pos(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          points.current += 1;
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          e.stopPropagation();
          endStroke(e);
        }}
        onPointerCancel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          endStroke(e);
        }}
        // 勿在 pointerLeave 結束：易誤觸，且 label 內可能連動點到「清除」
      />
      {!hideClear && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            clearCanvas();
          }}
          disabled={disabled}
        >
          清除簽名
        </Button>
      )}
    </div>
  );
}
