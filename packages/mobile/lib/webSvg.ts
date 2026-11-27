// Web's glyphs as data the phone can draw. Web's marks are React SVG: lucide's
// icons, StatusCircle's task disc, the session status shapes. Each glyph
// component is a hook-free function of its props, so running it outside React
// yields its <svg> element, and this turns that element into plain nodes that
// components/marks draws with react-native-svg. The phone thus draws web's own
// geometry from web's own tables, with no second copy to drift.
import { Fragment, isValidElement, type ReactNode } from 'react';

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

type Renderable = { render: (props: object, ref: null) => ReactNode } | ((props: object) => ReactNode);

const cache = new Map<unknown, Map<string, SvgNode>>();

/** A glyph component's <svg>, run with `props`. Follows the component through
 *  wrappers (a lucide icon renders lucide's Icon, which renders the svg). */
export function svgOf(component: unknown, props: Record<string, unknown> = {}): SvgNode {
  const key = JSON.stringify(props);
  const hit = cache.get(component)?.get(key);
  if (hit) return hit;
  let el: ReactNode = { type: component, props } as never;
  for (let depth = 0; depth < 6 && isValidElement(el) || (depth === 0); depth++) {
    const { type, props: p } = el as unknown as { type: unknown; props: object };
    if (typeof type === 'string') break;
    const c = type as Renderable;
    if (c && typeof (c as any).render === 'function') el = (c as any).render(p, null);
    else if (typeof c === 'function') el = (c as any)(p);
    else throw new Error('Not a glyph component');
  }
  const [root] = svgNodes(el);
  if (root?.tag !== 'svg') throw new Error('A glyph component must render an <svg>');
  if (!cache.has(component)) cache.set(component, new Map());
  cache.get(component)!.set(key, root);
  return root;
}
