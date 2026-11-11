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

/** Where a comment pin sits in world space: its point, else its anchor's top-right. */
export function pinPoint(c: ArtifactElement, byKey: Map<string, BoardEl>): { x: number; y: number } | null {
  const p = c.point as any;
  if (p && typeof p.x === "number" && typeof p.y === "number") return p;
  const a = typeof c.anchor === "string" ? byKey.get(c.anchor) : undefined;
  if (!a) return null;
  const b = elementBox(a);
  return { x: b.x + b.w - 8, y: b.y - 8 };
}

export type Thread = LiveThread;

/** The open threads (resolved ones have no pin), grouped by the shared rule. */
export function useThreads(comments: ArtifactElement[]): Thread[] {
  return useMemo(() => groupThreads(comments).filter((t) => !t.root.resolved), [comments]);
}
