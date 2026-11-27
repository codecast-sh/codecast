// Draws web's glyphs natively: the SVG data lib/webSvg reads out of web's
// glyph components, painted with react-native-svg in the mark's colour.
import Svg, { Circle, Ellipse, G, Line, Path, Polygon, Polyline, Rect } from 'react-native-svg';
import type { ComponentType } from 'react';
import { useTheme, type Palette } from '@/constants/Theme';
import { webColor } from '@/lib/solColor';
import { svgOf, type DRAWN_TAGS, type SvgNode } from '@/lib/webSvg';

const NATIVE: Record<(typeof DRAWN_TAGS)[number], ComponentType<any>> = { g: G, path: Path, circle: Circle, rect: Rect, line: Line, polyline: Polyline, polygon: Polygon, ellipse: Ellipse };
const PRESENTATION = ['fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeDasharray', 'opacity'];

/** A paint value as native views take it: currentColor is the mark's colour,
 *  a --sol token (StatusCircle's check on `var(--sol-bg, #fff)`) the theme's. */
function paint(value: unknown, color: string, t: Palette): unknown {
  if (value === 'currentColor') return color;
  if (typeof value === 'string' && value.startsWith('var(')) return webColor(value.replace(/,[^)]*\)$/, ')'), t);
  return value;
}

function draw(node: SvgNode, color: string, t: Palette, key: number) {
  const Native = NATIVE[node.tag as keyof typeof NATIVE];
  if (!Native) throw new Error(`No native drawing for <${node.tag}>`);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.attrs)) props[k] = paint(v, color, t);
  return <Native key={key} {...props}>{node.children.map((c, i) => draw(c, color, t, i))}</Native>;
}

/** Shapes in a viewBox, painted in `color`. `root` carries the presentation
 *  attributes an <svg> sets for its children (a lucide icon's stroke). */
export function SvgGlyph({ viewBox, nodes, root = {}, color, size, testID }: { viewBox: string; nodes: SvgNode[]; root?: Record<string, unknown>; color: string; size: number; testID?: string }) {
  const t = useTheme();
  const inherited: Record<string, unknown> = {};
  for (const k of PRESENTATION) if (root[k] !== undefined) inherited[k] = paint(root[k], color, t);
  return (
    <Svg width={size} height={size} viewBox={viewBox} testID={testID}>
      <G {...inherited}>{nodes.map((n, i) => draw(n, color, t, i))}</G>
    </Svg>
  );
}

/** A web glyph component (a lucide icon, a status vocabulary's icon) drawn natively. */
export function WebIcon({ icon, color, size = 14, strokeWidth, testID }: { icon: unknown; color: string; size?: number; strokeWidth?: number; testID?: string }) {
  const svg = svgOf(icon, strokeWidth ? { strokeWidth } : {});
  return <SvgGlyph viewBox={String(svg.attrs.viewBox ?? '0 0 24 24')} nodes={svg.children} root={svg.attrs} color={color} size={size} testID={testID} />;
}
