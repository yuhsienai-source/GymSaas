import { useMemo, useState } from 'react';

export type MonoChartPoint = {
  label: string;
  value: number;
  detail?: string;
};

type Props = {
  points: MonoChartPoint[];
  height?: number;
};

/** 極細單線＋半透明填色；hover 才揭露細分 */
export default function MonoLineChart({ points, height = 180 }: Props) {
  const [tip, setTip] = useState<{ x: number; y: number; point: MonoChartPoint } | null>(null);

  const { path, area, dots, max } = useMemo(() => {
    const w = 1000;
    const h = height;
    const padX = 24;
    const padY = 20;
    const vals = points.map((p) => p.value);
    const maxV = Math.max(1, ...vals);
    const n = Math.max(1, points.length - 1);
    const coords = points.map((p, i) => {
      const x = padX + (i / n) * (w - padX * 2);
      const y = h - padY - (p.value / maxV) * (h - padY * 2);
      return { x, y, point: p };
    });
    const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ');
    const areaPath =
      coords.length > 0
        ? `${line} L${coords[coords.length - 1].x},${h - padY} L${coords[0].x},${h - padY} Z`
        : '';
    return { path: line, area: areaPath, dots: coords, max: maxV };
  }, [height, points]);

  if (points.length === 0) {
    return <p className="text-muted text-sm">尚無趨勢資料</p>;
  }

  return (
    <div className="mono-chart-wrap">
      <svg
        className="mono-chart"
        viewBox={`0 0 1000 ${height}`}
        role="img"
        aria-label="營收趨勢"
        style={{ height }}
      >
        <defs>
          <linearGradient id="monoChartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((r) => (
          <line
            key={r}
            className="mono-chart__grid"
            x1="24"
            x2="976"
            y1={height - 20 - r * (height - 40)}
            y2={height - 20 - r * (height - 40)}
          />
        ))}
        <path className="mono-chart__area" d={area} />
        <path className="mono-chart__line" d={path} />
        {dots.map((d) => (
          <circle
            key={d.point.label}
            className="mono-chart__dot"
            cx={d.x}
            cy={d.y}
            r={5}
            onMouseEnter={(e) => {
              const rect = (e.target as SVGCircleElement)
                .closest('.mono-chart-wrap')
                ?.getBoundingClientRect();
              if (!rect) return;
              const svg = (e.target as SVGCircleElement).ownerSVGElement;
              if (!svg) return;
              const pt = svg.createSVGPoint();
              pt.x = d.x;
              pt.y = d.y;
              const ctm = svg.getScreenCTM();
              if (!ctm) return;
              const screen = pt.matrixTransform(ctm);
              setTip({
                x: screen.x - rect.left,
                y: screen.y - rect.top,
                point: d.point,
              });
            }}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </svg>
      {tip ? (
        <div
          className="mono-chart__tooltip"
          style={{
            left: Math.max(8, Math.min(tip.x + 12, tip.x > 700 ? tip.x - 160 : tip.x + 12)),
            top: Math.max(8, tip.y - 56),
            maxWidth: 220,
          }}
        >
          <strong>{tip.point.label}</strong>
          <div>${tip.point.value.toLocaleString('zh-TW')}</div>
          {tip.point.detail ? <div className="text-muted">{tip.point.detail}</div> : null}
          <div className="text-muted" style={{ fontSize: '0.7rem' }}>
            峰值參考 ${max.toLocaleString('zh-TW')}
          </div>
        </div>
      ) : null}
    </div>
  );
}
