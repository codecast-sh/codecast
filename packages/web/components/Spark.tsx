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
