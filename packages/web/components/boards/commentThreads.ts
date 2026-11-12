// Board comment threads: grouping comments into threads, where a pin sits,
// and an author's initials.
import { useMemo } from "react";
import { elementBox } from "@codecast/shared/artifacts/board";
import type { ArtifactElement } from "@codecast/shared/artifacts";
import type { BoardEl } from "./boardTypes";
import { groupThreads, type LiveThread } from "../live/liveThreads";

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * Where a comment pin sits in world space. A comment on an element sits where
 * it was dropped while that spot is still on the element, else at the
 * element's top-right corner (the element moved, or the comment named only
 * the element); a comment on the canvas sits at its point.
 */
export function pinPoint(c: ArtifactElement, byKey: Map<string, BoardEl>): { x: number; y: number } | null {
  const p = c.point as any;
  const point = p && typeof p.x === "number" && typeof p.y === "number" ? (p as { x: number; y: number }) : null;
  const a = typeof c.anchor === "string" ? byKey.get(c.anchor) : undefined;
  if (!a) return point;
  const b = elementBox(a);
  if (point && point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h) return point;
  return { x: b.x + b.w - 8, y: b.y - 8 };
}

/** Every thread's pin, with pins that would land on one spot fanned out side by side so each stays visible. */
export function pinPoints(threads: readonly { root: ArtifactElement }[], byKey: Map<string, BoardEl>): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const used = new Map<string, number>();
  for (const { root } of threads) {
    const p = pinPoint(root, byKey);
    if (!p) continue;
    const spot = `${Math.round(p.x / 6)},${Math.round(p.y / 6)}`;
    const n = used.get(spot) ?? 0;
    used.set(spot, n + 1);
    out.set(root.key, n ? { x: p.x - n * 26, y: p.y } : p);
  }
  return out;
}

export type Thread = LiveThread;

/** The open threads (resolved ones have no pin), grouped by the shared rule. */
export function useThreads(comments: ArtifactElement[]): Thread[] {
  return useMemo(() => groupThreads(comments).filter((t) => !t.root.resolved), [comments]);
}
