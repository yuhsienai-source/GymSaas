/** 品牌圖示（1st FITNESS） */
export default function BrandMark({
  className = '',
  size,
}: {
  className?: string;
  /** 覆寫寬高（px）；預設交給 CSS `.brand__mark` */
  size?: number;
}) {
  const style =
    size != null
      ? ({ width: size, height: size, minWidth: size } as const)
      : undefined;
  const px = size ?? 28;

  return (
    <span className={`brand__mark${className ? ` ${className}` : ''}`} style={style}>
      <img
        src="/logo-icon.png"
        alt="1st FITNESS"
        width={px}
        height={px}
        decoding="async"
        draggable={false}
      />
    </span>
  );
}
