// A dashboard on the phone: its blocks in reading order, each evaluated by the
// shared dashboard code against the same query answers the web reads (the
// dataResults feed, kept fresh by the same heartbeat). KPIs pair up, charts
// draw natively, tables scroll sideways. Tap a block to rename, rewrite,
// reorder or delete it; text and sections can be added.
import { memo, useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, TouchableOpacity, View as RNView, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Rect } from 'react-native-svg';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { dashboard, type ArtifactElement, type ArtifactOp } from '@codecast/shared/artifacts';
import { useLiveElements } from '@codecast/web/components/live/useLiveArtifact';
import { resultFor, useDashboardFeed, useDataResults, type DataResult } from '@codecast/web/hooks/useDashboardData';
import { Text as RNText } from '@/components/Themed';
import { mixHex, Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { newKey } from './artifactColors';
import type { ArtifactBodyProps } from './ArtifactView';

type Results = Map<string, DataResult>;
type Draft = { key: string; title: string; caption: string; text: string };

const seriesColors = (t: Palette) => [t.blue, t.green, t.orange, t.violet, t.cyan, t.magenta, t.yellow, t.red];

export function DashboardBlocks({ doc, live, editable }: ArtifactBodyProps) {
  const Theme = useTheme();
  const elements = useLiveElements(doc._id);
  const blocks = useMemo(() => dashboard.orderedBlocks(elements), [elements]);
  const byKey = useMemo(() => new Map(elements.map((e) => [e.key, e])), [elements]);
  const layout = useMemo(() => dashboard.readLayout({ get: (k) => byKey.get(k) }), [byKey]);
  useDashboardFeed(doc._id, blocks, { canWant: true });
  const results = useDataResults(doc._id);

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const apply = (ops: ArtifactOp[]) => ops.length && live.apply(ops);

  const startEdit = (b: ArtifactElement) => setDraft({ key: b.key, title: String(b.title ?? ''), caption: String(b.caption ?? ''), text: String(b.text ?? '') });
  const saveEdit = () => {
    if (!draft) return;
    const b = byKey.get(draft.key);
    if (b) {
      const set: Record<string, string | null> = {};
      const put = (f: 'title' | 'caption' | 'text', v: string) => { if (String(b[f] ?? '') !== v) set[f] = v === '' ? null : v; };
      if (b.kind === 'text') put('text', draft.text);
      else { put('title', draft.title); put('caption', draft.caption); }
      if (Object.keys(set).length) apply([{ k: draft.key, set }]);
    }
    setDraft(null);
  };
  const add = (kind: 'text' | 'section') => {
    const k = newKey('b');
    const order = dashboard.orderAfter(blocks, selected ?? undefined);
    apply([{ k, put: kind === 'text' ? { kind, order, text: '' } : { kind, order, title: 'Section' } }]);
    setSelected(k);
    setDraft({ key: k, title: kind === 'section' ? 'Section' : '', caption: '', text: '' });
  };

  const rows: ArtifactElement[][] = [];
  for (const b of blocks) {
    const last = rows[rows.length - 1];
    if (b.kind === 'kpi' && last && last.length === 1 && last[0].kind === 'kpi') last.push(b);
    else rows.push([b]);
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {(layout.headline || layout.summary) && (
        <RNView style={styles.hero}>
          {layout.headline ? <RNText style={styles.headline}>{layout.headline}</RNText> : null}
          {layout.summary ? <RNText style={styles.summary}>{layout.summary}</RNText> : null}
        </RNView>
      )}
      {blocks.length === 0 && (
        <RNView style={styles.empty}>
          <FontAwesome name="bar-chart" size={24} color={Theme.textMuted0} />
        </RNView>
      )}
      {rows.map((row) => (
        <RNView key={row[0].key} style={styles.row}>
          {row.map((b) => {
            const i = blocks.indexOf(b);
            const on = selected === b.key;
            return (
              <RNView key={b.key} style={[row.length > 1 || b.kind === 'kpi' ? styles.half : styles.full]}>
                <TouchableOpacity
                  activeOpacity={editable ? 0.8 : 1}
                  onPress={() => editable && setSelected(on ? null : b.key)}
                  style={[b.kind === 'section' || b.kind === 'text' ? styles.plain : styles.card, on && styles.cardOn]}
                >
                  <BlockBody b={b} results={results} byKey={byKey} />
                </TouchableOpacity>
                {on && editable && draft?.key !== b.key && (
                  <RNView style={styles.actions}>
                    <Action icon="pencil" label="Edit" onPress={() => startEdit(b)} />
                    <Action icon="arrow-up" label="Up" disabled={i === 0} onPress={() => apply(dashboard.moveBlockOps(elements, b.key, i - 1))} />
                    <Action icon="arrow-down" label="Down" disabled={i === blocks.length - 1} onPress={() => apply(dashboard.moveBlockOps(elements, b.key, i + 1))} />
                    <Action icon="trash-o" label="Delete" tone={Theme.red} onPress={() => { apply([{ k: b.key, del: true }]); setSelected(null); }} />
                  </RNView>
                )}
                {draft?.key === b.key && (
                  <RNView style={styles.editor}>
                    {b.kind === 'text' ? (
                      <TextInput autoFocus multiline value={draft.text} onChangeText={(text) => setDraft({ ...draft, text })} style={[styles.input, styles.inputMulti]} placeholder="Text ({b_key} shows a KPI's live value)" placeholderTextColor={Theme.textDim} />
                    ) : (
                      <>
                        <TextInput autoFocus value={draft.title} onChangeText={(title) => setDraft({ ...draft, title })} style={styles.input} placeholder="Title" placeholderTextColor={Theme.textDim} />
                        <TextInput value={draft.caption} onChangeText={(caption) => setDraft({ ...draft, caption })} style={styles.input} placeholder="Caption" placeholderTextColor={Theme.textDim} />
                      </>
                    )}
                    <RNView style={styles.editorRow}>
                      <TouchableOpacity onPress={() => setDraft(null)} style={styles.cancelBtn}><RNText style={styles.cancelText}>Cancel</RNText></TouchableOpacity>
                      <TouchableOpacity onPress={saveEdit} style={styles.saveBtn}><RNText style={styles.saveText}>Save</RNText></TouchableOpacity>
                    </RNView>
                  </RNView>
                )}
              </RNView>
            );
          })}
        </RNView>
      ))}
      {editable && (
        <RNView style={styles.addRow}>
          <Action icon="font" label="Text" onPress={() => add('text')} />
          <Action icon="header" label="Section" onPress={() => add('section')} />
        </RNView>
      )}
    </ScrollView>
  );
}

function Action({ icon, label, onPress, tone, disabled }: { icon: any; label: string; onPress: () => void; tone?: string; disabled?: boolean }) {
  const Theme = useTheme();
  const color = disabled ? Theme.textDim : tone ?? Theme.text;
  return (
    <TouchableOpacity style={styles.action} onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}>
      <FontAwesome name={icon} size={13} color={color} />
      <RNText style={[styles.actionText, { color }]}>{label}</RNText>
    </TouchableOpacity>
  );
}

const BlockBody = memo(function BlockBody({ b, results, byKey }: { b: ArtifactElement; results: Results; byKey: Map<string, ArtifactElement> }) {
  const title = typeof b.title === 'string' ? b.title : '';
  const caption = typeof b.caption === 'string' ? b.caption : '';
  switch (b.kind) {
    case 'section':
      return (
        <RNView style={styles.section}>
          <RNText style={styles.sectionTitle}>{title || 'Section'}</RNText>
          {caption ? <RNText style={styles.caption}>{caption}</RNText> : null}
        </RNView>
      );
    case 'text':
      return <LiveText text={String(b.text ?? '')} results={results} byKey={byKey} />;
    case 'kpi':
      return <Kpi b={b} result={resultFor(results, b)} />;
    case 'chart':
      return (
        <>
          {title ? <RNText style={styles.blockTitle}>{title}</RNText> : null}
          <Chart b={b} result={resultFor(results, b)} />
          {caption ? <RNText style={styles.caption}>{caption}</RNText> : null}
        </>
      );
    case 'table':
      return (
        <>
          {title ? <RNText style={styles.blockTitle}>{title}</RNText> : null}
          <Table b={b} result={resultFor(results, b)} />
        </>
      );
    default:
      return null;
  }
});

function LiveText({ text, results, byKey }: { text: string; results: Results; byKey: Map<string, ArtifactElement> }) {
  const Theme = useTheme();
  const parts = useMemo(() => dashboard.parseText(text), [text]);
  if (!text.trim()) return <RNText style={styles.dim}>Empty text</RNText>;
  return (
    <RNText style={styles.body}>
      {parts.map((p, i) => {
        if ('text' in p) return p.text;
        const target = byKey.get(p.ref);
        if (!target || target.kind !== 'kpi') return <RNText key={i} style={{ color: Theme.red }}>{`{${p.ref}}`}</RNText>;
        const ev = dashboard.evaluateKpi(target as dashboard.KpiBlock, resultFor(results, target));
        return <RNText key={i} style={styles.liveNumber}>{dashboard.kpiPartText(ev, p.part)}</RNText>;
      })}
    </RNText>
  );
}

function Kpi({ b, result }: { b: ArtifactElement; result: DataResult | undefined }) {
  const Theme = useTheme();
  const ev = dashboard.evaluateKpi(b as dashboard.KpiBlock, result);
  const delta = ev.state === 'ok' ? ev.delta : undefined;
  const value = ev.state === 'ok' || ev.state === 'unbound' ? ev.display : ev.state === 'loading' ? '…' : '–';
  const tone = delta?.good === null || !delta ? Theme.textMuted : delta.good ? Theme.green : Theme.red;
  return (
    <>
      <RNText style={styles.kpiTitle} numberOfLines={2}>{String(b.title ?? '')}</RNText>
      <RNText style={[styles.kpiValue, value.length > 9 && { fontSize: 20 }]} numberOfLines={1} adjustsFontSizeToFit>{value}</RNText>
      {delta ? (
        <RNText style={[styles.delta, { color: tone }]}>
          {delta.dir === 'up' ? '▲ ' : delta.dir === 'down' ? '▼ ' : ''}{delta.display}
        </RNText>
      ) : null}
      {ev.state === 'problem' ? (
        <RNText style={[styles.caption, { color: Theme.red }]} numberOfLines={2}>{ev.problem}</RNText>
      ) : [delta?.caption, b.caption].filter(Boolean).length ? (
        <RNText style={styles.caption} numberOfLines={2}>{[delta?.caption, b.caption].filter(Boolean).join(' · ')}</RNText>
      ) : null}
    </>
  );
}

function Chart({ b, result }: { b: ArtifactElement; result: DataResult | undefined }) {
  const Theme = useTheme();
  const [w, setW] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width), []);
  const ev = useMemo(() => dashboard.evaluateChart(b as dashboard.ChartBlock, result), [b, result]);
  const H = 180;
  if (ev.state === 'loading') return <RNView style={[styles.chartBox, { height: H }]} />;
  if (ev.state === 'unbound') return <RNText style={styles.dim}>No source</RNText>;
  if (ev.state === 'problem') return <RNText style={[styles.dim, { color: Theme.red }]}>{ev.problem}</RNText>;
  if (!ev.x.length || ev.series.every((s) => s.values.every((v) => !v))) return <RNText style={styles.dim}>Nothing recorded in this window</RNText>;
  const colors = seriesColors(Theme);
  return (
    <RNView onLayout={onLayout}>
      {w > 0 && <ChartSvg ev={ev} w={w} h={H} colors={colors} theme={Theme} />}
      <RNView style={styles.axisRow}>
        <RNText style={styles.axisText} numberOfLines={1}>{ev.x[0]}</RNText>
        <RNText style={styles.axisText} numberOfLines={1}>{ev.x[ev.x.length - 1]}</RNText>
      </RNView>
      {ev.series.length > 1 && (
        <RNView style={styles.legend}>
          {ev.series.map((s, i) => (
            <RNView key={s.name} style={styles.legendItem}>
              <RNView style={[styles.legendDot, { backgroundColor: colors[i % colors.length] }]} />
              <RNText style={styles.axisText} numberOfLines={1}>{s.name}</RNText>
            </RNView>
          ))}
        </RNView>
      )}
    </RNView>
  );
}

function ChartSvg({ ev, w, h, colors, theme }: { ev: Extract<dashboard.ChartEval, { state: 'ok' }>; w: number; h: number; colors: string[]; theme: Palette }) {
  const n = ev.x.length;
  const stacked = ev.type === 'stacked';
  const totals = ev.x.map((_, i) => ev.series.reduce((s, ser) => s + Math.max(0, ser.values[i] ?? 0), 0));
  const max = Math.max(1e-9, ...(stacked ? totals : ev.series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const min = stacked ? 0 : Math.min(0, ...ev.series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const label = dashboard.formatValue(max, ev.format);
  const pad = { l: 0, r: 0, t: 14, b: 2 };
  const ih = h - pad.t - pad.b;
  const y = (v: number) => pad.t + ih - ((v - min) / (max - min || 1)) * ih;
  const grid = [0, 0.5, 1].map((f) => pad.t + ih * f);
  const nodes: React.ReactNode[] = [];
  if (ev.type === 'line' || ev.type === 'area') {
    const x = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
    ev.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => `${x(i)},${y(v ?? 0)}`);
      const d = `M${pts.join(' L')}`;
      if (ev.type === 'area') nodes.push(<Path key={`a${si}`} d={`${d} L${x(n - 1)},${y(min)} L${x(0)},${y(min)} Z`} fill={colors[si % colors.length]} fillOpacity={0.18} />);
      nodes.push(<Path key={`l${si}`} d={d} fill="none" stroke={colors[si % colors.length]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />);
    });
  } else {
    const slot = w / n;
    const groups = stacked ? 1 : ev.series.length;
    const bw = Math.max(1, (slot * 0.75) / groups);
    ev.x.forEach((_, i) => {
      let base = 0;
      ev.series.forEach((s, si) => {
        const v = s.values[i] ?? 0;
        const top = stacked ? y(base + Math.max(0, v)) : y(Math.max(0, v));
        const bottom = stacked ? y(base) : y(Math.min(0, v));
        const x0 = i * slot + slot * 0.125 + (stacked ? 0 : si * bw);
        nodes.push(<Rect key={`${i}:${si}`} x={x0} y={top} width={bw} height={Math.max(0, bottom - top)} rx={1.5} fill={colors[si % colors.length]} />);
        if (stacked) base += Math.max(0, v);
      });
    });
  }
  return (
    <RNView>
      <Svg width={w} height={h}>
        {grid.map((gy, i) => <Line key={i} x1={0} x2={w} y1={gy} y2={gy} stroke={mixHex(theme.borderLight, 60, theme.bg)} strokeWidth={1} />)}
        {nodes}
      </Svg>
      <RNText style={[styles.axisText, styles.maxLabel]}>{label}</RNText>
    </RNView>
  );
}

function Table({ b, result }: { b: ArtifactElement; result: DataResult | undefined }) {
  const Theme = useTheme();
  const ev = useMemo(() => dashboard.evaluateTable(b as dashboard.TableBlock, result), [b, result]);
  if (ev.state === 'loading') return <RNView style={[styles.chartBox, { height: 90 }]} />;
  if (ev.state === 'unbound') return <RNText style={styles.dim}>No source</RNText>;
  if (ev.state === 'problem') return <RNText style={[styles.dim, { color: Theme.red }]}>{ev.problem}</RNText>;
  const shown = ev.rows.slice(0, 100);
  const numeric = ev.columns.map((_, i) => shown.length > 0 && shown.every((r) => r[i] === null || r[i] === undefined || typeof r[i] === 'number'));
  const fmt = (b.format as dashboard.NumberFormat | undefined) ?? 'number';
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <RNView>
          <RNView style={styles.tr}>
            {ev.columns.map((c, i) => (
              <RNText key={c} style={[styles.th, numeric[i] && styles.num]} numberOfLines={1}>{c.replace(/_/g, ' ')}</RNText>
            ))}
          </RNView>
          {shown.map((r, ri) => (
            <RNView key={ri} style={styles.tr}>
              {ev.columns.map((c, i) => (
                <RNText key={c} style={[styles.td, numeric[i] && styles.num]} numberOfLines={1}>
                  {numeric[i] ? dashboard.formatValue(r[i], c === 'spend' ? 'usd' : fmt === 'text' ? 'number' : fmt) : r[i] === null || r[i] === undefined ? '' : String(r[i])}
                </RNText>
              ))}
            </RNView>
          ))}
        </RNView>
      </ScrollView>
      {!shown.length ? <RNText style={styles.dim}>No rows</RNText> : null}
      {ev.total > shown.length ? <RNText style={styles.caption}>{shown.length} of {ev.total} rows</RNText> : null}
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  root: { flex: 1 },
  content: { padding: Spacing.md, paddingBottom: 60, gap: Spacing.sm },
  hero: { paddingVertical: Spacing.sm, gap: 4 },
  headline: { fontSize: 22, fontWeight: '700', color: Theme.text, lineHeight: 28 },
  summary: { fontSize: 14, color: Theme.textMuted, lineHeight: 20 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  row: { flexDirection: 'row', gap: Spacing.sm },
  half: { flex: 1, minWidth: 0 },
  full: { flex: 1 },
  card: { backgroundColor: Theme.cardBg, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, padding: 12, gap: 4 },
  plain: { paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: 'transparent' },
  cardOn: { borderColor: Theme.blue, borderWidth: 1.5 },
  section: { paddingTop: 10 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: Theme.text },
  blockTitle: { fontSize: 13, fontWeight: '600', color: Theme.text, marginBottom: 4 },
  caption: { fontSize: 12, color: Theme.textMuted, marginTop: 2 },
  body: { fontSize: 15, lineHeight: 23, color: Theme.textSecondary },
  liveNumber: { fontWeight: '700', color: Theme.text, textDecorationLine: 'underline', textDecorationStyle: 'dotted' },
  dim: { fontSize: 13, color: Theme.textDim, paddingVertical: 8 },
  kpiTitle: { fontSize: 11, color: Theme.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
  kpiValue: { fontSize: 26, fontWeight: '700', color: Theme.text, fontVariant: ['tabular-nums'] },
  delta: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  chartBox: { borderRadius: 8, backgroundColor: Theme.bgAlt },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  axisText: { fontSize: 10, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  maxLabel: { position: 'absolute', left: 0, top: 0 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 140 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  tr: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.borderLight },
  th: { width: 110, paddingHorizontal: 6, paddingVertical: 7, fontSize: 11, fontWeight: '600', color: Theme.textMuted },
  td: { width: 110, paddingHorizontal: 6, paddingVertical: 7, fontSize: 12.5, color: Theme.textSecondary },
  num: { textAlign: 'right', color: Theme.text, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: Theme.bgAlt },
  actionText: { fontSize: 13, fontWeight: '500' },
  editor: { marginTop: 6, gap: 6 },
  input: {
    fontSize: 14, color: Theme.text, backgroundColor: Theme.bgAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9,
    borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight,
  },
  inputMulti: { minHeight: 90, textAlignVertical: 'top' },
  editorRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  cancelBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  cancelText: { fontSize: 14, color: Theme.textMuted },
  saveBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: Theme.blue },
  saveText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  addRow: { flexDirection: 'row', gap: 8, marginTop: Spacing.md },
}));
