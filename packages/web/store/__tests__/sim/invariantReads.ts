// The invariant catalog's reads (docs/architecture/multiplayer-sim-harness.md,
// section 3.7): the structural view a check reads the world through, and the
// helpers the rules share. sim/invariants.ts holds the rules; this file holds
// no rule of its own.
//
// A check reads the world through a small structural view (InvariantWorld,
// InvariantWindow) that sim/world.ts and sim/window.ts satisfy, so neither
// file is a dependency here. Window state is read inside the window's own
// turn (`run`), because the store's placement memos and the sync code reach
// the store through the facade.
import { isSessionOwner } from "@codecast/convex/convex/sessionOwners";
import { parseChatMentionClientId } from "@codecast/convex/convex/lib/chatWakeIds";
import { CHURN_ONLY_FIELDS, PAYLOAD_DENYLIST } from "@codecast/convex/convex/syncLog";
import type { SimBackend } from "@codecast/convex/convex/simBackend.testing";
import { canonical } from "@codecast/shared/contracts/orgChange";
import { syncLogScopeMetaKey } from "../../inboxStore";
import { REGISTERED_FEEDS, REPLICATION_CLASSIFICATION } from "../../clientSyncRegistry";
import { isConvexId } from "../../../lib/entityLinks";
import type { FailureContext } from "./report";
import type { SimLabels } from "./labels";
import type { SimStore } from "./realm";

// ── The view a check reads ──────────────────────────────────────────────────

/** One browser window, as the checks see it (sim/window.ts SimWindow). */
export interface InvariantWindow {
  readonly name: string;
  readonly user: { readonly userId: string };
  readonly role: "host" | "follower";
  readonly store: SimStore;
  /** One turn of this window (realm.runInWindow). */
  run<T>(fn: () => T | Promise<T>): Promise<T>;
  /** The engine outbox this window still holds, by entry id. Absent: INV-outbox skips the window. */
  readonly outbox?: ReadonlyMap<string, { id: string; action: string; args?: unknown }>;
  /** Re-runs every feeder the window mounted, once, against the server as it stands now. */
  refeed?(only?: readonly string[]): Promise<void>;
  /**
   * Hands every write the window's IDB tee sees (`_setIDBWrite`) to `fn` until
   * the returned function is called. Absent: INV-fixpoint falls back to store
   * notifications, which syncTransaction folds per turn, so a write undone
   * inside the same turn goes unseen.
   */
  onWrite?(fn: (patches: readonly StorePatch[], state: any) => void): () => void;
  /**
   * Registry keys the window feeds beyond the inbox base: live feeds
   * (applyCollectionFeed) and bootstrap floors. A rule comparing a whole
   * collection against the server runs only on the ones fed here.
   */
  readonly feeds?: ReadonlySet<string>;
}

/** One origin: a host window and its followers (sim/device.ts SimDevice). */
export interface InvariantDevice {
  readonly host: InvariantWindow;
  readonly followers: readonly InvariantWindow[];
}

/** The world as the checks see it (sim/world.ts SimWorld). */
export interface InvariantWorld {
  readonly backend: SimBackend;
  readonly labels: SimLabels;
  readonly devices: readonly InvariantDevice[];
}

export type Row = Record<string, unknown>;

/** One write as the engine middleware hands it to the IDB tee. */
export interface StorePatch {
  op: string;
  path: readonly (string | number)[];
}

/** One broken rule, as the check saw it. `row` is the pair report.ts diffs. */
export interface Violation {
  message: string;
  row?: NonNullable<FailureContext["row"]>;
}

/** "settle": the full rule, at every settle and at the end. "always": the cheap half, after each delivery. */
export type CheckMode = "settle" | "always";

export interface Invariant {
  id: string;
  meaning: string;
  /** Store keys this rule compares against server truth (the coverage guard reads it). */
  keys: readonly string[];
  /** "window": checked once per window. "world": once per check, with no window. */
  on: "window" | "world";
  /** Also runs in "always" mode, where the check gets mode "always" and runs its cheap half. */
  always?: boolean;
  /** Skip a window this rule does not apply to. */
  when?: (w: InvariantWindow) => boolean;
  check(world: InvariantWorld, w: InvariantWindow | null, mode: CheckMode): Promise<Violation[]>;
}

export interface InvariantFailure {
  invariant: { id: string; meaning: string };
  window?: NonNullable<FailureContext["window"]>;
  message: string;
  row?: NonNullable<FailureContext["row"]>;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

export const asUser = (world: InvariantWorld, userId: string) => world.backend.clientFor({ kind: "user", userId });
export const db = (world: InvariantWorld) => world.backend.db;
export const userOf = (w: InvariantWindow) => w.user.userId;
export const tableRows = (world: InvariantWorld, table: string): Row[] => db(world)._tables[table] ?? [];

export async function serverRow(world: InvariantWorld, id: string): Promise<Row | null> {
  if (!isConvexId(id)) return null;
  return (await db(world).get(id)) ?? null;
}

// How the window's sync-log cursors differ from its principal's heads: a held
// scope whose cursor is not at its head (`held`), or a cursor for a scope not
// held. Empty when the window has caught up to everything the server logged.
export async function cursorLag(world: InvariantWorld, w: InvariantWindow): Promise<{ message: string; held: boolean }[]> {
  const res: any = await asUser(world, userOf(w)).query("syncLog:getHeads", {});
  const heads = new Map<string, number>((res?.heads ?? []).map((h: any) => [h.scope_key, h.position]));
  const meta = w.store.getState().syncMeta as Record<string, { cursor?: number }>;
  const out: { message: string; held: boolean }[] = [];
  for (const [scope, head] of heads) {
    const cursor = meta[syncLogScopeMetaKey(scope)]?.cursor;
    if (cursor !== head) out.push({ message: `scope ${scope}: cursor ${cursor ?? "(none)"}, head ${head}`, held: true });
  }
  const prefix = syncLogScopeMetaKey("");
  for (const [k, v] of Object.entries(meta)) {
    if (!k.startsWith(prefix) || v?.cursor === undefined) continue;
    const scope = k.slice(prefix.length);
    if (!heads.has(scope)) out.push({ message: `scope ${scope} is not held, yet its cursor is ${v.cursor}`, held: false });
  }
  return out;
}

// The scope a window's inbox shows: "mine", or "team:<id>" in team mode.
export function teamOf(state: any): string | null {
  const ui = state.clientState?.ui;
  return ui?.inbox_scope === "team" && ui?.active_team_id ? String(ui.active_team_id) : null;
}
export const scopeOf = (state: any) => {
  const team = teamOf(state);
  return team ? `team:${team}` : "mine";
};

// Canonical JSON that also sees inside Sets and Maps (canonical alone writes them as {}).
export function stable(value: unknown): string {
  return canonical(JSON.parse(JSON.stringify(value ?? null, (_k, v) =>
    v instanceof Set ? [...v].sort() : v instanceof Map ? Object.fromEntries(v) : v)));
}

const ID_IN_KEY = /[a-z0-9]{32}/;
export const firstId = (key: string) => key.match(ID_IN_KEY)?.[0] ?? key;
// A store collection's rows live in a server table of the same name, but for the inbox.
const SERVER_TABLE: Record<string, string> = { sessions: "conversations", conversations: "conversations" };
export const serverTableOf = (storeKey: string) => SERVER_TABLE[storeKey] ?? storeKey;

export const preview = (v: unknown, max = 160) => {
  const s = stable(v);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
};

// The fields a server row and its replica must agree on: the ones both carry,
// minus the payload denylist (never shipped) and the churn-only fields (not
// on the log, so a replica may hold an older value at quiescence).
export function sharedFields(table: string, server: Row, replica: Row): [Row, Row] {
  const deny = PAYLOAD_DENYLIST[table];
  const churn = CHURN_ONLY_FIELDS[table];
  const s: Row = {};
  const r: Row = {};
  for (const k of Object.keys(server)) {
    if (!(k in replica) || deny?.has(k) || churn?.has(k)) continue;
    s[k] = server[k];
    r[k] = replica[k];
  }
  return [s, r];
}

export const MAX_ROWS_PER_CHECK = 5;

export async function asyncFilter<T>(items: readonly T[], keep: (item: T) => Promise<boolean>): Promise<T[]> {
  const kept = await Promise.all(items.map(keep));
  return items.filter((_, i) => kept[i]);
}

// getInboxSessionsByIds' admission: the runner, or an owner (session_owners).
export async function servesById(world: InvariantWorld, id: string, userId: string): Promise<boolean> {
  const conv = await serverRow(world, id);
  if (!conv) return true; // gone: the byIds pass must prune it
  return conv.user_id === userId || isSessionOwner({ db: db(world) }, id as any, userId as any);
}

// ── INV-fixpoint ────────────────────────────────────────────────────────────

/** Store keys the fixpoint pass may move without it counting as a patch. */
export const FIXPOINT_BOOKKEEPING: ReadonlySet<string> = new Set(["syncMeta", "syncProgress"]);
// The window feeds whose result moves with the clock alone and which
// production re-runs at the current epoch without a data change (window.ts
// startHost): the liveness overlays (the digest compare's stale-payload
// probe) and the base lists, whose working-set windows are time-bounded (the
// recovery poll's `_probe` query in useSyncInboxSessions).
export const EPOCH_FEEDS = ["liveness", "teamLiveness", "inbox", "team"] as const;

/**
 * Keys a window can feed from a real feeder, and so the fixpoint pass
 * compares whenever one is mounted: the inbox base list, the chat page
 * (ingestChatPage) and every registered feed (applyCollectionFeed).
 */
export const FIXPOINT_FED_KEYS: readonly string[] = [
  ...new Set(["sessions", "liveInboxIdList", "chatAuthors", "chatReactions", ...Object.values(REGISTERED_FEEDS)]),
];

// Every persisted store key, the ones a window's IDB tee would report a patch for.
const PATCHABLE_KEYS = Object.keys(REPLICATION_CLASSIFICATION).filter((k) => !FIXPOINT_BOOKKEEPING.has(k));

const PATCHABLE = new Set(PATCHABLE_KEYS);

// Where a write landed, `key` or `key[row]`, and what it did there.
export function writeOf(p: StorePatch): [where: string, what: string] | null {
  const key = String(p.path[0]);
  if (!PATCHABLE.has(key)) return null;
  const where = p.path.length > 1 ? `${key}[${p.path[1]}]` : key;
  return [where, p.path.length > 2 ? `${p.op} ${p.path.slice(2).join(".")}` : p.op];
}

// The tee's view without a tee: what moved between two notified states.
export function notifiedWrites(before: any, after: any): StorePatch[] {
  const out: StorePatch[] = [];
  for (const key of PATCHABLE_KEYS) {
    if (!(key in before) && !(key in after)) continue;
    const a = before[key];
    const b = after[key];
    if (a === b) continue;
    const records = a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
    if (!records) {
      if (stable(a) !== stable(b)) out.push({ op: "replace", path: [key] });
      continue;
    }
    for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[sub];
      const y = b[sub];
      if (x === y || stable(x) === stable(y)) continue;
      if (!(x && y && typeof x === "object" && typeof y === "object")) {
        out.push({ op: sub in b ? (sub in a ? "replace" : "add") : "remove", path: [key, sub] });
        continue;
      }
      // Both sides hold the row: name the fields that moved.
      for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (stable(x[f]) !== stable(y[f])) out.push({ op: f in y ? (f in x ? "replace" : "add") : "remove", path: [key, sub, f] });
      }
    }
  }
  return out;
}

// ── INV-sessions-mine ───────────────────────────────────────────────────────

export const placementOf = (p: { bucket: string; work_state?: string; below_fold?: boolean }) =>
  `${p.bucket}/${p.work_state ?? "-"}/${p.below_fold ? 1 : 0}`;

/**
 * The principal's canonical `mine` projection: the server's liveness payload
 * (computeSessionsLiveness, asked as the principal), whose stamps are each
 * shown row's final bucket, work state and fold, and whose envelope carries
 * the digest and tally of exactly those stamps.
 */
export async function canonicalMineProjection(world: InvariantWorld, userId: string) {
  const payload: any = await asUser(world, userId).query("conversations:sessionsLiveness", {});
  const placements = new Map<string, string>();
  for (const [id, lv] of Object.entries<any>(payload?.liveness ?? {})) {
    if (lv && lv.bucket !== undefined) placements.set(id, placementOf(lv));
  }
  return { projection: payload?.projection ?? null, placements };
}

// ── INV-workspace-rows ──────────────────────────────────────────────────────

export const WORKSPACE_TABLES = ["tasks", "docs", "plans", "projects"] as const;

// ── INV-sweep ───────────────────────────────────────────────────────────────

/**
 * teamScopeSweep over every work-item table, reporting only (apply false):
 * the stale keys it finds, the rows with no key, and any write it made. The
 * world's genesis gate and INV-sweep both read it.
 */
export async function scopeSweep(backend: SimBackend): Promise<{ findings: any[]; missing: number; writes: number }> {
  const writesBefore = backend.writes();
  const findings: any[] = [];
  let missing = 0;
  for (const table of WORKSPACE_TABLES) {
    let cursor: string | undefined;
    for (;;) {
      const page = await backend.runInternal("teamScopeSweep:sweepPage", { table, cursor, apply: false });
      findings.push(...page.findings);
      missing += page.missing;
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  return { findings, missing, writes: backend.writes() - writesBefore };
}

// ── Pending sends and chat wakes ────────────────────────────────────────────

/** The mention wakes on the server's pending_messages (their client ids: convex lib/chatWakeIds). */
export const mentionWakes = (world: InvariantWorld): Row[] => tableRows(world, "pending_messages").filter((r) => parseChatMentionClientId(r.client_id));
/** The role or session a mention wake woke. */
export const mentionTarget = (r: Row): string => parseChatMentionClientId(r.client_id)?.target ?? "";
/** The chat line a mention wake carries. */
export const mentionLine = (r: Row): string => parseChatMentionClientId(r.client_id)?.message ?? "";
export const createdAt = (r: Row) => Number(r.created_at ?? r._creationTime ?? 0);

// Rows grouped by key; the groups over `cap`, each with its rows.
export function overCap(rows: Row[], keyOf: (r: Row) => string | null, cap: number): [string, Row[]][] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null) continue;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups].filter(([, rs]) => rs.length > cap);
}

export function duplicateClientIds(rows: Row[], include: (clientId: string) => boolean): Violation[] {
  const byClientId = new Map<string, Row[]>();
  for (const r of rows) {
    const cid = typeof r.client_id === "string" ? r.client_id : null;
    if (!cid || !include(cid)) continue;
    byClientId.set(cid, [...(byClientId.get(cid) ?? []), r]);
  }
  return [...byClientId]
    .filter(([, rs]) => rs.length > 1)
    .map(([cid, rs]) => ({
      message: `client_id ${cid} is on ${rs.length} pending_messages rows: ${rs.map((r) => r._id).join(", ")}`,
      row: { table: "pending_messages", id: String(rs[1]._id), server: rs[1], replica: null },
    }));
}
