/**
 * Chapter parts and flyers for chapters whose views are not built yet; they
 * render the stand-ins in placeholder.tsx.
 */

import { createElement } from "react";
import type { ChapterPart } from "./chapters/contract";
import { Placeholder, PlaceholderFlyer } from "./placeholder";
import type { ChapterId, RegionKey } from "./world";

export function placeholderPart(chapter: ChapterId, key: string, region: RegionKey, order: number, label: string, components: string[], height?: number): ChapterPart {
  const Component = () => createElement(Placeholder, { chapter, label, region, components, height });
  Component.displayName = `Placeholder(${chapter}.${key})`;
  return { key, region, order, Component };
}

export function placeholderFlyer(label: string) {
  const Component = () => createElement(PlaceholderFlyer, { label });
  Component.displayName = `PlaceholderFlyer(${label})`;
  return Component;
}
