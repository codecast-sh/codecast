// A watch's values over one window, drawn the way the web's metric chart
// reads them (components/ops/MetricChart on web): the line broken where reads
// are missing, the min-max band of each folded bucket, the line red only past
// its alert line, the alert line and warning level dashed, the announced
// episodes shaded. The axes and scales come from the web's metricModel, so a
// value sits at the same height on both.
import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View as RNView } from 'react-native';
import Svg, { ClipPath, Defs, G, Line, Path, Rect, Text as SvgText, Circle } from 'react-native-svg';
import { themedStyles, useTheme } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { formatValue, niceTicks, segments, tickLabels, timeTicks, yDomain, type Direction, type Win } from '@codecast/web/components/ops/metricModel';
import type { SeriesPt } from '@codecast/web/components/ops/metricSeries';

const PAD = { top: 10, right: 10, bottom: 20, left: 44 };

export function MetricChart({ points, win, step_ms, threshold, warn, direction, unit, episodes, loading, width, height = 200, testID }: {
  points: SeriesPt[];
  win: Win;
  /** The spacing of the drawn values: a wider gap breaks the line. */
  step_ms: number;
  threshold?: number;
  warn?: number;
  direction: Direction;
  unit?: string;
  episodes?: Win[];
  loading?: boolean;
  width: number;
  height?: number;
  testID?: string;
}) {
  const Theme = useTheme();
  const shown = useMemo(() => points.filter((p) => p.at >= win.from && p.at <= win.to), [points, win]);
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = Math.max(10, height - PAD.top - PAD.bottom);

  const [lo, hi] = useMemo(() => {
    const ext = shown.flatMap((p) => [p, ...(p.min !== undefined ? [{ at: p.at, value: p.min }] : []), ...(p.max !== undefined ? [{ at: p.at, value: p.max }] : [])]);
    if (warn !== undefined) ext.push({ at: win.from, value: warn });
    return yDomain([ext], threshold, unit);
  }, [shown, threshold, warn, unit, win.from]);

  const x = (at: number) => PAD.left + ((at - win.from) / Math.max(1, win.to - win.from)) * plotW;
  const y = (v: number) => PAD.top + (1 - (v - lo) / Math.max(1e-12, hi - lo)) * plotH;

  const runs = useMemo(() => segments(shown, Math.max(step_ms, 1)), [shown, step_ms]);
  const linePath = runs.map((run) => run.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join('')).join('');
  const bandPath = runs
    .filter((run) => run.some((p) => (p as SeriesPt).min !== undefined))
    .map((run) => {
      const top = run.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y((p as SeriesPt).max ?? p.value).toFixed(1)}`).join('');
      const bottom = [...run].reverse().map((p) => `L${x(p.at).toFixed(1)},${y((p as SeriesPt).min ?? p.value).toFixed(1)}`).join('');
      return `${top}${bottom}Z`;
    })
    .join('');

  const yTicks = niceTicks(lo, hi, 4);
  const xTicks = timeTicks(win, Math.max(2, Math.floor(plotW / 80)));
  const xLabels = tickLabels(xTicks, win);
  const last = shown[shown.length - 1];
  const lineY = threshold !== undefined ? y(threshold) : null;
  const past = lineY === null ? null : direction === 'above'
    ? { y: PAD.top, h: Math.max(0, lineY - PAD.top) }
    : { y: lineY, h: Math.max(0, PAD.top + plotH - lineY) };
  const label = { fontSize: 9.5, fontFamily: uiFace(Mono.regular), fill: Theme.textMuted0 };

  return (
    <RNView style={{ width, height }} testID={testID}>
      <Svg width={width} height={height}>
        <Defs>
          {past && (
            <ClipPath id="past">
              <Rect x={PAD.left} y={past.y} width={plotW} height={past.h} />
            </ClipPath>
          )}
        </Defs>
        {yTicks.map((t) => (
          <G key={`y${t}`}>
            <Line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke={Theme.borderLight} strokeWidth={StyleSheet.hairlineWidth} />
            <SvgText x={PAD.left - 6} y={y(t) + 3} textAnchor="end" {...label}>{formatValue(t, unit)}</SvgText>
          </G>
        ))}
        {xTicks.map((t, i) => (
          <SvgText key={`x${t}`} x={x(t)} y={height - 5} textAnchor="middle" {...label}>{xLabels[i]}</SvgText>
        ))}
        {(episodes ?? []).map((e, i) => {
          const from = Math.max(win.from, e.from);
          const to = Math.min(win.to, e.to);
          if (to <= from) return null;
          return <Rect key={`e${i}`} x={x(from)} y={PAD.top} width={Math.max(1, x(to) - x(from))} height={plotH} fill={Theme.red} opacity={0.1} />;
        })}
        {bandPath ? <Path d={bandPath} fill={Theme.blue} opacity={0.14} /> : null}
        {linePath ? <Path d={linePath} stroke={Theme.blue} strokeWidth={1.6} fill="none" strokeLinejoin="round" /> : null}
        {linePath && past ? <Path d={linePath} stroke={Theme.red} strokeWidth={1.8} fill="none" strokeLinejoin="round" clipPath="url(#past)" /> : null}
        {warn !== undefined && warn >= lo && warn <= hi ? (
          <Line x1={PAD.left} x2={PAD.left + plotW} y1={y(warn)} y2={y(warn)} stroke={Theme.yellow} strokeWidth={1} strokeDasharray="3,3" />
        ) : null}
        {lineY !== null ? <Line x1={PAD.left} x2={PAD.left + plotW} y1={lineY} y2={lineY} stroke={Theme.red} strokeWidth={1.2} strokeDasharray="5,3" /> : null}
        {last ? (
          <Circle
            cx={x(last.at)}
            cy={y(last.value)}
            r={3}
            fill={threshold !== undefined && (direction === 'above' ? last.value > threshold : last.value < threshold) ? Theme.red : Theme.blue}
          />
        ) : null}
      </Svg>
      {loading && (
        <RNView style={styles.loading} pointerEvents="none">
          <ActivityIndicator size="small" color={Theme.textMuted} />
        </RNView>
      )}
    </RNView>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
}));
