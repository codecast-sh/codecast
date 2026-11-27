// Web's glyphs as data the phone can draw. Web's marks are React SVG: lucide's
// icons, StatusCircle's task disc, the session status shapes. Each glyph
// component is a hook-free function of its props, so running it outside React
// yields its <svg> element, and this turns that element into plain nodes that
// components/marks draws with react-native-svg. The phone thus draws web's own
// geometry from web's own tables, with no second copy to drift.
import { Fragment, isValidElement, type ReactNode } from 'react';

/** The tags components/marks/WebGlyph draws inside an <svg>. */
export const DRAWN_TAGS = ['g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'] as const;

/** One SVG element as data: its tag, its attributes and its children. */
export type SvgNode = { tag: string; attrs: Record<string, unknown>; children: SvgNode[] };

const DROPPED = new Set(['children', 'key', 'ref', 'className', 'xmlns', 'style']);

/** The SVG elements in a React node: fragments flattened, text and holes dropped. */
export function svgNodes(node: ReactNode): SvgNode[] {
  if (Array.isArray(node)) return node.flatMap(svgNodes);
  if (!isValidElement(node)) return [];
  const props = node.props as Record<string, unknown>;
  if (node.type === Fragment) return svgNodes(props.children as ReactNode);
  if (typeof node.type !== 'string') throw new Error(`A glyph holds a component (${String((node.type as any)?.displayName ?? node.type)}), not SVG`);
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!DROPPED.has(k) && !k.startsWith('aria-') && !k.startsWith('data-') && v !== undefined) attrs[k] = v;
  }
  return [{ tag: node.type, attrs, children: svgNodes(props.children as ReactNode) }];
}

const cache = new Map<unknown, Map<string, SvgNode>>();

/** A glyph component's <svg>, run with `props`. Follows the component through
 *  wrappers (a lucide icon renders lucide's Icon, which renders the svg). */
export function svgOf(component: unknown, props: Record<string, unknown> = {}): SvgNode {
  const key = JSON.stringify(props);
  const hit = cache.get(component)?.get(key);
  if (hit) return hit;
  let type: any = component;
  let p: object = props;
  let el: ReactNode = null;
  for (let depth = 0; typeof type !== 'string'; depth++) {
    // forwardRef keeps its function on `render`; a plain component is the function.
    const run = typeof type?.render === 'function' ? (q: object) => type.render(q, null) : typeof type === 'function' ? type : null;
    if (!run || depth > 6) throw new Error('Not a glyph component');
    el = run(p);
    if (!isValidElement(el)) throw new Error('A glyph component must render an element');
    type = el.type;
    p = el.props as object;
  }
  const [root] = svgNodes(el);
  if (root?.tag !== 'svg') throw new Error('A glyph component must render an <svg>');
  if (!cache.has(component)) cache.set(component, new Map());
  cache.get(component)!.set(key, root);
  return root;
}
