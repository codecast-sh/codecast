// Theme-aware label palette. Text uses a dark shade (-700) in light mode and a
// light shade (-400) in dark mode so labels stay legible on either surface; the
// dot is a saturated -500 that reads on both. Tailwind's JIT only emits classes
// that appear as complete literal strings, so every dark: variant is written out
// in full below — do not build these names dynamically.
const LABEL_COLORS: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  bug: { bg: "bg-red-500/10", text: "text-red-700 dark:text-red-400", border: "border-red-500/30", dot: "bg-red-500 dark:bg-red-400" },
  feature: { bg: "bg-blue-500/10", text: "text-blue-700 dark:text-blue-400", border: "border-blue-500/30", dot: "bg-blue-500 dark:bg-blue-400" },
  improvement: { bg: "bg-cyan-500/10", text: "text-cyan-700 dark:text-cyan-400", border: "border-cyan-500/30", dot: "bg-cyan-500 dark:bg-cyan-400" },
  refactor: { bg: "bg-amber-500/10", text: "text-amber-700 dark:text-amber-400", border: "border-amber-500/30", dot: "bg-amber-500 dark:bg-amber-400" },
  docs: { bg: "bg-indigo-500/10", text: "text-indigo-700 dark:text-indigo-400", border: "border-indigo-500/30", dot: "bg-indigo-500 dark:bg-indigo-400" },
  infra: { bg: "bg-slate-500/10", text: "text-slate-700 dark:text-slate-400", border: "border-slate-500/30", dot: "bg-slate-500 dark:bg-slate-400" },
  design: { bg: "bg-pink-500/10", text: "text-pink-700 dark:text-pink-400", border: "border-pink-500/30", dot: "bg-pink-500 dark:bg-pink-400" },
  perf: { bg: "bg-orange-500/10", text: "text-orange-700 dark:text-orange-400", border: "border-orange-500/30", dot: "bg-orange-500 dark:bg-orange-400" },
  security: { bg: "bg-yellow-500/10", text: "text-yellow-700 dark:text-yellow-400", border: "border-yellow-500/30", dot: "bg-yellow-500 dark:bg-yellow-400" },
  testing: { bg: "bg-green-500/10", text: "text-green-700 dark:text-green-400", border: "border-green-500/30", dot: "bg-green-500 dark:bg-green-400" },
  urgent: { bg: "bg-rose-500/10", text: "text-rose-700 dark:text-rose-400", border: "border-rose-500/30", dot: "bg-rose-500 dark:bg-rose-400" },
  blocked: { bg: "bg-neutral-500/10", text: "text-neutral-700 dark:text-neutral-400", border: "border-neutral-500/30", dot: "bg-neutral-500 dark:bg-neutral-400" },
};

// Ordered so neighboring entries contrast: linear probing (below) resolves a
// collision onto the adjacent slot, and a hue-wheel ordering would make the
// probed color a near-twin of the one it collided with.
const HASH_PALETTE = [
  { bg: "bg-red-500/10", text: "text-red-700 dark:text-red-400", border: "border-red-500/30", dot: "bg-red-500 dark:bg-red-400" },
  { bg: "bg-teal-500/10", text: "text-teal-700 dark:text-teal-400", border: "border-teal-500/30", dot: "bg-teal-500 dark:bg-teal-400" },
  { bg: "bg-amber-500/10", text: "text-amber-700 dark:text-amber-400", border: "border-amber-500/30", dot: "bg-amber-500 dark:bg-amber-400" },
  { bg: "bg-blue-500/10", text: "text-blue-700 dark:text-blue-400", border: "border-blue-500/30", dot: "bg-blue-500 dark:bg-blue-400" },
  { bg: "bg-lime-600/10", text: "text-lime-700 dark:text-lime-400", border: "border-lime-600/30", dot: "bg-lime-600 dark:bg-lime-400" },
  { bg: "bg-fuchsia-500/10", text: "text-fuchsia-700 dark:text-fuchsia-400", border: "border-fuchsia-500/30", dot: "bg-fuchsia-500 dark:bg-fuchsia-400" },
  { bg: "bg-emerald-500/10", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-500/30", dot: "bg-emerald-500 dark:bg-emerald-400" },
  { bg: "bg-indigo-500/10", text: "text-indigo-700 dark:text-indigo-400", border: "border-indigo-500/30", dot: "bg-indigo-500 dark:bg-indigo-400" },
  { bg: "bg-orange-500/10", text: "text-orange-700 dark:text-orange-400", border: "border-orange-500/30", dot: "bg-orange-500 dark:bg-orange-400" },
  { bg: "bg-cyan-500/10", text: "text-cyan-700 dark:text-cyan-400", border: "border-cyan-500/30", dot: "bg-cyan-500 dark:bg-cyan-400" },
  { bg: "bg-rose-500/10", text: "text-rose-700 dark:text-rose-400", border: "border-rose-500/30", dot: "bg-rose-500 dark:bg-rose-400" },
  { bg: "bg-violet-500/10", text: "text-violet-700 dark:text-violet-400", border: "border-violet-500/30", dot: "bg-violet-500 dark:bg-violet-400" },
];

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Avalanche so the modulo below sees the high bits too — short lowercase
  // names otherwise cluster into a few slots.
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

// Hashing alone can't keep a handful of names apart on a small palette (the
// birthday problem — 6 names on 8 slots collide 92% of the time), so names
// claim slots first-come: a new name takes its hash slot, or probes to the
// next free one if a different name already holds it. Names keep their color
// for the life of the page; once every slot is claimed, later names fall back
// to the raw hash slot. Server renders never see per-user names, so the
// registry is browser-only to keep server output pure.
const assignedSlot = new Map<string, number>();
const takenSlots = new Set<number>();
const canRegister = typeof window !== "undefined";

function slotFor(lower: string): number {
  const n = HASH_PALETTE.length;
  const natural = fnv1a(lower) % n;
  if (!canRegister) return natural;
  const existing = assignedSlot.get(lower);
  if (existing !== undefined) return existing;
  let slot = natural;
  while (takenSlots.has(slot) && takenSlots.size < n) slot = (slot + 1) % n;
  if (assignedSlot.size < 512) {
    assignedSlot.set(lower, slot);
    takenSlots.add(slot);
  }
  return slot;
}

export function getLabelColor(name: string) {
  const lower = name.toLowerCase();
  if (LABEL_COLORS[lower]) return LABEL_COLORS[lower];
  return HASH_PALETTE[slotFor(lower)];
}

export const DEFAULT_LABELS = Object.keys(LABEL_COLORS);
