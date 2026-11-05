// One ECharts canvas as a React component. The caller hands over the
// option it wants drawn; this owns the instance's life: created on mount,
// resized with its box, redrawn when the option or the app's theme changes,
// disposed on unmount. Charts that share `group` move one crosshair.
import { useRef, type CSSProperties } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { echarts, type ECharts, type EChartsOption } from "./echarts";
import { useChartTheme, type ChartTheme } from "./chartTheme";

export type OpsChartProps = {
  /** The option for the current theme; rebuilt when the theme changes. */
  option: (t: ChartTheme) => EChartsOption;
  /** Anything the option reads; a change redraws. */
  deps: readonly unknown[];
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  /** Charts in one group share a crosshair. */
  group?: string;
  /** Series ids replaced wholesale on redraw instead of merged. */
  replace?: boolean;
  onReady?: (chart: ECharts) => void;
  /** Called after every redraw, with the instance (handles, graphics). */
  onDraw?: (chart: ECharts, t: ChartTheme) => void;
  ariaLabel?: string;
};

export function OpsChart({ option, deps, height = 200, className, style, group, replace = true, onReady, onDraw, ariaLabel }: OpsChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const theme = useChartTheme();
  const drawRef = useRef(onDraw);
  drawRef.current = onDraw;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useMountEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: "canvas" });
    chart.current = c;
    if (group) { c.group = group; echarts.connect(group); }
    const ro = new ResizeObserver(() => { c.resize(); drawRef.current?.(c, themeRef.current); });
    ro.observe(el.current);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  });

  useWatchEffect(() => {
    const c = chart.current;
    if (!c) return;
    const first = !c.getOption();
    c.setOption(option(theme), replace ? { replaceMerge: ["series", "graphic"] } : undefined);
    // Handlers and global cursors (a brush) bind once the first option has made their components.
    if (first) readyRef.current?.(c);
    drawRef.current?.(c, theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, ...deps]);

  return <div ref={el} className={className} style={{ height, width: "100%", ...style }} role="img" aria-label={ariaLabel} />;
}
