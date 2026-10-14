// The session map (/map): every live session as a card on one zoomable
// canvas, sitting in a pile. Piles come from three places, in this order of
// precedence for any one session: a pile the person made (they dragged it
// there), the role the session works for, and otherwise the repository it
// runs in. Roles keep their reporting lines to the person or role above them,
// so the org reads straight off the canvas. A card dragged onto bare canvas is
// loose and stays where it was dropped.
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
};

export type MapRole = {
  id: string;
  name: string;
  handle: string;
  avatar?: string | null;
  /** Its short id (role-12), for its page. */
  shortId?: string;
  /** The node it reports to: "person:<id>" or "role:<id>"; absent when unknown (a role from another workspace). */
  parent?: string;
};

export type MapPerson = { id: string; name: string; image?: string; presence?: "online" | "away" | "offline" };

export type PileKind = "role" | "repo" | "custom";
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
};

export const CARD = { w: 248, h: 78, gap: 10 } as const;
export const PILE = { pad: 12, head: 46, deckW: 272, deckH: 128, cols: 4 } as const;
export const PERSON = { w: 200, h: 64 } as const;
const LEVEL_GAP = 90;
const SIBLING_GAP = 56;
const SHELF_GAP = 70;

export const STATE_ORDER: WorkState[] = ["needs_input", "working", "dormant", "done", "idle"];
const SETTLED = new Set<WorkState>(["done", "idle"]);
const rank = new Map(STATE_ORDER.map((s, i) => [s, i]));
const byUrgency = (a: MapSession, b: MapSession) => (rank.get(a.state)! - rank.get(b.state)!) || b.updated_at - a.updated_at;

export const rolePileId = (roleId: string) => `pile:role:${roleId}`;
export const repoPileId = (repo: string) => `pile:repo:${repo}`;
export const customPileId = (key: string) => `pile:c:${key}`;
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
export function buildPiles(sessions: MapSession[], roles: MapRole[], layout: SessionMapLayout): { piles: Pile[]; loose: MapSession[] } {
  const folded = new Set(layout.folded ?? []);
  const settledOpen = new Set(layout.settledOpen ?? []);
  const looseIds = new Set(layout.loose ?? []);
  const custom = new Map<string, string>();
  for (const [key, p] of Object.entries(layout.piles ?? {})) for (const id of p.ids) if (!custom.has(id)) custom.set(id, customPileId(key));

  const members = new Map<string, MapSession[]>();
  const add = (pileId: string, s: MapSession) => { const l = members.get(pileId); if (l) l.push(s); else members.set(pileId, [s]); };
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const loose: MapSession[] = [];
  for (const s of sessions) {
    const c = custom.get(s.id);
    if (c) add(c, s);
    else if (looseIds.has(s.id)) loose.push(s);
    else if (s.roleId && roleById.has(s.roleId)) add(rolePileId(s.roleId), s);
    else add(repoPileId(s.repo), s);
  }

  const make = (id: string, kind: PileKind, title: string, role?: MapRole): Pile => {
    const all = (members.get(id) ?? []).sort(byUrgency);
    return { id, kind, title, role, active: all.filter((s) => !SETTLED.has(s.state)), settled: all.filter((s) => SETTLED.has(s.state)), folded: folded.has(id), settledOpen: settledOpen.has(id) };
  };
  const piles: Pile[] = [];
  // Every role keeps its pile even when empty: the org's shape is the point.
  for (const r of roles) piles.push(make(rolePileId(r.id), "role", r.name, r));
  for (const [key, p] of Object.entries(layout.piles ?? {})) piles.push(make(customPileId(key), "custom", p.title));
  const repos = [...members.keys()].filter((id) => id.startsWith("pile:repo:"));
  for (const id of repos) piles.push(make(id, "repo", id.slice("pile:repo:".length)));
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
  const cols = Math.max(1, Math.min(PILE.cols, Math.ceil(Math.sqrt(n * 1.2))));
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
export function defaultPositions(piles: Pile[], people: MapPerson[], roles: MapRole[], loose: MapSession[]): Record<string, { x: number; y: number }> {
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

  // Shelves: everything not on the tree, busiest first, packed left to right.
  const rest: Box[] = piles
    .filter((p) => !out[p.id])
    .sort((a, b) => weight(b) - weight(a))
    .map((p) => ({ id: p.id, ...size.get(p.id)! }));
  const shelfW = Math.max(orgWidth, 3200);
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

export function createPile(layout: SessionMapLayout, title: string, ids: readonly string[], at: { x: number; y: number }, key: string): SessionMapLayout {
  const next = detach(layout, ids);
  next.piles![key] = { title, ids: [...ids] };
  next.pos![customPileId(key)] = [Math.round(at.x), Math.round(at.y)];
  return next;
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
