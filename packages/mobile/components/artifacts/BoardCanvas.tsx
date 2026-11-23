// A board on the phone: the web board's elements (stickies, text, shapes,
// frames, arrows, pen strokes, stickers, cards, images) drawn natively on a
// pannable, pinch-zoomable canvas. Tap selects, drag moves the selection,
// a second tap edits its words; the bar recolors, deletes and adds.
import { memo, useMemo, useRef, useState } from 'react';
import {
  Image,
  PanResponder,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View as RNView,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { G, Path, Polygon } from 'react-native-svg';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { ArtifactElement, ArtifactOp, Json } from '@codecast/shared/artifacts';
import {
  BOARD_COLORS,
  connectorGeometry,
  elementBounds,
  elementBox,
  shapeFontSize,
  shapeOutline,
  smoothPath,
  stickyLayout,
  unflatten,
  type Box,
} from '@codecast/shared/artifacts/board';
import { drawOrder, fitBox } from '@codecast/web/components/boards/boardFrame';
import { useLiveElements } from '@codecast/web/components/live/useLiveArtifact';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useActiveScheme, useTheme, type Palette } from '@/constants/Theme';
import { BOARD_INK, namedColor, newKey, plainMarks, stickyPaper, tintOf } from './artifactColors';
import type { ArtifactBodyProps } from './ArtifactView';

type Cam = { x: number; y: number; z: number };
const MIN_Z = 0.08;
const MAX_Z = 3;
const TAP_SLOP = 8;

function editField(el: ArtifactElement): 'text' | 'title' | 'label' | null {
  if (el.kind === 'sticky' || el.kind === 'text' || el.kind === 'shape') return 'text';
  if (el.kind === 'frame') return 'title';
  if (el.kind === 'connector') return 'label';
  return null;
}

const COLORABLE = new Set(['sticky', 'shape', 'text', 'frame', 'connector', 'pen']);

function within(b: Box, p: { x: number; y: number }, pad = 0): boolean {
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

function nextZ(els: readonly ArtifactElement[]): number {
  return els.reduce((m, e) => Math.max(m, typeof e.z === 'number' ? e.z : 0), 0) + 1;
}

export function BoardCanvas({ doc, live, editable }: ArtifactBodyProps) {
  const Theme = useTheme();
  const dark = useActiveScheme() === 'dark';
  const elements = useLiveElements(doc._id);
  const ordered = useMemo(() => drawOrder(elements as ArtifactElement[]), [elements]);
  const byKey = useMemo(() => new Map(ordered.map((e) => [e.key, e])), [ordered]);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cam, setCam] = useState<Cam | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; field: 'text' | 'title' | 'label'; value: string } | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const box = useRef<RNView>(null);

  const fit = (els = ordered, s = size): Cam | null => {
    if (!s.w || !s.h) return null;
    const b = fitBox(els, byKey);
    if (!b) return { x: -s.w / 2, y: -s.h / 2, z: 1 };
    const z = Math.min(MAX_Z, Math.max(MIN_Z, Math.min((s.w - 32) / b.w, (s.h - 32) / b.h)));
    return { x: b.x + b.w / 2 - s.w / 2 / z, y: b.y + b.h / 2 - s.h / 2 / z, z };
  };
  const view = cam ?? fit();

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ w: width, h: height });
    box.current?.measureInWindow((x, y) => { origin.current = { x, y }; });
  };

  // Gesture state lives in refs: the responder reads the latest view through them.
  const viewRef = useRef(view);
  viewRef.current = view;
  const state = useRef({ ordered, byKey, selected, editable });
  state.current = { ordered, byKey, selected, editable };
  const gesture = useRef<{
    mode: 'pan' | 'drag' | 'pinch';
    start: Cam;
    sx: number;
    sy: number;
    moved: boolean;
    el?: { key: string; x: number; y: number };
    pinch?: { dist: number; mid: { x: number; y: number }; cam: Cam };
  } | null>(null);
  const lastTap = useRef<{ key: string; at: number } | null>(null);

  const toWorld = (sx: number, sy: number, c: Cam) => ({ x: c.x + sx / c.z, y: c.y + sy / c.z });
  const local = (e: GestureResponderEvent) => ({ x: e.nativeEvent.pageX - origin.current.x, y: e.nativeEvent.pageY - origin.current.y });
  const touchPair = (e: GestureResponderEvent) => {
    const [a, b] = e.nativeEvent.touches;
    const ax = a.pageX - origin.current.x, ay = a.pageY - origin.current.y, bx = b.pageX - origin.current.x, by = b.pageY - origin.current.y;
    return { dist: Math.hypot(bx - ax, by - ay) || 1, mid: { x: (ax + bx) / 2, y: (ay + by) / 2 } };
  };

  const hitAt = (p: { x: number; y: number }): ArtifactElement | undefined => {
    const { ordered: els, byKey: map } = state.current;
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (el.kind === 'connector') {
        const g = connectorGeometry(el, (k) => map.get(k));
        if (g && g.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 14 / viewRef.current!.z)) return el;
        continue;
      }
      if (el.kind === 'frame') {
        const b = elementBounds(el);
        if (within({ x: b.x, y: b.y - 28, w: b.w, h: 28 }, p)) return el;
        continue;
      }
      if (within(elementBounds(el), p, 2)) return el;
    }
    for (let i = els.length - 1; i >= 0; i--) if (els[i].kind === 'frame' && within(elementBounds(els[i]), p)) return els[i];
    return undefined;
  };

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const c = viewRef.current;
      if (!c) return;
      const p = local(e);
      const w = toWorld(p.x, p.y, c);
      const { selected: sel, byKey: map, editable: canEdit } = state.current;
      const selEl = sel ? map.get(sel) : undefined;
      const onSel = canEdit && selEl && selEl.kind !== 'connector' && typeof selEl.x === 'number' && within(elementBounds(selEl), w, 6 / c.z);
      gesture.current = {
        mode: onSel ? 'drag' : 'pan',
        start: c,
        sx: p.x,
        sy: p.y,
        moved: false,
        el: onSel ? { key: selEl!.key, x: Number(selEl!.x), y: Number(selEl!.y) } : undefined,
      };
    },
    onPanResponderMove: (e) => {
      const g = gesture.current;
      if (!g) return;
      if (e.nativeEvent.touches.length >= 2) {
        const t = touchPair(e);
        if (g.mode !== 'pinch' || !g.pinch) {
          if (g.mode === 'drag') live.commit();
          g.mode = 'pinch';
          g.pinch = { ...t, cam: viewRef.current! };
        }
        const pc = g.pinch.cam;
        const z = Math.min(MAX_Z, Math.max(MIN_Z, pc.z * (t.dist / g.pinch.dist)));
        const anchor = toWorld(g.pinch.mid.x, g.pinch.mid.y, pc);
        setCam({ x: anchor.x - t.mid.x / z, y: anchor.y - t.mid.y / z, z });
        g.moved = true;
        return;
      }
      if (g.mode === 'pinch') return;
      const p = local(e);
      const dx = p.x - g.sx, dy = p.y - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      g.moved = true;
      if (g.mode === 'drag' && g.el) {
        live.preview([{ k: g.el.key, set: { x: Math.round(g.el.x + dx / g.start.z), y: Math.round(g.el.y + dy / g.start.z) } }]);
      } else {
        setCam({ x: g.start.x - dx / g.start.z, y: g.start.y - dy / g.start.z, z: g.start.z });
      }
    },
    onPanResponderRelease: (e) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g) return;
      if (g.mode === 'drag' && g.moved) {
        live.commit();
        return;
      }
      if (g.moved) return;
      const c = viewRef.current!;
      const hit = hitAt(toWorld(g.sx, g.sy, c));
      const now = Date.now();
      if (!hit) {
        setSelected(null);
        live.setPresence({ selection: [] });
        return;
      }
      const again = state.current.selected === hit.key || (lastTap.current?.key === hit.key && now - lastTap.current.at < 350);
      lastTap.current = { key: hit.key, at: now };
      setSelected(hit.key);
      live.setPresence({ selection: [hit.key], position: { key: hit.key } });
      const field = editField(hit);
      if (again && state.current.editable && field) setEditing({ key: hit.key, field, value: String(hit[field] ?? '') });
    },
    onPanResponderTerminate: () => {
      if (gesture.current?.mode === 'drag') live.commit();
      gesture.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every input is read through refs
  }), [live]);

  const sel = selected ? byKey.get(selected) : undefined;
  const apply = (ops: ArtifactOp[]) => live.apply(ops);

  const add = (kind: 'sticky' | 'text') => {
    if (!view) return;
    const c = toWorld(size.w / 2, size.h / 2, view);
    const k = newKey('el');
    const put: { kind: string } & Record<string, Json> = kind === 'sticky'
      ? { kind: 'sticky', x: Math.round(c.x - 100), y: Math.round(c.y - 80), w: 200, h: 160, text: '', color: 'yellow', z: nextZ(ordered) }
      : { kind: 'text', x: Math.round(c.x - 60), y: Math.round(c.y - 13), text: '', size: 20, z: nextZ(ordered) };
    apply([{ k, put }]);
    setSelected(k);
    setEditing({ key: k, field: 'text', value: '' });
  };

  const finishEdit = () => {
    if (!editing) return;
    const el = byKey.get(editing.key);
    if (el && String(el[editing.field] ?? '') !== editing.value) apply([{ k: editing.key, set: { [editing.field]: editing.value } }]);
    setEditing(null);
  };

  const zoomBy = (f: number) => {
    if (!view) return;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, view.z * f));
    const c = toWorld(size.w / 2, size.h / 2, view);
    setCam({ x: c.x - size.w / 2 / z, y: c.y - size.h / 2 / z, z });
  };

  return (
    <RNView style={styles.root}>
      <RNView ref={box} style={styles.canvas} onLayout={onLayout} {...responder.panHandlers}>
        {view && (
          <RNView
            pointerEvents="none"
            style={[styles.world, { transform: [{ translateX: -view.x * view.z }, { translateY: -view.y * view.z }, { scale: view.z }] }]}
          >
            <Strokes elements={ordered} byKey={byKey} theme={Theme} layer="under" />
            {ordered.map((el) => (
              <ElementView key={el.key} el={el} theme={Theme} dark={dark} />
            ))}
            <Strokes elements={ordered} byKey={byKey} theme={Theme} layer="over" />
            {sel && <Selection el={sel} byKey={byKey} z={view.z} theme={Theme} />}
          </RNView>
        )}
        {ordered.length === 0 && (
          <RNView style={styles.empty} pointerEvents="none">
            <FontAwesome name="sticky-note-o" size={26} color={Theme.textMuted0} />
          </RNView>
        )}
        <RNView style={styles.zoom}>
          <ZoomButton icon="plus" onPress={() => zoomBy(1.4)} />
          <ZoomButton icon="minus" onPress={() => zoomBy(1 / 1.4)} />
          <ZoomButton icon="expand" onPress={() => setCam(null)} />
        </RNView>
      </RNView>

      {editing ? (
        <RNView style={styles.editBar}>
          <TextInput
            autoFocus
            multiline={editing.field === 'text'}
            value={editing.value}
            onChangeText={(value) => setEditing({ ...editing, value })}
            onSubmitEditing={editing.field === 'text' ? undefined : finishEdit}
            style={styles.editInput}
            placeholder={editing.field === 'title' ? 'Frame' : editing.field === 'label' ? 'Label' : 'Text'}
            placeholderTextColor={Theme.textDim}
          />
          <TouchableOpacity style={styles.doneBtn} onPress={finishEdit} accessibilityRole="button">
            <RNText style={styles.doneText}>Done</RNText>
          </TouchableOpacity>
        </RNView>
      ) : editable && sel ? (
        <RNView style={styles.bar}>
          {COLORABLE.has(sel.kind) && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatches} style={{ flex: 1 }}>
              {BOARD_COLORS.map((c) => {
                const on = (sel.color ?? (sel.kind === 'sticky' ? 'yellow' : sel.kind === 'shape' ? 'blue' : null)) === c;
                return (
                  <TouchableOpacity
                    key={c}
                    onPress={() => apply([{ k: sel.key, set: { color: c } }])}
                    style={[styles.swatch, { backgroundColor: sel.kind === 'sticky' ? stickyPaper(c, Theme, dark) : namedColor(c, Theme) }, on && styles.swatchOn]}
                    accessibilityLabel={c}
                  />
                );
              })}
            </ScrollView>
          )}
          {!COLORABLE.has(sel.kind) && <RNView style={{ flex: 1 }} />}
          {editField(sel) && (
            <BarButton icon="pencil" label="Edit" onPress={() => { const f = editField(sel)!; setEditing({ key: sel.key, field: f, value: String(sel[f] ?? '') }); }} />
          )}
          <BarButton icon="trash-o" label="Delete" tone={Theme.red} onPress={() => { apply([{ k: sel.key, del: true }]); setSelected(null); }} />
        </RNView>
      ) : editable ? (
        <RNView style={styles.bar}>
          <BarButton icon="sticky-note-o" label="Sticky" onPress={() => add('sticky')} />
          <BarButton icon="font" label="Text" onPress={() => add('text')} />
        </RNView>
      ) : null}
    </RNView>
  );
}

function ZoomButton({ icon, onPress }: { icon: 'plus' | 'minus' | 'expand'; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity style={styles.zoomBtn} onPress={onPress} hitSlop={4} accessibilityRole="button" accessibilityLabel={icon === 'expand' ? 'Fit' : icon === 'plus' ? 'Zoom in' : 'Zoom out'}>
      <FontAwesome name={icon} size={12} color={Theme.textMuted} />
    </TouchableOpacity>
  );
}

function BarButton({ icon, label, onPress, tone }: { icon: any; label: string; onPress: () => void; tone?: string }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity style={styles.barBtn} onPress={onPress} accessibilityRole="button">
      <FontAwesome name={icon} size={14} color={tone ?? Theme.text} />
      <RNText style={[styles.barText, tone ? { color: tone } : null]}>{label}</RNText>
    </TouchableOpacity>
  );
}

function arrowHead(tip: { x: number; y: number }, angle: number, size: number): string {
  const a1 = angle + Math.PI - 0.45, a2 = angle + Math.PI + 0.45;
  return `${tip.x},${tip.y} ${tip.x + Math.cos(a1) * size},${tip.y + Math.sin(a1) * size} ${tip.x + Math.cos(a2) * size},${tip.y + Math.sin(a2) * size}`;
}

/** Pen strokes (under) and connectors (over) in one world-space SVG each. */
const Strokes = memo(function Strokes({ elements, byKey, theme, layer }: { elements: ArtifactElement[]; byKey: Map<string, ArtifactElement>; theme: Palette; layer: 'under' | 'over' }) {
  const paths = useMemo(() => {
    const out: { key: string; d: string; color: string; width: number; opacity?: number; dash?: boolean; heads: string[]; label?: { x: number; y: number; text: string } }[] = [];
    const boxes: Box[] = [];
    for (const el of elements) {
      if (layer === 'under' && el.kind === 'pen') {
        const ox = typeof el.x === 'number' ? el.x : 0, oy = typeof el.y === 'number' ? el.y : 0;
        const pts = unflatten(el.points).map((p) => ({ x: p.x + ox, y: p.y + oy }));
        if (pts.length < 2) continue;
        out.push({ key: el.key, d: smoothPath(pts), color: namedColor(el.color, theme), width: typeof el.width === 'number' ? el.width : 4, opacity: typeof el.opacity === 'number' ? el.opacity : 1, heads: [] });
        boxes.push(elementBox(el));
      }
      if (layer === 'over' && el.kind === 'connector') {
        const g = connectorGeometry(el, (k) => byKey.get(k));
        if (!g) continue;
        const width = typeof el.width === 'number' ? el.width : 2;
        const arrow = typeof el.arrow === 'string' ? el.arrow : 'end';
        const head = 9 + width * 1.5;
        const heads = [
          ...(arrow === 'end' || arrow === 'both' ? [arrowHead(g.b, g.angleEnd, head)] : []),
          ...(arrow === 'both' ? [arrowHead(g.a, g.angleStart, head)] : []),
        ];
        out.push({ key: el.key, d: g.d, color: namedColor(el.color, theme), width, dash: !!el.dash, heads, label: typeof el.label === 'string' && el.label ? { ...g.mid, text: el.label } : undefined });
        boxes.push(g.box);
      }
    }
    return out;
  }, [elements, byKey, theme, layer]);
  if (!paths.length) return null;
  return (
    <>
      <Svg style={styles.svg} width={1} height={1}>
        <G>
          {paths.map((p) => (
            <G key={p.key}>
              <Path d={p.d} fill="none" stroke={p.color} strokeOpacity={p.opacity} strokeWidth={p.width} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={p.dash ? [p.width * 3, p.width * 3] : undefined} />
              {p.heads.map((h, i) => <Polygon key={i} points={h} fill={p.color} />)}
            </G>
          ))}
        </G>
      </Svg>
      {paths.filter((p) => p.label).map((p) => (
        <RNView key={`${p.key}-l`} style={[styles.connLabel, { left: p.label!.x - 80, top: p.label!.y - 12, backgroundColor: theme.bg, borderColor: theme.borderLight }]}>
          <RNText style={{ fontSize: 13, color: theme.text, textAlign: 'center' }} numberOfLines={2}>{p.label!.text}</RNText>
        </RNView>
      ))}
    </>
  );
});

const ElementView = memo(function ElementView({ el, theme, dark }: { el: ArtifactElement; theme: Palette; dark: boolean }) {
  if (el.kind === 'connector' || el.kind === 'pen') return null;
  const b = elementBox(el);
  const pos = { left: b.x, top: b.y, width: b.w, height: b.h, transform: typeof el.rot === 'number' && el.rot ? [{ rotate: `${el.rot}deg` }] : undefined };
  const text = typeof el.text === 'string' ? plainMarks(el.text) : '';
  switch (el.kind) {
    case 'sticky': {
      const icon = typeof el.icon === 'string' && /\p{Extended_Pictographic}/u.test(el.icon) ? el.icon : '';
      const { iconH, size } = stickyLayout(String(el.text ?? ''), b.w, b.h, icon, false);
      const [first, ...rest] = text.split('\n');
      return (
        <RNView style={[styles.abs, styles.sticky, pos, { backgroundColor: stickyPaper(el.color, theme, dark) }]}>
          {icon ? <RNText style={{ fontSize: iconH * 0.82, lineHeight: iconH, textAlign: 'center' }}>{icon}</RNText> : null}
          <RNText style={{ fontSize: size, lineHeight: size * 1.3, color: BOARD_INK, textAlign: 'center' }}>
            {rest.length ? <RNText style={{ fontWeight: '700' }}>{first}{'\n'}</RNText> : first}
            {rest.join('\n')}
          </RNText>
        </RNView>
      );
    }
    case 'text': {
      const size = typeof el.size === 'number' ? el.size : 20;
      return (
        <RNView style={[styles.abs, { left: b.x, top: b.y, minWidth: b.w }]}>
          <RNText
            style={{
              fontSize: size,
              lineHeight: size * 1.3,
              fontWeight: el.weight === 'bold' ? '700' : '400',
              color: el.color ? namedColor(el.color, theme) : theme.text,
              textAlign: el.align === 'center' ? 'center' : el.align === 'right' ? 'right' : 'left',
            }}
          >
            {text || ' '}
          </RNText>
        </RNView>
      );
    }
    case 'shape': {
      const shape = typeof el.shape === 'string' ? el.shape : 'rect';
      const outline = shapeOutline(shape, b.w, b.h);
      const color = namedColor(el.color, theme, 'blue');
      const solid = el.solid === true;
      const fill = solid ? color : tintOf(el.color, theme, 16);
      const fontSize = shapeFontSize(shape, b.h);
      return (
        <RNView style={[styles.abs, pos, styles.center]}>
          {outline ? (
            <Svg style={StyleSheet.absoluteFill} width={b.w} height={b.h} viewBox={`0 0 ${b.w} ${b.h}`}>
              <Path d={outline} fill={fill} stroke={solid ? 'transparent' : color} strokeWidth={1.5} strokeLinejoin="round" />
            </Svg>
          ) : (
            <RNView style={[StyleSheet.absoluteFill, { backgroundColor: fill, borderWidth: 1.5, borderColor: solid ? 'transparent' : color, borderRadius: shape === 'pill' ? b.h / 2 : 6 }]} />
          )}
          {text ? <RNText style={{ fontSize, color: solid ? '#fff' : theme.text, fontWeight: shape === 'pill' ? '700' : '500', textAlign: 'center', paddingHorizontal: 8 }}>{text}</RNText> : null}
        </RNView>
      );
    }
    case 'frame':
      return (
        <RNView style={[styles.abs, pos, styles.frame, { backgroundColor: tintOf(el.color ?? 'gray', theme, 7, 'gray'), borderColor: tintOf(el.color ?? 'gray', theme, 34, 'gray') }]}>
          <RNText style={[styles.frameTitle, { color: el.color ? namedColor(el.color, theme) : theme.textMuted }]} numberOfLines={1}>
            {typeof el.title === 'string' && el.title ? el.title : 'Frame'}
          </RNText>
        </RNView>
      );
    case 'stamp':
      return (
        <RNView style={[styles.abs, pos, styles.center]}>
          <RNText style={{ fontSize: b.w * 0.7 }}>{typeof el.emoji === 'string' && /\p{Extended_Pictographic}/u.test(el.emoji) ? el.emoji : '⭐'}</RNText>
        </RNView>
      );
    case 'image': {
      const src = typeof el.src === 'string' && /^https?:\/\//.test(el.src) ? el.src : null;
      return (
        <RNView style={[styles.abs, pos, { backgroundColor: theme.bgAlt, borderRadius: 6, overflow: 'hidden' }]}>
          {src ? <Image source={{ uri: src }} style={StyleSheet.absoluteFill} resizeMode="contain" /> : null}
        </RNView>
      );
    }
    case 'card':
      return (
        <RNView style={[styles.abs, pos, styles.card, { backgroundColor: theme.cardBg, borderColor: theme.borderLight }]}>
          <RNText style={{ fontSize: 15, fontWeight: '600', color: theme.cyan }} numberOfLines={1}>{String(el.ref ?? '')}</RNText>
        </RNView>
      );
    default:
      return null;
  }
});

function Selection({ el, byKey, z, theme }: { el: ArtifactElement; byKey: Map<string, ArtifactElement>; z: number; theme: Palette }) {
  const b = el.kind === 'connector' ? connectorGeometry(el, (k) => byKey.get(k))?.box : elementBounds(el);
  if (!b) return null;
  const pad = 4 / z;
  return <RNView style={[styles.abs, { left: b.x - pad, top: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, borderWidth: 2 / z, borderColor: theme.blue, borderRadius: 4 / z }]} />;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  root: { flex: 1 },
  canvas: { flex: 1, overflow: 'hidden', backgroundColor: Theme.bg },
  world: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, transformOrigin: 'top left', overflow: 'visible' },
  svg: { position: 'absolute', left: 0, top: 0, overflow: 'visible' },
  abs: { position: 'absolute' },
  center: { alignItems: 'center', justifyContent: 'center' },
  sticky: { padding: 12, borderRadius: 6, justifyContent: 'center', overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
  frame: { borderWidth: 1.5, borderRadius: 10 },
  frameTitle: { position: 'absolute', top: -26, left: 2, fontSize: 15, fontWeight: '600' },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, justifyContent: 'center' },
  connLabel: { position: 'absolute', width: 160, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  empty: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  zoom: { position: 'absolute', right: Spacing.md, bottom: Spacing.md, gap: 6 },
  zoomBtn: {
    width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: Theme.bgAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight,
  },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight, backgroundColor: Theme.bgAlt, minHeight: 52,
  },
  barBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, backgroundColor: Theme.bg },
  barText: { fontSize: 14, color: Theme.text, fontWeight: '500' },
  swatches: { gap: 8, alignItems: 'center', paddingRight: 8 },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: Theme.borderLight },
  swatchOn: { borderWidth: 3, borderColor: Theme.text },
  editBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight, backgroundColor: Theme.bgAlt,
  },
  editInput: {
    flex: 1, maxHeight: 140, minHeight: 40, fontSize: 15, color: Theme.text, backgroundColor: Theme.bg,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight,
  },
  doneBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: Theme.blue },
  doneText: { color: '#fff', fontWeight: '600', fontSize: 14 },
}));
