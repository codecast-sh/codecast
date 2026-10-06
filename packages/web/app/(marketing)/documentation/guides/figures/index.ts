import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * Animated figures for the guides. A guide's markdown places one with a fence:
 *
 *   ```figure
 *   SnippetLayersFigure
 *   The caption shown under the figure.
 *   ```
 *
 * Each guide's figures live in ./<slug>.tsx as named exports built on the
 * shared kit (blog/figureKit.tsx), so a guide's page loads only its own.
 */

type FigureModule = Record<string, ComponentType>;

const LOADERS: Record<string, () => Promise<unknown>> = import.meta.glob("./*.tsx");

const cache = new Map<string, LazyExoticComponent<ComponentType>>();

/** The named figure from a guide's figures file, loaded on first use. */
export function guideFigure(slug: string, name: string): LazyExoticComponent<ComponentType> | null {
  const load = LOADERS[`./${slug}.tsx`];
  if (!load) return null;
  const key = `${slug}/${name}`;
  let comp = cache.get(key);
  if (!comp) {
    comp = lazy(async () => {
      const mod = (await load()) as FigureModule;
      const found = mod[name];
      if (!found) throw new Error(`Guide figure ${key} is not exported from figures/${slug}.tsx`);
      return { default: found };
    });
    cache.set(key, comp);
  }
  return comp;
}
