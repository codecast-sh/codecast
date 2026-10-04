import { cn } from "../lib/utils";

/**
 * A row of bars, oldest first; the last few, when non-zero, read in `tone`.
 * The Line's per-day counts and the Ops issue table's hourly buckets both
 * draw through here, so a count over time looks the same everywhere.
 */
export function Spark({
  values,
  bar = 4,
  gap = 1,
  height = 20,
  label,
  tone = "var(--sol-text)",
  stretch = false,
  className,
}: {
  values: number[];
  bar?: number;
  gap?: number;
  height?: number;
  label?: string;
  /** The ink of the recent, non-zero bars. */
  tone?: string;
  /** Fill the container's width instead of drawing at bar size. */
  stretch?: boolean;
  className?: string;
}) {
  const max = Math.max(1, ...values);
  const hot = Math.max(1, Math.round(values.length / 8));
  const width = values.length * (bar + gap);
  const quiet = "color-mix(in srgb, var(--sol-text-muted) 45%, transparent)";
  return (
    <svg className={cn("shrink-0", className)} width={stretch ? "100%" : width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio={stretch ? "none" : undefined} aria-label={label} role={label ? "img" : undefined}>
      {values.map((v, i) => {
        const h = v === 0 ? 1 : Math.max(3, Math.round((v / max) * height));
        const isHot = i >= values.length - hot && v > 0;
        return <rect key={i} x={i * (bar + gap)} y={height - h} width={bar} height={h} rx={Math.min(1, bar / 2)} style={{ fill: isHot ? tone : quiet }} opacity={v === 0 ? 0.35 : 1} />;
      })}
    </svg>
  );
}

/**
 * A line through values, oldest first, with the last point marked: a number
 * read over time (a goal's metric history). A target, when given and in
 * range, is a faint rule so the eye sees the distance to it.
 */
export function SparkLine({
  values,
  target,
  width = 72,
  height = 20,
  tone = "var(--sol-text)",
  label,
  className,
}: {
  values: number[];
  target?: number | null;
  width?: number;
  height?: number;
  tone?: string;
  label?: string;
  className?: string;
}) {
  if (values.length < 2) return null;
  const all = target != null ? [...values, target] : values;
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || 1;
  const pad = 2;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - pad * 2);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <svg className={cn("shrink-0", className)} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={label} role={label ? "img" : undefined} data-sparkline>
      {target != null && <line x1={pad} x2={width - pad} y1={y(target)} y2={y(target)} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="2 2" strokeWidth={1} />}
      <polyline points={points} fill="none" stroke={tone} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2} fill={tone} />
    </svg>
  );
}
