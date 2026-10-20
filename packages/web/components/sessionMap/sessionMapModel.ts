// The session map (/map): every live session as a card on one zoomable
// canvas, sitting in a pile. A pile the person made (they dragged or piled
// sessions there) always holds its sessions; a card dragged onto bare canvas
// is loose and stays where it was dropped. Every other session falls into the
// pile the chosen grouping gives it: by org (the role it works for, else its
// repository, with each role under whoever it reports to), or by repository,
// state, agent, model, last activity, task or branch.
//
// Pure: the page hands in rows and the saved arrangement, and gets back what
// to draw. Edits return a new arrangement for clientState.ui.session_map.
import type { WorkState } from "@codecast/shared/contracts";

/** What the person arranged, synced across their devices (clientState.ui.session_map). */
export type SessionMapLayout = {
  /** Piles they made, by id: a title and the sessions in it, in order. */
  piles?: Record<string, { title: string; ids: string[] }>;
  /** Where each pile, person and loose card sits, by node id. Absent: the default spot. */
  pos?: Record<string, [number, number]>;
  /** Sessions pulled out of every pile onto bare canvas. */
  loose?: string[];
  /** Piles drawn as a closed stack. */
  folded?: string[];
  /** Piles that show their settled sessions too (they fold into one tile otherwise). */
  settledOpen?: string[];
};

export type GroupBy = "org" | "repo" | "state" | "agent" | "model" | "day" | "task" | "branch";
export type SortBy = "urgency" | "recent" | "oldest" | "title" | "messages";
/** How piles line up on the shelves; "natural" follows the grouping's own order (states, days). */
export type PileOrder = "natural" | "urgency" | "size" | "name" | "recent";
export type Since = "1d" | "7d" | "30d" | "all";
/** How the map is sliced, sorted and filtered (clientState.ui.session_map_view). */
export type SessionMapView = { group?: GroupBy; sort?: SortBy; order?: PileOrder; since?: Since; hiddenStates?: WorkState[]; hiddenAgents?: string[] };

export const GROUPS: { id: GroupBy; label: string }[] = [
  { id: "org", label: "Org" }, { id: "repo", label: "Repository" }, { id: "state", label: "State" }, { id: "agent", label: "Agent" },
  { id: "model", label: "Model" }, { id: "day", label: "Last active" }, { id: "task", label: "Task" }, { id: "branch", label: "Branch" },
];
export const SORTS: { id: SortBy; label: string }[] = [
  { id: "urgency", label: "Needs you first" }, { id: "recent", label: "Recently active" }, { id: "oldest", label: "Least recently active" },
  { id: "title", label: "Title" }, { id: "messages", label: "Most messages" },
];
export const ORDERS: { id: PileOrder; label: string }[] = [
  { id: "natural", label: "Grouping's order" }, { id: "urgency", label: "Needs you first" }, { id: "size", label: "Largest first" },
  { id: "name", label: "Name" }, { id: "recent", label: "Recently active" },
];
export const SINCES: { id: Since; label: string; ms: number }[] = [
  { id: "1d", label: "Last day", ms: 86_400_000 }, { id: "7d", label: "Last week", ms: 7 * 86_400_000 },
  { id: "30d", label: "Last month", ms: 30 * 86_400_000 }, { id: "all", label: "Any time", ms: Infinity },
];

export type MapSession = {
  id: string;
  title: string;
  state: WorkState;
  updated_at: number;
  agent_type: string;
  /** What it says it is doing (its pinned state line), else its idle summary. */
  line?: string | null;
  roleId?: string | null;
  /** Where it runs: the repository's name. */
  repo: string;
  workers: number;
  model?: string | null;
  messages?: number;
  branch?: string | null;
  task?: { shortId: string; title: string } | null;
};

export type MapRole = {
  id: string;
  name: string;
  handle: string;
  avatar?: string | null;
  /** What its standing agent says it is working on (its pinned state line). */
  line?: string | null;
  /** Its short id (role-12), for its page. */
  shortId?: string;
  /** The node it reports to: "person:<id>" or "role:<id>"; absent when unknown (a role from another workspace). */
  parent?: string;
};

export type MapPerson = { id: string; name: string; image?: string; presence?: "online" | "away" | "offline" };

export type PileKind = "role" | "repo" | "custom" | "group";
export type Pile = {
  id: string;
  kind: PileKind;
  title: string;
  role?: MapRole;
  /** Shown as cards, needs-input first. */
  active: MapSession[];
  /** Done and idle, folded into one tile unless opened. */
  settled: MapSession[];
  folded: boolean;
  settledOpen: boolean;
  /** Its place in the grouping's own order (states in urgency order, newest day first). */
  rank: number;
};

export const CARD = { w: 440, h: 340, gap: 16 } as const;
export const PILE = { pad: 16, head: 52, deckW: 472, deckH: 200, cols: 10 } as const;
export const PERSON = { w: 320, h: 96 } as const;
/** The map's quiet border: card edges, control frames, rules. */
export const HAIRLINE = "color-mix(in srgb, var(--sol-border) 40%, transparent)";
const LEVEL_GAP = 160;
const SIBLING_GAP = 96;
const SHELF_GAP = 140;

export const STATE_ORDER: WorkState[] = ["needs_input", "working", "dormant", "done", "idle"];
const SETTLED = new Set<WorkState>(["done", "idle"]);
const rank = new Map(STATE_ORDER.map((s, i) => [s, i]));
const byUrgency = (a: MapSession, b: MapSession) => (rank.get(a.state)! - rank.get(b.state)!) || b.updated_at - a.updated_at;
const SORT_FNS: Record<SortBy, (a: MapSession, b: MapSession) => number> = {
  urgency: byUrgency,
  recent: (a, b) => b.updated_at - a.updated_at,
  oldest: (a, b) => a.updated_at - b.updated_at,
  title: (a, b) => a.title.localeCompare(b.title),
  messages: (a, b) => (b.messages ?? 0) - (a.messages ?? 0) || b.updated_at - a.updated_at,
};
export const STATE_TITLE: Record<WorkState, string> = { needs_input: "Needs input", working: "Working", dormant: "Dormant", done: "Done", idle: "Idle" };
const DAY_BUCKETS = [
  { key: "today", title: "Today", ms: 86_400_000 }, { key: "week", title: "This week", ms: 7 * 86_400_000 },
  { key: "month", title: "This month", ms: 30 * 86_400_000 }, { key: "older", title: "Older", ms: Infinity },
];

/** The pile a session falls into under a grouping that is not the org: its key, title and place in order. */
function groupOf(s: MapSession, group: Exclude<GroupBy, "org" | "repo">, now: number): { key: string; title: string; rank: number } {
  switch (group) {
    case "state": return { key: s.state, title: STATE_TITLE[s.state], rank: rank.get(s.state)! };
    case "agent": return { key: s.agent_type, title: s.agent_type, rank: 0 };
    case "model": return s.model ? { key: s.model, title: s.model, rank: 0 } : { key: "", title: "No model", rank: 1 };
    case "task": return s.task ? { key: s.task.shortId, title: `${s.task.shortId} ${s.task.title}`, rank: 0 } : { key: "", title: "No task", rank: 1 };
    case "branch": return s.branch ? { key: s.branch, title: s.branch, rank: 0 } : { key: "", title: "No branch", rank: 1 };
    case "day": {
      const i = DAY_BUCKETS.findIndex((b) => now - s.updated_at < b.ms);
      return { key: DAY_BUCKETS[i].key, title: DAY_BUCKETS[i].title, rank: i };
    }
  }
}

export const rolePileId = (roleId: string) => `pile:role:${roleId}`;
export const repoPileId = (repo: string) => `pile:repo:${repo}`;
export const customPileId = (key: string) => `pile:c:${key}`;
export const groupPileId = (group: GroupBy, key: string) => `pile:g:${group}:${key}`;
export const personNodeId = (userId: string) => `person:${userId}`;
export const cardNodeId = (sessionId: string) => `s:${sessionId}`;
export const SETTLED_TILE = "settled";

/** The repository a session runs in, as a short name: its remote's repo, else its checkout's folder. */
export function repoOf(s: { git_remote_url?: string | null; git_root?: string | null; project_path?: string | null }): string {
  const remote = s.git_remote_url?.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
  if (remote) return remote;
  const path = (s.git_root || s.project_path || "").replace(/\/+$/, "");
  return path.split("/").pop() || "Elsewhere";
}

/** Every pile, with each session in exactly one place (a pile or loose). */
export function buildPiles(sessions: MapSession[], roles: MapRole[], layout: SessionMapLayout, view: SessionMapView = {}, now = Date.now()): { piles: Pile[]; loose: MapSession[] } {
  const group = view.group ?? "org";
  const sort = SORT_FNS[view.sort ?? "urgency"];
  // Grouped by state, a pile of done sessions is the point, not something to fold away.
  const split = group !== "state";
  const folded = new Set(layout.folded ?? []);
  const settledOpen = new Set(layout.settledOpen ?? []);
  const looseIds = new Set(layout.loose ?? []);
  const custom = new Map<string, string>();
  for (const [key, p] of Object.entries(layout.piles ?? {})) for (const id of p.ids) if (!custom.has(id)) custom.set(id, customPileId(key));

  const members = new Map<string, MapSession[]>();
  const meta = new Map<string, { title: string; rank: number }>();
  const add = (pileId: string, s: MapSession) => { const l = members.get(pileId); if (l) l.push(s); else members.set(pileId, [s]); };
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const loose: MapSession[] = [];
  for (const s of sessions) {
    const c = custom.get(s.id);
    if (c) add(c, s);
    else if (looseIds.has(s.id)) loose.push(s);
    else if (group === "org" && s.roleId && roleById.has(s.roleId)) add(rolePileId(s.roleId), s);
    else if (group === "org" || group === "repo") add(repoPileId(s.repo), s);
    else {
      const g = groupOf(s, group, now);
      const id = groupPileId(group, g.key);
      if (!meta.has(id)) meta.set(id, g);
      add(id, s);
    }
  }

  const make = (id: string, kind: PileKind, title: string, rankInOrder: number, role?: MapRole): Pile => {
    const all = (members.get(id) ?? []).sort(sort);
    const settled = split ? all.filter((s) => SETTLED.has(s.state)) : [];
    return { id, kind, title, role, active: split ? all.filter((s) => !SETTLED.has(s.state)) : all, settled, folded: folded.has(id), settledOpen: settledOpen.has(id), rank: rankInOrder };
  };
  const piles: Pile[] = [];
  // Under the org, every role keeps its pile even when empty: the org's shape is the point.
  if (group === "org") for (const r of roles) piles.push(make(rolePileId(r.id), "role", r.name, 0, r));
  for (const [key, p] of Object.entries(layout.piles ?? {})) piles.push(make(customPileId(key), "custom", p.title, -1));
  for (const id of members.keys()) {
    if (id.startsWith("pile:repo:")) piles.push(make(id, "repo", id.slice("pile:repo:".length), 0));
    else if (id.startsWith("pile:g:")) { const m = meta.get(id)!; piles.push(make(id, "group", m.title, m.rank)); }
  }
  return { piles, loose };
}

/** How many cards a pile shows: its active ones, its settled ones when open, else one settled tile. */
export function pileCards(p: Pile): { sessions: MapSession[]; settledTile: number } {
  if (p.settledOpen) return { sessions: [...p.active, ...p.settled], settledTile: 0 };
  return { sessions: p.active, settledTile: p.settled.length };
}

/** A pile's size on the canvas. */
export function pileSize(p: Pile): { w: number; h: number } {
  if (p.folded) return { w: PILE.deckW, h: PILE.deckH };
  const { sessions, settledTile } = pileCards(p);
  const n = sessions.length + (settledTile ? 1 : 0);
  // A card is a little wider than tall, so this keeps a big pile near square.
  const cols = Math.max(1, Math.min(PILE.cols, Math.ceil(Math.sqrt(n * 0.77))));
  const rows = Math.max(1, Math.ceil(n / cols));
  return {
    w: PILE.pad * 2 + cols * CARD.w + (cols - 1) * CARD.gap,
    h: PILE.head + PILE.pad + (n ? rows * CARD.h + (rows - 1) * CARD.gap : 34) + PILE.pad,
  };
}

/** Where card `i` sits inside its pile. */
export function cardSlot(p: Pile, i: number): { x: number; y: number } {
  const w = pileSize(p).w;
  const cols = Math.max(1, Math.round((w - PILE.pad * 2 + CARD.gap) / (CARD.w + CARD.gap)));
  return { x: PILE.pad + (i % cols) * (CARD.w + CARD.gap), y: PILE.head + Math.floor(i / cols) * (CARD.h + CARD.gap) };
}

type Box = { id: string; w: number; h: number };

/**
 * The default spot for every pile and person: the org as a tree on top (people,
 * then the roles under whoever they report to), and every other pile on shelves
 * below it, busiest first. A saved spot always wins over this.
 */
export function defaultPositions(piles: Pile[], people: MapPerson[], roles: MapRole[], loose: MapSession[], order: PileOrder = "urgency"): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  const size = new Map<string, { w: number; h: number }>();
  for (const p of piles) size.set(p.id, pileSize(p));
  for (const u of people) size.set(personNodeId(u.id), { w: PERSON.w, h: PERSON.h });

  // The tree: a node's children are the roles that report to it.
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const r of roles) {
    if (!r.parent || !size.has(r.parent)) continue;
    const id = rolePileId(r.id);
    const list = children.get(r.parent) ?? [];
    list.push(id);
    children.set(r.parent, list);
    hasParent.add(id);
  }
  const roots = [
    ...people.map((u) => personNodeId(u.id)).filter((id) => children.has(id)),
    ...roles.map((r) => rolePileId(r.id)).filter((id) => !hasParent.has(id) && (children.has(id) || hasSessions(piles, id))),
  ];
  const width = new Map<string, number>();
  const measure = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const kids = children.get(id) ?? [];
    const kidsW = kids.reduce((sum, k, i) => sum + measure(k, seen) + (i ? SIBLING_GAP : 0), 0);
    const w = Math.max(size.get(id)!.w, kidsW);
    width.set(id, w);
    return w;
  };
  const place = (id: string, left: number, top: number, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    const w = width.get(id) ?? size.get(id)!.w;
    const s = size.get(id)!;
    out[id] = { x: left + (w - s.w) / 2, y: top };
    const kids = children.get(id) ?? [];
    const kidsW = kids.reduce((sum, k, i) => sum + (width.get(k) ?? 0) + (i ? SIBLING_GAP : 0), 0);
    let x = left + (w - kidsW) / 2;
    for (const k of kids) { place(k, x, top + s.h + LEVEL_GAP, seen); x += (width.get(k) ?? 0) + SIBLING_GAP; }
  };
  let x = 0;
  let orgBottom = 0;
  const measured = new Set<string>();
  const placed = new Set<string>();
  for (const r of roots) {
    if (measured.has(r)) continue;
    const w = measure(r, measured);
    place(r, x, 0, placed);
    x += w + SIBLING_GAP * 2;
  }
  for (const id of placed) orgBottom = Math.max(orgBottom, out[id].y + size.get(id)!.h);
  const orgWidth = Math.max(x - SIBLING_GAP * 2, 0);

  // Shelves: everything not on the tree, in the chosen order, packed left to right.
  const rest: Box[] = piles
    .filter((p) => !out[p.id])
    .sort(PILE_ORDER[order])
    .map((p) => ({ id: p.id, ...size.get(p.id)! }));
  const shelfW = Math.max(orgWidth, 9000);
  let sx = 0;
  let sy = placed.size ? orgBottom + SHELF_GAP * 2 : 0;
  let rowH = 0;
  for (const b of rest) {
    if (sx > 0 && sx + b.w > shelfW) { sx = 0; sy += rowH + SHELF_GAP; rowH = 0; }
    out[b.id] = { x: sx, y: sy };
    sx += b.w + SHELF_GAP;
    rowH = Math.max(rowH, b.h);
  }
  // Loose cards with no saved spot line up under the shelves.
  const ly = sy + rowH + SHELF_GAP;
  loose.forEach((s, i) => { out[cardNodeId(s.id)] = { x: (i % 8) * (CARD.w + CARD.gap), y: ly + Math.floor(i / 8) * (CARD.h + CARD.gap) }; });
  return out;
}

function hasSessions(piles: Pile[], id: string): boolean {
  const p = piles.find((x) => x.id === id);
  return !!p && p.active.length + p.settled.length > 0;
}

/** How much a pile wants attention: what waits on a person counts most. */
function weight(p: Pile): number {
  let w = 0;
  for (const s of p.active) w += s.state === "needs_input" ? 1000 : s.state === "working" ? 100 : 10;
  return w + p.settled.length;
}
const sizeOf = (p: Pile) => p.active.length + p.settled.length;
const newest = (p: Pile) => Math.max(0, ...p.active.map((s) => s.updated_at), ...p.settled.map((s) => s.updated_at));
const PILE_ORDER: Record<PileOrder, (a: Pile, b: Pile) => number> = {
  natural: (a, b) => a.rank - b.rank || weight(b) - weight(a),
  urgency: (a, b) => weight(b) - weight(a),
  size: (a, b) => sizeOf(b) - sizeOf(a),
  name: (a, b) => a.title.localeCompare(b.title),
  recent: (a, b) => newest(b) - newest(a),
};
/** The shelf order a grouping reads best in when the person has not chosen one. */
export const defaultOrder = (group: GroupBy): PileOrder => (group === "state" || group === "day" ? "natural" : "urgency");

// ---------------------------------------------------------------- edits

const without = (list: string[] | undefined, ids: readonly string[]) => (list ?? []).filter((x) => !ids.includes(x));
const keyOf = (pileId: string) => pileId.startsWith("pile:c:") ? pileId.slice("pile:c:".length) : null;

/** Take sessions out of every custom pile and off the loose list; drops custom piles left empty. */
function detach(layout: SessionMapLayout, ids: readonly string[]): SessionMapLayout {
  const piles: NonNullable<SessionMapLayout["piles"]> = {};
  const pos = { ...(layout.pos ?? {}) };
  for (const [k, p] of Object.entries(layout.piles ?? {})) {
    const left = without(p.ids, ids);
    if (left.length) piles[k] = { ...p, ids: left };
    else delete pos[customPileId(k)];
  }
  for (const id of ids) delete pos[cardNodeId(id)];
  return { ...layout, piles, pos, loose: without(layout.loose, ids) };
}

/**
 * Move sessions into a pile. Into a custom pile: they join it. Into a role or
 * repo pile: they leave any custom pile and go back to where they belong by
 * default, which is that pile only when it is theirs (a session cannot be
 * filed under a role it does not work for).
 */
export function moveToPile(layout: SessionMapLayout, ids: readonly string[], pileId: string): SessionMapLayout {
  const next = detach(layout, ids);
  const key = keyOf(pileId);
  if (key && layout.piles?.[key]) next.piles![key] = { ...layout.piles[key], ids: [...(next.piles![key]?.ids ?? []), ...ids] };
  return next;
}

export function makeLoose(layout: SessionMapLayout, drops: { id: string; x: number; y: number }[]): SessionMapLayout {
  const ids = drops.map((d) => d.id);
  const next = detach(layout, ids);
  next.loose = [...(next.loose ?? []), ...ids];
  for (const d of drops) next.pos![cardNodeId(d.id)] = [Math.round(d.x), Math.round(d.y)];
  return next;
}

/** A new pile of these sessions at `at`; `stack` draws it closed, as a deck. */
export function createPile(layout: SessionMapLayout, title: string, ids: readonly string[], at: { x: number; y: number }, key: string, stack = false): SessionMapLayout {
  const next = detach(layout, ids);
  next.piles![key] = { title, ids: [...ids] };
  next.pos![customPileId(key)] = [Math.round(at.x), Math.round(at.y)];
  if (stack) next.folded = [...(next.folded ?? []), customPileId(key)];
  return next;
}

/** The size a new pile of `n` sessions takes (a deck when stacked). */
export function newPileSize(n: number, stack: boolean): { w: number; h: number } {
  const ids = Array.from({ length: n }, (_, i) => ({ id: String(i), title: "", state: "working" as const, updated_at: 0, agent_type: "", repo: "", workers: 0 }));
  return pileSize({ id: "", kind: "custom", title: "", active: ids, settled: [], folded: stack, settledOpen: false, rank: 0 });
}

/**
 * The open spot nearest `near` where a box of `size` overlaps none of `taken`:
 * rings of candidates around it, nearest first, so a new pile lands beside
 * the cards it came from instead of on top of their old pile.
 */
export function freeSpot(taken: { x: number; y: number; w: number; h: number }[], size: { w: number; h: number }, near: { x: number; y: number }): { x: number; y: number } {
  const gap = SHELF_GAP / 2;
  const clear = (x: number, y: number) => taken.every((t) => x + size.w + gap <= t.x || t.x + t.w + gap <= x || y + size.h + gap <= t.y || t.y + t.h + gap <= y);
  const step = 160;
  for (let ring = 0; ring <= 80; ring++) {
    const spots: { x: number; y: number; d: number }[] = [];
    for (let i = -ring; i <= ring; i++) for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) spots.push({ x: near.x + dx * step, y: near.y + dy * step, d: Math.hypot(dx, dy) });
    spots.sort((a, b) => a.d - b.d);
    const hit = spots.find((p) => clear(p.x, p.y));
    if (hit) return { x: Math.round(hit.x), y: Math.round(hit.y) };
  }
  return near;
}

/** Fold every given pile into a stack, or spread them all. */
export function setFolded(layout: SessionMapLayout, pileIds: readonly string[], fold: boolean): SessionMapLayout {
  const rest = (layout.folded ?? []).filter((id) => !pileIds.includes(id));
  return { ...layout, folded: fold ? [...rest, ...pileIds] : rest };
}

export function renamePile(layout: SessionMapLayout, pileId: string, title: string): SessionMapLayout {
  const key = keyOf(pileId);
  if (!key || !layout.piles?.[key] || !title.trim()) return layout;
  return { ...layout, piles: { ...layout.piles, [key]: { ...layout.piles[key], title: title.trim() } } };
}

/** Undo a custom pile: its sessions go back to their role or repo pile. */
export function dissolvePile(layout: SessionMapLayout, pileId: string): SessionMapLayout {
  const key = keyOf(pileId);
  if (!key || !layout.piles?.[key]) return layout;
  return detach(layout, layout.piles[key].ids);
}

export function placeNodes(layout: SessionMapLayout, moves: { id: string; x: number; y: number }[]): SessionMapLayout {
  const pos = { ...(layout.pos ?? {}) };
  for (const m of moves) pos[m.id] = [Math.round(m.x), Math.round(m.y)];
  return { ...layout, pos };
}

export function toggleIn(layout: SessionMapLayout, field: "folded" | "settledOpen", pileId: string): SessionMapLayout {
  const list = layout[field] ?? [];
  return { ...layout, [field]: list.includes(pileId) ? list.filter((x) => x !== pileId) : [...list, pileId] };
}

/** Back to the default spots; piles and loose cards stay what they are. */
export function tidy(layout: SessionMapLayout): SessionMapLayout {
  return { ...layout, pos: {} };
}
