// The invariant catalog (docs/architecture/multiplayer-sim-harness.md,
// section 3.7): the rules every settled sim world must satisfy, each checked
// against an oracle that is real code (a Convex query asked as the principal,
// a server helper, the shared projection), never a rule written here.
//
// A check reads the world through a small structural view (InvariantWorld,
// InvariantWindow) that sim/world.ts and sim/window.ts satisfy, so this file
// depends on neither. Window state is read inside the window's own turn
// (`run`), because the store's placement memos and the sync code reach the
// store through the facade.
//
// A failure is data (InvariantFailure): the DSL turns the first one into a
// report through report.ts, and the self-tests format it to prove the report
// names the invariant and the row. Nothing here throws on a violation.
//
// Server reads go through `backend.clientFor(principal)`, the same auth path
// a window uses, except where the oracle is a plain server helper
// (heldKeysFor, accessStampFor, visibleAnchorsForUser, armedTriggerKindFor),
// which is called over the db directly. Those client reads are recorded in
// backend.calls like any other call, at the same points in every replay.
import { accessStampFor, authorizedFor, heldKeysFor } from "@codecast/convex/convex/lib/accessKeys";
import { hourBucket } from "@codecast/convex/convex/lib/chatQuota";
import { armedTriggerKindFor } from "@codecast/convex/convex/dormancy";
import { visibleAnchorsForUser } from "@codecast/convex/convex/anchors";
import { isSessionOwner } from "@codecast/convex/convex/sessionOwners";
import { MENTION_WAKES_PER_SENDER_HOUR, MENTION_WAKES_PER_TARGET_HOUR } from "@codecast/convex/convex/chat";
import { CHURN_ONLY_FIELDS, PAYLOAD_DENYLIST } from "@codecast/convex/convex/syncLog";
import type { SimBackend } from "@codecast/convex/convex/simBackend.testing";
import { canonical } from "@codecast/shared/contracts/orgChange";
import { snapshotEntries } from "@platform/engine";
import { placeInboxRows, syncLogScopeMetaKey, useInboxStore } from "../../inboxStore";
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../inboxOverlays";
import {
  REGISTERED_FEEDS,
  REPLICATED_STORE_KEYS,
  REPLICATION_CLASSIFICATION,
  isReplicatedCollectionKey,
} from "../../clientSyncRegistry";
import { isConvexId } from "../../../lib/entityLinks";
import { inWorkspace } from "../../../lib/workspaceScope";
import { activeWorkspaceKeyOf } from "../../../hooks/useWorkspaceCollection";
import { applyEntityIds, catchUp, emptyIdsByCollection } from "../../../hooks/useSyncChangeFeed";
import { teamInboxArgs } from "../../../hooks/useSyncTeamInboxSessions";
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
  refeed?(): Promise<void>;
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

type Row = Record<string, unknown>;

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

const asUser = (world: InvariantWorld, userId: string) => world.backend.clientFor({ kind: "user", userId });
const db = (world: InvariantWorld) => world.backend.db;
const userOf = (w: InvariantWindow) => w.user.userId;
const tableRows = (world: InvariantWorld, table: string): Row[] => db(world)._tables[table] ?? [];

async function serverRow(world: InvariantWorld, id: string): Promise<Row | null> {
  if (!isConvexId(id)) return null;
  return (await db(world).get(id)) ?? null;
}

// The scope a window's inbox shows: "mine", or "team:<id>" in team mode.
function teamOf(state: any): string | null {
  const ui = state.clientState?.ui;
  return ui?.inbox_scope === "team" && ui?.active_team_id ? String(ui.active_team_id) : null;
}
const scopeOf = (state: any) => {
  const team = teamOf(state);
  return team ? `team:${team}` : "mine";
};

// Canonical JSON that also sees inside Sets and Maps (canonical alone writes them as {}).
function stable(value: unknown): string {
  return canonical(JSON.parse(JSON.stringify(value ?? null, (_k, v) =>
    v instanceof Set ? [...v].sort() : v instanceof Map ? Object.fromEntries(v) : v)));
}

const ID_IN_KEY = /[a-z0-9]{32}/;
const firstId = (key: string) => key.match(ID_IN_KEY)?.[0] ?? key;
// A store collection's rows live in a server table of the same name, but for the inbox.
const SERVER_TABLE: Record<string, string> = { sessions: "conversations", conversations: "conversations" };
const serverTableOf = (storeKey: string) => SERVER_TABLE[storeKey] ?? storeKey;

const preview = (v: unknown, max = 160) => {
  const s = stable(v);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
};

// The fields a server row and its replica must agree on: the ones both carry,
// minus the payload denylist (never shipped) and the churn-only fields (not
// on the log, so a replica may hold an older value at quiescence).
function sharedFields(table: string, server: Row, replica: Row): [Row, Row] {
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

const MAX_ROWS_PER_CHECK = 5;

async function asyncFilter<T>(items: readonly T[], keep: (item: T) => Promise<boolean>): Promise<T[]> {
  const kept = await Promise.all(items.map(keep));
  return items.filter((_, i) => kept[i]);
}

// getInboxSessionsByIds' admission: the runner, or an owner (session_owners).
async function servesById(world: InvariantWorld, id: string, userId: string): Promise<boolean> {
  const conv = await serverRow(world, id);
  if (!conv) return true; // gone: the byIds pass must prune it
  return conv.user_id === userId || isSessionOwner({ db: db(world) }, id as any, userId as any);
}

// ── INV-fixpoint ────────────────────────────────────────────────────────────

/** Store keys the fixpoint pass may move without it counting as a patch. */
export const FIXPOINT_BOOKKEEPING: ReadonlySet<string> = new Set(["syncMeta", "syncProgress"]);

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
function writeOf(p: StorePatch): [where: string, what: string] | null {
  const key = String(p.path[0]);
  if (!PATCHABLE.has(key)) return null;
  const where = p.path.length > 1 ? `${key}[${p.path[1]}]` : key;
  return [where, p.path.length > 2 ? `${p.op} ${p.path.slice(2).join(".")}` : p.op];
}

// The tee's view without a tee: what moved between two notified states.
function notifiedWrites(before: any, after: any): StorePatch[] {
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

const placementOf = (p: { bucket: string; work_state?: string; below_fold?: boolean }) =>
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

const WORKSPACE_TABLES = ["tasks", "docs", "plans", "projects"] as const;

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

export const MENTION_PREFIX = "chat-mention:";
// chat-mention:<message>:<target>, the client_id every mention wake carries.
export const mentionTarget = (clientId: string) => clientId.slice(MENTION_PREFIX.length).split(":")[1] ?? "";
const mentionMessage = (clientId: string) => clientId.slice(MENTION_PREFIX.length).split(":")[0] ?? "";
const createdAt = (r: Row) => Number(r.created_at ?? r._creationTime ?? 0);

// Rows grouped by key; the groups over `cap`, each with its rows.
function overCap(rows: Row[], keyOf: (r: Row) => string | null, cap: number): [string, Row[]][] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null) continue;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups].filter(([, rs]) => rs.length > cap);
}

function duplicateClientIds(rows: Row[], include: (clientId: string) => boolean): Violation[] {
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

// ── The catalog ─────────────────────────────────────────────────────────────

export const INVARIANTS: readonly Invariant[] = [
  {
    id: "INV-sessions-mine",
    meaning: "the window's mine digest, tally and placements equal the principal's canonical projection",
    keys: ["sessions", "liveInboxIdList"],
    on: "window",
    async check(world, w) {
      const { projection, placements: want } = await canonicalMineProjection(world, userOf(w!));
      if (!projection) return [{ message: "the server returned no projection for the principal" }];
      const placed = await w!.run(() => placeInboxRows(useInboxStore.getState() as any, { scope: "mine", now: Date.now() }));
      const got = new Map([...placed.placements].map(([id, p]) => [id, placementOf(p as any)]));
      const out: Violation[] = [];
      const sessions = w!.store.getState().sessions as Record<string, Row>;
      for (const id of [...new Set([...want.keys(), ...got.keys()])].sort()) {
        if (want.get(id) === got.get(id)) continue;
        out.push({
          message: `placed ${got.get(id) ?? "(absent)"}, the server places ${want.get(id) ?? "(absent)"}`,
          row: { table: "conversations", id, server: await serverRow(world, id), replica: sessions[id] ?? null },
        });
        if (out.length >= MAX_ROWS_PER_CHECK) return out;
      }
      if (placed.set_digest !== projection.set_digest) {
        out.push({ message: `digest ${placed.set_digest ?? "(none)"}, the server's is ${projection.set_digest ?? "(none)"} at epoch ${projection.epoch}` });
      }
      if (stable(placed.tally) !== stable(projection.tally)) {
        out.push({ message: `tally ${stable(placed.tally)}, the server's is ${stable(projection.tally)}` });
      }
      return out;
    },
  },
  {
    // Host against follower, not against the server: the replicated slice.
    id: "INV-followers",
    meaning: "every follower holds the host's replicated slice byte for byte",
    keys: [],
    on: "window",
    when: (w) => w.role === "follower",
    async check(world, w) {
      const host = world.devices.find((d) => d.followers.includes(w!))?.host;
      if (!host) return [{ message: `follower ${w!.name} belongs to no device` }];
      const h = snapshotEntries(host.store.getState(), REPLICATED_STORE_KEYS);
      const f = snapshotEntries(w!.store.getState(), REPLICATED_STORE_KEYS);
      const out: Violation[] = [];
      for (const key of REPLICATED_STORE_KEYS) {
        if (stable(h[key]) === stable(f[key])) continue;
        if (!isReplicatedCollectionKey(key)) {
          out.push({ message: `${key} differs from host ${host.name}: host ${preview(h[key])}, follower ${preview(f[key])}` });
          continue;
        }
        const hr = (h[key] ?? {}) as Record<string, Row>;
        const fr = (f[key] ?? {}) as Record<string, Row>;
        for (const id of new Set([...Object.keys(hr), ...Object.keys(fr)])) {
          if (stable(hr[id]) === stable(fr[id])) continue;
          out.push({
            message: `${key} row differs from host ${host.name} (server column: host, replica column: follower)`,
            row: { table: serverTableOf(key), id, server: hr[id] ?? null, replica: fr[id] ?? null },
          });
          if (out.length >= MAX_ROWS_PER_CHECK) return out;
        }
      }
      return out;
    },
  },
  {
    id: "INV-team-inbox",
    meaning: "the team slot holds exactly the server's team list for the viewer, minus the viewer's own hides",
    keys: ["teamInboxIdSnapshot"],
    on: "window",
    when: (w) => teamOf(w.store.getState()) !== null,
    async check(world, w) {
      const state = w!.store.getState();
      const team = teamOf(state)!;
      const user = userOf(w!);
      const res: any = await asUser(world, user).query("conversations:listTeamInboxSessions", teamInboxArgs(team));
      const hidden = new Set(tableRows(world, "inbox_hides").filter((h) => h.user_id === user).map((h) => String(h.conversation_id)));
      const want = new Set<string>((res?.sessions ?? []).map((s: Row) => String(s._id)).filter((id: string) => !hidden.has(id)));
      const got = state.teamInboxIds as ReadonlySet<string>;
      const out: Violation[] = [];
      for (const id of [...new Set([...want, ...got])].sort()) {
        if (want.has(id) === got.has(id)) continue;
        out.push({
          message: got.has(id) ? "the team slot holds a row the server's team list leaves out" : "the team slot lacks a row the server's team list holds",
          row: { table: "conversations", id, server: await serverRow(world, id), replica: (state.sessions as Record<string, Row>)[id] ?? null },
        });
        if (out.length >= MAX_ROWS_PER_CHECK) break;
      }
      return out;
    },
  },
  {
    id: "INV-workspace-rows",
    meaning: "the window holds no task, doc, plan or project its principal cannot read, and each one it feeds matches the server in its workspace",
    keys: [...WORKSPACE_TABLES],
    on: "window",
    always: true,
    async check(world, w, mode) {
      const user = userOf(w!);
      const ctx = { db: db(world) };
      const held = await heldKeysFor(ctx, user as any);
      const state = w!.store.getState() as any;
      const key = activeWorkspaceKeyOf(state);
      const out: Violation[] = [];
      for (const table of WORKSPACE_TABLES) {
        const replica = (state[table] ?? {}) as Record<string, Row>;
        const readable = new Map<string, Row>();
        for (const row of tableRows(world, table)) {
          if (authorizedFor(await accessStampFor(ctx, table, row), user, held)) readable.set(String(row._id), row);
        }
        // Every row the window holds must be one the principal may read,
        // whichever workspace it is filed under (the cache spans workspaces).
        for (const [id, row] of Object.entries(replica)) {
          if (!isConvexId(id) || readable.has(id)) continue;
          out.push({ message: `the window holds a ${table} row its principal cannot read`, row: { table, id, server: (await serverRow(world, id)) ?? null, replica: row } });
        }
        if (mode === "always" || !w!.feeds?.has(table)) continue;
        // A collection the window feeds holds, in the active workspace, the
        // same rows as the server, field for field.
        for (const [id, row] of readable) {
          if (!inWorkspace(row as any, key)) continue;
          const mine = replica[id];
          if (!mine) {
            out.push({ message: `the window lacks a readable ${table} row in its workspace ${key}`, row: { table, id, server: row, replica: null } });
            continue;
          }
          const [s, r] = sharedFields(table, row, mine);
          if (stable(s) !== stable(r)) out.push({ message: `a ${table} row disagrees with the server`, row: { table, id, server: row, replica: mine } });
        }
        if (out.length >= MAX_ROWS_PER_CHECK) break;
      }
      return out.slice(0, MAX_ROWS_PER_CHECK);
    },
  },
  {
    id: "INV-sweep",
    meaning: "the team scope sweep finds no work item whose stored workspace key disagrees with its computed one",
    keys: [],
    on: "world",
    async check(world) {
      const { findings, missing, writes } = await scopeSweep(world.backend);
      const out: Violation[] = findings.map((f) => {
        const row = tableRows(world, f.table).find((r) => r.short_id === f.short_id || String(r._id) === f.short_id);
        return {
          message: `${f.table} stores workspace ${f.stored}, the sweep computes ${f.expected} (${f.reason})`,
          row: row ? { table: f.table, id: String(row._id), server: row, replica: null } : undefined,
        };
      });
      if (missing) out.push({ message: `${missing} work item(s) carry no stored workspace key` });
      if (writes) out.push({ message: `the sweep wrote ${writes} row(s) with apply false` });
      return out;
    },
  },
  {
    id: "INV-cursors",
    meaning: "each held sync-log scope's cursor stands at its head, and no unheld scope has a cursor",
    keys: ["syncMeta"],
    on: "window",
    async check(world, w) {
      const res: any = await asUser(world, userOf(w!)).query("syncLog:getHeads", {});
      const heads = new Map<string, number>((res?.heads ?? []).map((h: any) => [h.scope_key, h.position]));
      const meta = w!.store.getState().syncMeta as Record<string, { cursor?: number }>;
      const out: Violation[] = [];
      for (const [scope, head] of heads) {
        const cursor = meta[syncLogScopeMetaKey(scope)]?.cursor;
        if (cursor !== head) out.push({ message: `scope ${scope}: cursor ${cursor ?? "(none)"}, head ${head}` });
      }
      const prefix = syncLogScopeMetaKey("");
      for (const [k, v] of Object.entries(meta)) {
        if (!k.startsWith(prefix) || v?.cursor === undefined) continue;
        const scope = k.slice(prefix.length);
        if (!heads.has(scope)) out.push({ message: `scope ${scope} is not held, yet its cursor is ${v.cursor}` });
      }
      return out;
    },
  },
  {
    id: "INV-pending-locks",
    meaning: "no acknowledged lock survives its cursor, and no field lock outlives the settle window",
    keys: ["pending"],
    on: "window",
    async check(world, w) {
      const state = w!.store.getState() as any;
      const out: Violation[] = [];
      for (const [key, entry] of Object.entries<any>(state.pending ?? {})) {
        const [coll] = key.split(":");
        const id = firstId(key);
        const row = async () => ({ table: serverTableOf(coll), id, server: await serverRow(world, id), replica: (state[coll] ?? {})[id] ?? null });
        const acked = (entry?.ack as { s: string; p: number }[] | undefined)?.find((a) => (state.syncMeta[syncLogScopeMetaKey(a.s)]?.cursor ?? 0) >= a.p);
        if (acked) {
          out.push({ message: `lock ${key} was acknowledged at ${acked.s}@${acked.p}, which the cursor has passed`, row: await row() });
        } else if (entry?.type === "field" && typeof entry.ts === "number" && Date.now() - entry.ts > HIDDEN_OVERRIDE_SETTLE_MS) {
          out.push({ message: `lock ${key} is ${Date.now() - entry.ts}ms old, past the ${HIDDEN_OVERRIDE_SETTLE_MS}ms settle window`, row: await row() });
        }
        if (out.length >= MAX_ROWS_PER_CHECK) break;
      }
      return out;
    },
  },
  {
    id: "INV-outbox",
    meaning: "every window's engine outbox is empty once the world settles",
    keys: [],
    on: "window",
    when: (w) => w.outbox !== undefined,
    async check(_world, w) {
      return [...w!.outbox!.values()].map((e) => ({ message: `outbox still holds ${e.action} (${e.id}) ${preview(e.args)}` }));
    },
  },
  {
    id: "INV-triggers",
    meaning: "the trigger replica equals agentTasks:webList, and each conversation's armed kind matches its live triggers",
    keys: ["agentTasks"],
    on: "window",
    async check(world, w) {
      const out: Violation[] = [];
      const user = userOf(w!);
      // The denormalized armed kind, for every conversation the principal runs.
      const tasks = tableRows(world, "agent_tasks");
      for (const conv of tableRows(world, "conversations")) {
        if (conv.user_id !== user) continue;
        const want = armedTriggerKindFor(tasks.filter((t) => t.originating_conversation_id === conv._id) as any);
        const got = (conv.armed_trigger_kind as string | undefined) ?? "none";
        if (got !== want) {
          out.push({ message: `armed_trigger_kind is ${got}, its triggers make it ${want}`, row: { table: "conversations", id: String(conv._id), server: conv, replica: null } });
        }
      }
      if (!w!.feeds?.has("agentTasks")) return out;
      const list: Row[] = (await asUser(world, user).query("agentTasks:webList", {})) ?? [];
      const want = new Map(list.map((t) => [String(t._id), t]));
      const replica = (w!.store.getState() as any).agentTasks as Record<string, Row>;
      for (const id of [...new Set([...want.keys(), ...Object.keys(replica ?? {}).filter(isConvexId)])].sort()) {
        const s = want.get(id);
        const r = replica?.[id];
        if (s && r && stable(sharedFields("agent_tasks", s, r)[0]) === stable(sharedFields("agent_tasks", s, r)[1])) continue;
        out.push({ message: s && r ? "a trigger disagrees with webList" : r ? "the replica holds a trigger webList does not return" : "the replica lacks a trigger webList returns", row: { table: "agent_tasks", id, server: s ?? null, replica: r ?? null } });
        if (out.length >= MAX_ROWS_PER_CHECK) break;
      }
      return out;
    },
  },
  {
    id: "INV-pending-sends",
    meaning: "every send bubble is echoed, settled or failed, and each client_id is on at most one pending_messages row",
    keys: ["pendingMessages", "queuedMessages"],
    on: "window",
    always: true,
    async check(world, w, mode) {
      const pendingRows = tableRows(world, "pending_messages");
      // Mention wakes are INV-chat's to dedupe.
      const out = duplicateClientIds(pendingRows, (cid) => !cid.startsWith(MENTION_PREFIX));
      if (mode === "always") return out;
      const state = w!.store.getState() as any;
      const echoed = new Set(tableRows(world, "messages").map((m) => m.client_id).filter(Boolean));
      for (const [convId, bubbles] of Object.entries<any[]>(state.pendingMessages ?? {})) {
        for (const b of bubbles ?? []) {
          if (b._isLocalQueue || b._isFailed || b._isSettled || (b._clientId && echoed.has(b._clientId))) continue;
          out.push({
            message: `send ${b._clientId ?? b._id} is still in flight: not echoed, settled or failed`,
            row: { table: "conversations", id: convId, server: await serverRow(world, convId), replica: state.sessions?.[convId] ?? null },
          });
        }
      }
      // A queued text waits on a conversation; one the server no longer has would never send.
      for (const [convId, texts] of Object.entries<string[]>(state.queuedMessages ?? {})) {
        if (!texts?.length || !isConvexId(convId) || (await serverRow(world, convId))) continue;
        out.push({ message: `${texts.length} queued text(s) wait on a conversation the server no longer has`, row: { table: "conversations", id: convId, server: null, replica: state.sessions?.[convId] ?? null } });
      }
      return out.slice(0, MAX_ROWS_PER_CHECK);
    },
  },
  {
    id: "INV-chat",
    meaning: "the chat replica equals chat:listMessages, each mention wakes its target once, and the hourly wake caps hold",
    keys: ["chatMessages"],
    on: "window",
    always: true,
    async check(world, w, mode) {
      const wakes = tableRows(world, "pending_messages").filter((r) => typeof r.client_id === "string" && r.client_id.startsWith(MENTION_PREFIX));
      const out = duplicateClientIds(wakes, () => true);
      const hourOf = (r: Row) => hourBucket(createdAt(r));
      for (const [k, rs] of overCap(wakes, (r) => `${hourOf(r)} ${r.from_user_id}`, MENTION_WAKES_PER_SENDER_HOUR)) {
        out.push({ message: `${rs.length} mention wakes from one sender in hour ${k}, over the cap of ${MENTION_WAKES_PER_SENDER_HOUR}`, row: { table: "users", id: String(rs[0].from_user_id), server: null, replica: null } });
      }
      for (const [k, rs] of overCap(wakes, (r) => `${hourOf(r)} ${mentionTarget(String(r.client_id))}`, MENTION_WAKES_PER_TARGET_HOUR)) {
        const target = mentionTarget(String(rs[0].client_id));
        out.push({ message: `${rs.length} mention wakes into one target in hour ${k}, over the cap of ${MENTION_WAKES_PER_TARGET_HOUR}`, row: { table: "conversations", id: target, server: await serverRow(world, target), replica: null } });
      }
      if (mode === "always") return out;
      // The replica's page of each channel it holds equals the server's newest page.
      const replica = ((w!.store.getState() as any).chatMessages ?? {}) as Record<string, Row>;
      const byChannel = new Map<string, Row[]>();
      for (const row of Object.values(replica)) {
        if (!isConvexId(String(row._id)) || !row.channel_id) continue;
        byChannel.set(String(row.channel_id), [...(byChannel.get(String(row.channel_id)) ?? []), row]);
      }
      for (const [channel, held] of byChannel) {
        if (!(await serverRow(world, channel))) {
          for (const r of held) out.push({ message: "the replica holds a chat line in a channel the server does not have", row: { table: "chat_messages", id: String(r._id), server: await serverRow(world, String(r._id)), replica: r } });
          continue;
        }
        const page: any = await asUser(world, userOf(w!)).query("chat:listMessages", { channel_id: channel, limit: 100 });
        const rows: Row[] = page?.messages ?? [];
        const want = new Map(rows.map((r) => [String(r._id), r]));
        const oldest = page?.has_more ? Math.min(...rows.map(createdAt)) : -Infinity;
        for (const r of held) {
          if (createdAt(r) < oldest || want.has(String(r._id))) continue;
          out.push({ message: `the replica holds a chat line the channel page does not return${page?.unavailable ? " (the channel is unavailable to the principal)" : ""}`, row: { table: "chat_messages", id: String(r._id), server: await serverRow(world, String(r._id)), replica: r } });
        }
        for (const [id, s] of want) {
          const r = replica[id];
          if (r && stable(sharedFields("chat_messages", s, r)[0]) === stable(sharedFields("chat_messages", s, r)[1])) continue;
          out.push({ message: r ? "a chat line disagrees with the channel page" : "the replica lacks a chat line of the channel page", row: { table: "chat_messages", id, server: s, replica: r ?? null } });
        }
      }
      return out.slice(0, MAX_ROWS_PER_CHECK);
    },
  },
  {
    id: "INV-roles",
    meaning: "each role's mention wake counter equals the wakes enqueued for it, and listAnchors equals visibleAnchorsForUser",
    keys: ["anchors"],
    on: "window",
    async check(world, w) {
      const out: Violation[] = [];
      // The counter takeQuota keeps per target and hour, against the rows that wake it.
      const roles = new Map(tableRows(world, "org_roles").map((r) => [String(r._id), r]));
      const wakes = tableRows(world, "pending_messages").filter((r) => typeof r.client_id === "string" && r.client_id.startsWith(MENTION_PREFIX));
      for (const q of tableRows(world, "chat_agent_quota")) {
        const key = String(q.key);
        if (!key.startsWith("mention_to:")) continue;
        const roleId = key.slice("mention_to:".length);
        if (!roles.has(roleId)) continue;
        const enqueued = wakes.filter((r) => mentionTarget(String(r.client_id)) === roleId && hourBucket(createdAt(r)) === q.bucket).length;
        if (enqueued !== q.count) {
          out.push({ message: `the wake counter for hour ${q.bucket} reads ${q.count}, ${enqueued} wake(s) were enqueued`, row: { table: "org_roles", id: roleId, server: roles.get(roleId)!, replica: null } });
        }
      }
      const user = userOf(w!);
      const listed: Row[] = (await asUser(world, user).query("anchors:listAnchors", {})) ?? [];
      const visible: Row[] = await visibleAnchorsForUser({ db: db(world) }, user as any);
      const listedIds = new Set(listed.map((a) => String(a._id)));
      const visibleIds = new Set(visible.map((a) => String(a._id)));
      for (const id of new Set([...listedIds, ...visibleIds])) {
        if (listedIds.has(id) === visibleIds.has(id)) continue;
        out.push({ message: listedIds.has(id) ? "listAnchors returns an anchor the principal cannot see" : "listAnchors leaves out a visible anchor", row: { table: "anchors", id, server: await serverRow(world, id), replica: null } });
      }
      // The replica never holds an anchor its principal cannot see.
      const replica = ((w!.store.getState() as any).anchors ?? {}) as Record<string, Row>;
      for (const [id, row] of Object.entries(replica)) {
        if (!isConvexId(id) || visibleIds.has(id)) continue;
        out.push({ message: "the window holds an anchor its principal cannot see", row: { table: "anchors", id, server: await serverRow(world, id), replica: row } });
      }
      return out.slice(0, MAX_ROWS_PER_CHECK);
    },
  },
  {
    id: "INV-ping-pong",
    meaning: "agent to agent wakes per virtual hour stay under the mention caps, per sender and per target",
    keys: [],
    on: "world",
    async check(world) {
      const agentLines = new Set(tableRows(world, "chat_messages").filter((m) => m.origin === "agent").map((m) => String(m._id)));
      // From a session: a session's own send, or a mention written by an agent.
      const fromAgent = tableRows(world, "pending_messages").filter((r) =>
        r.from_conversation_id || (typeof r.client_id === "string" && r.client_id.startsWith(MENTION_PREFIX) && agentLines.has(mentionMessage(r.client_id))));
      const hourOf = (r: Row) => hourBucket(createdAt(r));
      const out: Violation[] = [];
      for (const [k, rs] of overCap(fromAgent, (r) => `${hourOf(r)} ${r.conversation_id}`, MENTION_WAKES_PER_TARGET_HOUR)) {
        const id = String(rs[0].conversation_id);
        out.push({ message: `${rs.length} agent wakes into one session in hour ${k}, over ${MENTION_WAKES_PER_TARGET_HOUR}`, row: { table: "conversations", id, server: await serverRow(world, id), replica: null } });
      }
      for (const [k, rs] of overCap(fromAgent, (r) => `${hourOf(r)} ${r.from_user_id}`, MENTION_WAKES_PER_SENDER_HOUR)) {
        out.push({ message: `${rs.length} agent wakes from one sender in hour ${k}, over ${MENTION_WAKES_PER_SENDER_HOUR}`, row: { table: "users", id: String(rs[0].from_user_id), server: null, replica: null } });
      }
      return out;
    },
  },
  {
    id: "INV-fixpoint",
    meaning: "re-running every mounted feeder, one catch-up and a byIds pass over every held id changes nothing",
    keys: FIXPOINT_FED_KEYS,
    on: "window",
    when: (w) => w.role === "host",
    async check(world, w) {
      const direct = asUser(world, userOf(w!));
      const before = w!.store.getState() as any;
      // Every write of the pass counts, the way the window's IDB tee sees it:
      // a row two feeders write two ways flaps and lands where it started. A
      // write of a whole collection is resolved to its rows against the value
      // the tap saw last.
      const writes = new Map<string, Set<string>>();
      const seen: Record<string, unknown> = { ...before };
      const record = (patches: readonly StorePatch[], state: any) => {
        for (const p of patches) {
          const key = String(p.path[0]);
          const rows = p.path.length === 1 && state ? notifiedWrites({ [key]: seen[key] }, { [key]: state[key] }) : [p];
          for (const r of rows.length ? rows : [p]) {
            const hit = writeOf(r);
            if (hit) writes.set(hit[0], (writes.get(hit[0]) ?? new Set()).add(hit[1]));
          }
          if (state) seen[key] = state[key];
        }
      };
      const untap = w!.onWrite
        ? w!.onWrite(record)
        : w!.store.subscribe((state: any, prev: any) => record(notifiedWrites(prev, state), null));
      try {
        await w!.run(async () => {
          await w!.refeed?.();
          await catchUp(direct);
          const held = emptyIdsByCollection();
          const s = useInboxStore.getState() as any;
          for (const coll of Object.keys(held) as (keyof typeof held)[]) {
            held[coll] = Object.keys(s[coll] ?? {}).filter(isConvexId);
          }
          // The inbox byIds serves the rows the principal runs or owns (its
          // contract); a teammate's row on the team board comes from the team
          // list, which the refeed re-ran.
          held.sessions = await asyncFilter(held.sessions, (id) => servesById(world, id, userOf(w!)));
          await applyEntityIds(direct, held);
        });
      } finally {
        untap();
      }
      const after = w!.store.getState() as any;
      const asRow = (v: unknown): Row | null => (v && typeof v === "object" ? (v as Row) : v === undefined || v === null ? null : { value: v });
      return [...writes].slice(0, MAX_ROWS_PER_CHECK).map(([where, what]) => {
        const [, key, sub] = where.match(/^([^[]+)(?:\[(.*)\])?$/)!;
        return {
          message: `${where} was written on a refeed: ${[...what].join(", ")}`,
          row: sub === undefined ? undefined : { table: serverTableOf(key), id: firstId(sub), server: asRow(after[key]?.[sub]), replica: asRow(before[key]?.[sub]) },
        };
      });
    },
  },
];

// ── Running the catalog ─────────────────────────────────────────────────────

export function allWindows(world: InvariantWorld): InvariantWindow[] {
  return world.devices.flatMap((d) => [d.host, ...d.followers]);
}

/**
 * Runs the catalog over the world and returns every failure, in catalog
 * order. The fixpoint pass runs last: it re-feeds the windows, and on a
 * failure its writes would otherwise reach the checks after it (a host it
 * moved no longer matches followers that nothing replicated to). "always"
 * mode runs only the rules marked always, over the windows given (the one a
 * delivery touched).
 */
export async function checkInvariants(
  world: InvariantWorld,
  opts: { mode?: CheckMode; ids?: readonly string[]; windows?: readonly InvariantWindow[] } = {},
): Promise<InvariantFailure[]> {
  const mode = opts.mode ?? "settle";
  const windows = opts.windows ?? allWindows(world);
  const failures: InvariantFailure[] = [];
  for (const inv of INVARIANTS) {
    if (opts.ids && !opts.ids.includes(inv.id)) continue;
    if (mode === "always" && !inv.always) continue;
    const invariant = { id: inv.id, meaning: inv.meaning };
    if (inv.on === "world") {
      for (const v of await inv.check(world, null, mode)) failures.push({ invariant, ...v });
      continue;
    }
    for (const w of windows) {
      if (inv.when && !inv.when(w)) continue;
      const window = windowContext(w);
      for (const v of await inv.check(world, w, mode)) failures.push({ invariant, window, ...v });
    }
  }
  return failures;
}

/** A window as a failure report names it: its name, principal and inbox scope. */
export function windowContext(w: InvariantWindow): NonNullable<FailureContext["window"]> {
  return { name: w.name, principal: userOf(w), scope: scopeOf(w.store.getState()) };
}

/** A failure as report.ts takes it, given the run's facts. */
export function failureContext(f: InvariantFailure, base: Omit<FailureContext, "invariant" | "message" | "window" | "row">): FailureContext {
  return { ...base, invariant: f.invariant, message: f.message, window: f.window, row: f.row };
}

// ── Coverage guard ──────────────────────────────────────────────────────────

/**
 * Classified store keys no invariant compares against the server, each with
 * why. A key here is still compared host against follower by INV-followers
 * when it is shared.
 */
export const NOT_COMPARED: Readonly<Record<string, string>> = {
  conversations: "the message page's meta twin, fed only by a conversation page the sim does not open",
  capabilityBindings: "fed by useSyncCapabilityState, a bespoke hook the sim does not mount",
  capabilityState: "fed by useSyncCapabilityState, a bespoke hook the sim does not mount",
  sessionDecisions: "fed by useSyncSessionDecisions; decisions reach the inbox through the liveness stamps INV-sessions-mine compares",
  buckets: "fed by useSyncBuckets, a bespoke hook the sim does not mount",
  bucketAssignments: "fed by useSyncBuckets, a bespoke hook the sim does not mount",
  comments: "fed by the conversation comment and thread hooks, which the sim does not mount",
  chatChannels: "fed by useChatSync's channel list, which the sim does not mount; the lines are compared by INV-chat",
  chatReads: "per-viewer read marks fed by useChatSync, which the sim does not mount",
  chatSlackLinks: "Slack bridge state, outside the sim",
  threadInbox: "fed by useThreadsSync, a bespoke hook the sim does not mount",
  chatRail: "a client fold over chat rows, derived at read time",
  notifications: "fed by the notification bell component, which the sim does not mount",
  clientState: "UI preferences the window's boot sets; replicated, compared host against follower",
  _lastViewedAt: "client-only visit clock, no server truth",
  _seenUpToAt: "client-only read divider, no server truth",
  _seenMessageCount: "client-only unread baseline, no server truth",
  teams: "fed by useSyncTeams, which the sim does not mount; membership is checked through cursors and workspace rows",
  teamMembers: "roster cache with no feeder the sim mounts",
  teamUnreadCount: "a sidebar badge fed by a component the sim does not mount",
  docProjectPaths: "client-side path index with no server truth",
  favorites: "fed by a sidebar component the sim does not mount",
  bookmarks: "fed by useSyncInboxSessions' bookmark query, which the sim does not mount",
  currentUser: "set by the window's boot from the world, not fed by a query the sim mounts",
  drafts: "local composer text, no server truth",
  reviewComments: "local inline review notes, no server truth",
  blockedReviveRequestedAt: "a TTL overlay the store expires lazily at the next revive; a stale entry is inert, and the placement it gates is compared by INV-sessions-mine",
  lastFocusedConversationId: "local focus, no server truth",
  recentVisits: "local history, no server truth",
  recentProjects: "local history, no server truth",
  recentProjectsByDevice: "local history, no server truth",
  collapsedSections: "local UI state, no server truth",
  sidebarNavExpanded: "local UI state, no server truth",
  feedConversations: "the activity feed page, which the sim does not open",
  feedHasMore: "the activity feed page, which the sim does not open",
  feedCursors: "the activity feed page, which the sim does not open",
  tabs: "local tab layout, no server truth",
  activeTabId: "local tab layout, no server truth",
  sidePanelSessionId: "local panel state, no server truth",
};

/**
 * Every classified key that no invariant compares and NOT_COMPARED does not
 * excuse, and every NOT_COMPARED entry naming a key that no longer exists.
 * Empty when the catalog covers the classification.
 */
export function coverageGaps(
  classification: Readonly<Record<string, "shared" | "local">> = REPLICATION_CLASSIFICATION,
  notCompared: Readonly<Record<string, string>> = NOT_COMPARED,
): string[] {
  const covered = new Set(INVARIANTS.flatMap((inv) => inv.keys));
  const gaps: string[] = [];
  for (const [key, cls] of Object.entries(classification)) {
    if (covered.has(key) || key in notCompared) continue;
    gaps.push(`store key "${key}" (${cls}) is compared by no invariant and is not in NOT_COMPARED. Add it to an invariant's keys in sim/invariants.ts, or to NOT_COMPARED with the reason it is not compared.`);
  }
  for (const key of Object.keys(notCompared)) {
    if (!(key in classification)) gaps.push(`NOT_COMPARED names "${key}", which REPLICATION_CLASSIFICATION no longer has. Remove it.`);
    else if (covered.has(key)) gaps.push(`NOT_COMPARED names "${key}", which an invariant compares. Remove it from NOT_COMPARED.`);
  }
  return gaps;
}
