// What the Memory page shows about an atlas: colors, labels, the search rule
// and the health findings. Pure, so every view (map, index, list, health,
// editor) answers these the same way.

import {
  MEMORY_INDEX_LINE_SOFT_MAX,
  MEMORY_TYPES,
  memoryLinkKey,
  type MemoryAtlas,
  type MemoryNote,
  type MemoryReach,
} from "@codecast/shared/memory";
import type { GraphTone } from "../graph/LinkGraphCanvas";

export type MemoryView = "map" | "index" | "list" | "health";
export const MEMORY_VIEWS: { id: MemoryView; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "index", label: "Index" },
  { id: "list", label: "List" },
  { id: "health", label: "Health" },
];

export const typeKey = (type: string) => ((MEMORY_TYPES as readonly string[]).includes(type) ? type : "other");

export const TYPE_TONE: Record<string, GraphTone> = {
  user: "--sol-magenta",
  feedback: "--sol-yellow",
  project: "--sol-cyan",
  reference: "--sol-blue",
  other: "dim",
};

export const REACH: Record<MemoryReach, { label: string; why: string; tone: GraphTone }> = {
  loaded: { label: "Loads at start", why: "Indexed above the line where Claude stops reading MEMORY.md.", tone: "--sol-green" },
  reachable: { label: "Reachable", why: "Not indexed above the cut, but a loaded memory links here.", tone: "--sol-cyan" },
  cut: { label: "Below the cut", why: "Indexed after the point where MEMORY.md stops loading, and nothing loaded links here.", tone: "--sol-red" },
  orphan: { label: "Orphan", why: "No index line and no link from anything that loads.", tone: "ghost" },
};

/** A CSS color for a tone, for the DOM (the canvas resolves its own). */
export const toneCss = (tone: GraphTone) =>
  tone === "ghost" ? "color-mix(in srgb, var(--sol-text-dim) 55%, transparent)" : tone === "dim" ? "var(--sol-text-dim)" : `var(${tone})`;

export function noteMatches(note: MemoryNote, query: string, hiddenTypes: ReadonlySet<string>): boolean {
  if (hiddenTypes.has(typeKey(note.type))) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [note.name, note.file, note.description, note.body].some((s) => s.toLowerCase().includes(q));
}

export function formatBytes(n: number): string {
  return n >= 1000 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

export interface MemoryHealth {
  /** Never reach Claude at session start. */
  unreached: MemoryNote[];
  longLines: { line: number; length: number }[];
  /** Links naming no memory: a deleted one, or one marked worth writing. */
  unwritten: { note: MemoryNote; target: string }[];
  /** MEMORY.md lines whose link names no file. */
  danglingIndex: { line: number; target: string }[];
  undescribed: MemoryNote[];
  oddType: MemoryNote[];
  duplicateNames: MemoryNote[];
}

export function memoryHealth(atlas: MemoryAtlas): MemoryHealth {
  const names = new Map<string, MemoryNote[]>();
  for (const n of atlas.notes) names.set(memoryLinkKey(n.name), [...(names.get(memoryLinkKey(n.name)) ?? []), n]);
  return {
    unreached: atlas.notes.filter((n) => n.reach === "cut" || n.reach === "orphan"),
    longLines: atlas.index.lines.map((l, i) => ({ line: i + 1, length: l.length })).filter((l) => l.length > MEMORY_INDEX_LINE_SOFT_MAX),
    unwritten: atlas.notes.flatMap((note) => note.links.filter((l) => !l.file).map((l) => ({ note, target: l.raw }))),
    danglingIndex: atlas.index.refs.flatMap((refs, i) => refs.filter((r) => !r.file).map((r) => ({ line: i + 1, target: r.raw }))),
    undescribed: atlas.notes.filter((n) => !n.hasFrontmatter || !n.description),
    oddType: atlas.notes.filter((n) => n.hasFrontmatter && typeKey(n.type) === "other"),
    duplicateNames: [...names.values()].filter((ns) => ns.length > 1).flat(),
  };
}

/** The count on the Health tab: what keeps memories from reaching Claude. */
export const healthAlarm = (h: MemoryHealth) => h.unreached.length + h.danglingIndex.length;
