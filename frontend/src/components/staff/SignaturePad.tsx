import { useEffect, useRef } from 'react';
import { Button } from '../ui';

type Props = {
  onChange?: (dataUrl: string | null) => void;
  disabled?: boolean;
  height?: number;
};

/** 臨櫃觸控／滑鼠簽名板，輸出 PNG data URL */
export default function SignaturePad({ onChange, disabled, height = 160 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const onChangeRef = useRef(onChange);
  const ready = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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

  function clear(e?: React.MouseEvent) {
    e?.preventDefault();
    e?.stopPropagation();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, rect.width, height);
    onChangeRef.current?.(null);
  }

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
      <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={disabled}>
        清除簽名
      </Button>
    </div>
  );
}
