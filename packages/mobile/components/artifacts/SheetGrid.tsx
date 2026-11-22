// A sheet on the phone: the shared engine (LiveSheet) computes every value and
// the web's cellPaint decides how each cell reads (formats, fills, tables,
// conditional colors), drawn on a windowed native grid. Tap a cell to select
// it and see its input; tap again (or the formula bar) to type; Return writes
// it and moves down.
import { useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View as RNView,
  type LayoutChangeEvent,
} from 'react-native';
import { sheet as sheetSpec } from '@codecast/shared/artifacts';
import { cellNum, colLetters, inputOps, LiveSheet } from '@codecast/web/components/sheets/sheetCore';
import { paintCell, tint, type PaintContext } from '@codecast/web/components/sheets/cellPaint';
import { AxisLayout } from '@codecast/web/components/sheets/layout';
import { useLiveElements } from '@codecast/web/components/live/useLiveArtifact';
import { Text as RNText } from '@/components/Themed';
import { Mono, uiFace } from '@/constants/fonts';
import { mixHex, Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { solColor } from '@/lib/solColor';
import type { ArtifactBodyProps } from './ArtifactView';

const DEF_COL_W = 104;
const DEF_ROW_H = 30;
const ROW_HDR = 40;
const COL_HDR = 24;
const BUFFER = 160;

/** A web paint color (`var(--sol-x)` or `color-mix(... var(--sol-x) N%, transparent)`) as hex over the sheet's background. */
function paintColor(v: string | undefined, t: Palette): string | undefined {
  if (!v) return undefined;
  const mix = /color-mix\(in srgb,\s*(var\(--sol-[a-z-]+\))\s+(\d+)%/.exec(v);
  if (mix) return mixHex(solColor(mix[1], t), Number(mix[2]), t.bg);
  return solColor(v, t, t.text);
}

export function SheetGrid({ doc, live, editable }: ArtifactBodyProps) {
  const Theme = useTheme();
  const elements = useLiveElements(doc._id);
  const engine = useRef<LiveSheet | null>(null);
  engine.current ??= new LiveSheet();
  const version = useMemo(() => {
    engine.current!.update(elements as any);
    engine.current!.refreshClock();
    return engine.current!.version;
  }, [elements]);
  const { model, wb } = engine.current;

  const [picked, setPicked] = useState<string | undefined>(undefined);
  const tabId = model.tabs.find((t) => t.id === picked)?.id ?? model.tabs[0]?.id ?? sheetSpec.DEFAULT_TAB;
  const tab = model.byId.get(tabId);

  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [sel, setSel] = useState<{ col: number; row: number }>({ col: 1, row: 1 });
  const [draft, setDraft] = useState<string | null>(null);

  const cols = useMemo(() => {
    const custom = new Map(tab?.colWidths ?? []);
    for (const c of tab?.hiddenCols ?? []) custom.set(c, 0);
    return new AxisLayout(Math.max((tab?.cols ?? 0) + 3, 8), DEF_COL_W, custom);
  }, [tab]);
  const rows = useMemo(() => {
    const custom = new Map<number, number>();
    for (const [r, h] of tab?.rowHeights ?? []) custom.set(r, Math.max(h, DEF_ROW_H));
    for (const r of tab?.hiddenRows ?? []) custom.set(r, 0);
    return new AxisLayout(Math.max((tab?.rows ?? 0) + 20, 40), DEF_ROW_H, custom);
  }, [tab]);

  const ctx: PaintContext = useMemo(() => {
    const conds = model.conds.filter((c) => c.tab === tabId);
    const ranges = new Map<string, { min: number; max: number } | null>();
    return {
      tables: model.tables.filter((t) => t.tab === tabId),
      conds,
      numericAt: (col, row) => typeof wb.value(tabId, col, row) === 'number',
      evalAt: (f, col, row) => wb.evaluate(tabId, col, row, f),
      merges: model.merges.filter((m) => m.tab === tabId),
      validation: undefined,
      scaleRange: (key) => {
        if (ranges.has(key)) return ranges.get(key)!;
        const c = conds.find((x) => x.key === key);
        let min = Infinity, max = -Infinity;
        if (c) for (const row of wb.read(tabId, c.rect)) for (const v of row) if (typeof v === 'number') { min = Math.min(min, v); max = Math.max(max, v); }
        const r = Number.isFinite(min) ? { min, max } : null;
        ranges.set(key, r);
        return r;
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version moves with every recalculation
  }, [model, wb, tabId, version]);

  const band = (col: number, row: number): string | undefined => {
    for (const t of ctx.tables) {
      if (col < t.rect.c0 || col > t.rect.c1 || row < t.rect.r0 || row > t.rect.r1) continue;
      if (row === t.rect.r0) return tint(t.color, 22);
      if (t.banded && (row - t.rect.r0) % 2 === 0) return tint(t.color, 7);
    }
    return undefined;
  };

  const c0 = Math.max(1, cols.indexAt(Math.max(0, scroll.x - ROW_HDR - BUFFER)));
  const c1 = Math.min(cols.count, cols.indexAt(scroll.x + vp.w + BUFFER));
  const r0 = Math.max(1, rows.indexAt(Math.max(0, scroll.y - BUFFER)));
  const r1 = Math.min(rows.count, rows.indexAt(scroll.y + vp.h + BUFFER));

  const selEl = tab?.cells.get(cellNum(sel.col, sel.row));
  const selInput = String(selEl?.input ?? '');
  const selA1 = `${colLetters(sel.col)}${sel.row}`;

  const commit = (value: string, move: boolean) => {
    if (value !== selInput) live.apply(inputOps(model, tabId, [{ col: sel.col, row: sel.row, input: value }]));
    setDraft(null);
    if (move) setSel({ col: sel.col, row: Math.min(rows.count, sel.row + 1) });
  };

  const select = (col: number, row: number) => {
    if (draft !== null) commit(draft, false);
    if (col === sel.col && row === sel.row && editable) {
      setDraft(selInput);
      return;
    }
    setSel({ col, row });
    live.setPresence({ position: { cell: `${colLetters(col)}${row}` }, selection: [sheetSpec.cellKey(tabId, `${colLetters(col)}${row}`)] });
  };

  const cells: React.ReactNode[] = [];
  for (let r = r0; r <= r1; r++) {
    const h = rows.sizeOf(r);
    if (!h) continue;
    const top = rows.offset(r);
    for (let c = c0; c <= c1; c++) {
      const w = cols.sizeOf(c);
      if (!w) continue;
      const el = tab?.cells.get(cellNum(c, r));
      const under = band(c, r);
      const info = el || wb.cell(tabId, c, r)?.spilled ? wb.cell(tabId, c, r) : null;
      if (!el && !info && !under) continue;
      const p = info ? paintCell(el, info.value ?? null, info.implied, c, r, ctx) : null;
      const left = cols.offset(c);
      cells.push(
        <RNView
          key={`${r}:${c}`}
          style={[
            styles.cell,
            { left, top, width: w, height: h, backgroundColor: paintColor(p?.fill ?? under, Theme) },
            p?.bd?.includes('t') && styles.bdT,
            p?.bd?.includes('r') && styles.bdR,
            p?.bd?.includes('b') && styles.bdB,
            p?.bd?.includes('l') && styles.bdL,
          ]}
        >
          {p ? (
            <RNText
              numberOfLines={p.wrap ? undefined : 1}
              style={[
                styles.cellText,
                {
                  textAlign: p.align,
                  fontWeight: p.bold ? '600' : undefined,
                  fontStyle: p.italic ? 'italic' : undefined,
                  textDecorationLine: p.underline ? 'underline' : undefined,
                  color: p.error ? Theme.red : paintColor(p.color, Theme) ?? Theme.text,
                  fontSize: p.size ?? 13,
                },
              ]}
            >
              {p.check ? (info?.value === true ? '☑' : '☐') : p.text}
            </RNText>
          ) : null}
        </RNView>,
      );
    }
  }

  const colHeads: React.ReactNode[] = [];
  for (let c = c0; c <= c1; c++) {
    const w = cols.sizeOf(c);
    if (!w) continue;
    colHeads.push(
      <RNView key={c} style={[styles.colHead, { left: ROW_HDR + cols.offset(c), width: w }, c === sel.col && styles.headOn]}>
        <RNText style={styles.headText}>{colLetters(c)}</RNText>
      </RNView>,
    );
  }
  const rowHeads: React.ReactNode[] = [];
  for (let r = r0; r <= r1; r++) {
    const h = rows.sizeOf(r);
    if (!h) continue;
    rowHeads.push(
      <RNView key={r} style={[styles.rowHead, { top: rows.offset(r), height: h }, r === sel.row && styles.headOn]}>
        <RNText style={styles.headText}>{r}</RNText>
      </RNView>,
    );
  }

  const selBox = { left: cols.offset(sel.col), top: rows.offset(sel.row), width: cols.sizeOf(sel.col), height: rows.sizeOf(sel.row) };
  const tabs = model.tabs;

  return (
    <RNView style={styles.root}>
      <RNView style={styles.formulaBar}>
        <RNText style={styles.ref}>{selA1}</RNText>
        {draft !== null ? (
          <>
            <TextInput
              autoFocus
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={() => commit(draft, true)}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              blurOnSubmit={false}
              style={styles.formulaInput}
              placeholder="Value or =formula"
              placeholderTextColor={Theme.textDim}
            />
            <TouchableOpacity onPress={() => setDraft(null)} hitSlop={6} style={styles.barBtn} accessibilityLabel="Cancel">
              <RNText style={styles.cancel}>Cancel</RNText>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => commit(draft, false)} hitSlop={6} style={[styles.barBtn, styles.okBtn]} accessibilityLabel="Save">
              <RNText style={styles.ok}>Save</RNText>
            </TouchableOpacity>
          </>
        ) : (
          <Pressable style={styles.formulaShown} onPress={() => editable && setDraft(selInput)} disabled={!editable}>
            <RNText style={styles.formulaText} numberOfLines={2}>{selInput}</RNText>
          </Pressable>
        )}
      </RNView>

      <RNView style={styles.gridBox} onLayout={(e: LayoutChangeEvent) => setVp({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        <ScrollView
          horizontal
          bounces={false}
          scrollEventThrottle={32}
          onScroll={(e) => { const x = e.nativeEvent.contentOffset.x; setScroll((s) => (Math.abs(s.x - x) < 40 ? s : { ...s, x })); }}
          keyboardShouldPersistTaps="handled"
        >
          <RNView style={{ width: ROW_HDR + cols.total }}>
            <RNView style={styles.colHeadRow}>{colHeads}</RNView>
            <ScrollView
              bounces={false}
              scrollEventThrottle={32}
              onScroll={(e) => { const y = e.nativeEvent.contentOffset.y; setScroll((s) => (Math.abs(s.y - y) < 40 ? s : { ...s, y })); }}
              keyboardShouldPersistTaps="handled"
            >
              <RNView style={{ height: rows.total, flexDirection: 'row' }}>
                <RNView style={{ width: ROW_HDR }}>{rowHeads}</RNView>
                <Pressable
                  style={{ width: cols.total, height: rows.total }}
                  onPress={(e) => select(cols.indexAt(e.nativeEvent.locationX), rows.indexAt(e.nativeEvent.locationY))}
                >
                  <RNView pointerEvents="none" style={StyleSheet.absoluteFill}>
                    <GridLines cols={cols} rows={rows} c0={c0} c1={c1} r0={r0} r1={r1} />
                    {cells}
                    <RNView style={[styles.selection, selBox]} />
                  </RNView>
                </Pressable>
              </RNView>
            </ScrollView>
          </RNView>
        </ScrollView>
      </RNView>

      {tabs.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsInner}>
          {tabs.map((t) => (
            <TouchableOpacity key={t.id} onPress={() => { setPicked(t.id); setSel({ col: 1, row: 1 }); setDraft(null); }} style={[styles.tab, t.id === tabId && styles.tabOn]}>
              <RNText style={[styles.tabText, t.id === tabId && styles.tabTextOn]}>{t.name}</RNText>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </RNView>
  );
}

function GridLines({ cols, rows, c0, c1, r0, r1 }: { cols: AxisLayout; rows: AxisLayout; c0: number; c1: number; r0: number; r1: number }) {
  const lines: React.ReactNode[] = [];
  const top = rows.offset(r0), bottom = rows.offset(r1) + rows.sizeOf(r1);
  const left = cols.offset(c0), right = cols.offset(c1) + cols.sizeOf(c1);
  for (let c = c0; c <= c1; c++) lines.push(<RNView key={`c${c}`} style={[styles.vLine, { left: cols.offset(c) + cols.sizeOf(c) - 1, top, height: bottom - top }]} />);
  for (let r = r0; r <= r1; r++) lines.push(<RNView key={`r${r}`} style={[styles.hLine, { top: rows.offset(r) + rows.sizeOf(r) - 1, left, width: right - left }]} />);
  return <>{lines}</>;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  root: { flex: 1 },
  formulaBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.borderLight, backgroundColor: Theme.bgAlt,
  },
  ref: { width: 46, fontSize: 13, fontFamily: uiFace(Mono.semiBold), color: Theme.textMuted },
  formulaShown: { flex: 1, paddingVertical: 10 },
  formulaText: { fontSize: 14, color: Theme.text, fontFamily: uiFace(Mono.regular) },
  formulaInput: {
    flex: 1, fontSize: 14, color: Theme.text, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 6,
    backgroundColor: Theme.bg, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.blue,
  },
  barBtn: { paddingHorizontal: 8, paddingVertical: 7, borderRadius: 6 },
  okBtn: { backgroundColor: Theme.blue },
  cancel: { fontSize: 13, color: Theme.textMuted },
  ok: { fontSize: 13, color: '#fff', fontWeight: '600' },
  gridBox: { flex: 1, backgroundColor: Theme.bg },
  colHeadRow: { height: COL_HDR, backgroundColor: Theme.bgAlt, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.borderLight },
  colHead: { position: 'absolute', top: 0, height: COL_HDR, alignItems: 'center', justifyContent: 'center', borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: Theme.borderLight },
  rowHead: { position: 'absolute', left: 0, width: ROW_HDR, alignItems: 'center', justifyContent: 'center', backgroundColor: Theme.bgAlt, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.borderLight },
  headOn: { backgroundColor: mixHex(Theme.blue, 22, Theme.bgAlt) },
  headText: { fontSize: 11, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  cell: { position: 'absolute', justifyContent: 'center', paddingHorizontal: 6, overflow: 'hidden' },
  cellText: { fontSize: 13, color: Theme.text, fontVariant: ['tabular-nums'] },
  bdT: { borderTopWidth: 1, borderTopColor: Theme.textMuted },
  bdR: { borderRightWidth: 1, borderRightColor: Theme.textMuted },
  bdB: { borderBottomWidth: 1, borderBottomColor: Theme.textMuted },
  bdL: { borderLeftWidth: 1, borderLeftColor: Theme.textMuted },
  vLine: { position: 'absolute', width: StyleSheet.hairlineWidth, backgroundColor: Theme.borderLight },
  hLine: { position: 'absolute', height: StyleSheet.hairlineWidth, backgroundColor: Theme.borderLight },
  selection: { position: 'absolute', borderWidth: 2, borderColor: Theme.blue },
  tabs: { flexGrow: 0, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight, backgroundColor: Theme.bgAlt },
  tabsInner: { paddingHorizontal: Spacing.sm, gap: 4, alignItems: 'center', height: 42 },
  tab: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6 },
  tabOn: { backgroundColor: Theme.bg },
  tabText: { fontSize: 13, color: Theme.textMuted },
  tabTextOn: { color: Theme.text, fontWeight: '600' },
}));
