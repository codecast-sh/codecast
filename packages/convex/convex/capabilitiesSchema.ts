// Table definitions for the capability library's read-only phase: what each
// machine reports it has, and a cached copy of the public catalogs.
//
// They live here rather than inline in schema.ts for the same reason
// `deviceSettingsShared.ts` does — a validator that both the schema and the
// mutations need has to sit in a file neither owns. schema.ts splices the
// object in with one spread:
//
//     import { capabilityTables } from "./capabilitiesSchema";
//     export default defineSchema({ ...capabilityTables, /* … */ }, { … });
//
// Nothing here is user-authored content. `capability_state` is a MIRROR of what
// a daemon found on a disk, and `capability_catalog_cache` is a copy of somebody
// else's public catalog. That is why neither carries the usual owned-entity
// furniture:
//
//   * no `short_id` — nothing links to a mirror row, so there is no lookup key
//     to allocate (`counters.ts:18`). A row is addressed by (device, client, scope).
//   * no `team_id` / `is_private` — an inventory is a fact about one person's
//     machine, and phase 1 has no sharing surface at all. Stamping a privacy
//     field that no query reads would advertise a sharing path that does not
//     exist, which is how a leak gets written later by someone who trusted it.
//     Team-visible fleet state is a phase 5 feature and gets its own review.
//   * the catalog carries no `user_id` on purpose: it is public data. Thousands
//     of registry rows multiplied by every user is a table that dwarfs the
//     database, and this repo has paid for that class of mistake before.

import { defineTable } from "convex/server";
import { v } from "convex/values";

/* --------------------------------------------------------------------------
 * Limits — every one of these bounds a document a daemon can write
 * -------------------------------------------------------------------------- */

/** Longest report we will even parse. Anything above this is a bug on the
 *  machine, not an inventory; rejecting it costs the daemon one log line and
 *  saves the isolate from parsing a megabyte to throw it away. */
export const MAX_REPORT_CHARS = 1_000_000;

/** Longest `entries_json` we will STORE. Convex versions whole documents, so a
 *  fat row is a fat write on every change; 256KB fits ~1500 typical entries and
 *  leaves the 1MB document ceiling a wide margin. Entries past the budget are
 *  dropped and counted, never silently lost. */
export const MAX_ENTRIES_CHARS = 256 * 1024;

/** Hard ceiling on entries in one report, applied before the byte budget so a
 *  pathological scan can't make us build a huge array first. */
export const MAX_ENTRY_COUNT = 4000;

/** Rows one device may hold, across every client and project scope. A machine
 *  with three clients and thirty checkouts would otherwise write ninety
 *  documents. Past the cap the OLDEST project-scope row is evicted — never a
 *  user-scope row, which is the one the fleet mirror actually renders.
 *
 *  It bounds the READ side too: `webFleetDiff` reads one machine at a time and
 *  takes this many rows, so a fleet that stayed inside the cap is never
 *  truncated on the way out. That is why the number lives here rather than
 *  beside the write that enforces it. */
export const MAX_SCOPE_ROWS_PER_DEVICE = 24;

/** Per-field caps. A description is display text, a path is a hint; neither is
 *  worth kilobytes, and both arrive from files other tools own. */
export const MAX_NAME_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_PATH_CHARS = 400;
export const MAX_META_KEYS = 16;
export const MAX_META_VALUE_CHARS = 400;

/** Longest single item, measured as its canonical JSON. The field caps above
 *  already bound a well-formed item under ~9KB; this is the backstop for one
 *  that reaches the ceiling anyway. An oversize item is DROPPED AND COUNTED
 *  into `dropped_count` — never stored partially, and never allowed to eat the
 *  whole row budget and starve every item sorted after it. */
export const MAX_ITEM_CHARS = 8 * 1024;

/** Entries one manifest list (`bin`, `hooks`, `mcp`, …) may carry. Past it the
 *  list is cut and the observation row carries `truncated: true`, so the UI can
 *  say "partial" instead of presenting the cut as the whole. */
export const MAX_MANIFEST_LIST = 100;

/** Devices recorded as having independently observed one manifest. Two is what
 *  confirmation needs; past the cap the list stops growing — the fact it proves
 *  ("at least this many agree") is already proven. */
export const MAX_OBSERVATION_DEVICES = 16;

/** Observation rows one (user, client) pair may hold. Checked only when a NEW
 *  row would be inserted, so the common path — re-observing something known —
 *  never pays for the count. */
export const MAX_OBSERVATION_ROWS_PER_CLIENT = 1000;

/**
 * How stale a report may go before an unchanged one is worth a write.
 *
 * The whole churn argument: `reported_at` alone changing rewrites the document,
 * and Convex versions the whole thing. A machine with nothing new to say still
 * wants to prove it is alive, so it may refresh the timestamp once an hour and
 * no more. Same contract `modelInventoryValidator` states for the model list
 * (`deviceSettingsShared.ts:22-30`).
 */
export const LIVENESS_WRITE_INTERVAL_MS = 60 * 60 * 1000;

/** Catalog rows nobody refreshed for this long are stale copies of somebody
 *  else's data; the sweep drops them rather than showing a year-old listing. */
export const CATALOG_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/* --------------------------------------------------------------------------
 * Tables
 * -------------------------------------------------------------------------- */

export const capabilityTables = {
  /**
   * One machine's capability inventory, as its daemon last reported it.
   *
   * `entries_json` is a JSON STRING, not a nested object, for the reason
   * `user_skills.skills_json` exists (`schema.ts:164-175`): the payload is tens
   * of kilobytes, Convex versions whole documents, and a nested validator would
   * also reject a whole report because a newer daemon added one field — an
   * upgrade skew that takes the mirror dark fleet-wide. The mutation parses and
   * re-serialises it into a canonical shape instead, so the stored string is
   * always well formed even though the wire format is permissive.
   *
   * The row key is (user, device, client, scope) because Claude Code's scopes
   * STACK rather than override: the same plugin enabled at user scope and
   * disabled at project scope is two observations, and flattening them destroys
   * the answer to "why is this active here?".
   */
  capability_state: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    /** Which agent client's world this describes — an `AgentClientId`
     *  ("claude", "codex", …). A bare string, not a union: a client added to
     *  the registry must not need a schema migration before its daemon can
     *  report. */
    client: v.string(),
    /** "" for the machine-wide (user) scope; otherwise the repo identity a
     *  project scope was observed under. NEVER a filesystem path — a path is a
     *  property of one disk, so it cannot identify the same checkout twice. */
    scope_key: v.string(),
    /** `{ items: [...], marketplaces: [...] }`, canonicalised and sorted. */
    entries_json: v.string(),
    /** Change detector over `entries_json`, computed HERE from what we stored,
     *  so it can never describe bytes we do not have. */
    entries_hash: v.string(),
    /** Entries actually stored. */
    entry_count: v.number(),
    /** Entries the byte budget forced out, when that happened. Present and
     *  non-zero means the mirror is showing a truncated machine and should say so. */
    dropped_count: v.optional(v.number()),
    /** `claude --version` and friends — recorded once per daemon boot, because
     *  the moment we start reading another product's file formats we need to
     *  know which version wrote them. */
    client_version: v.optional(v.string()),
    /** The scan's own failure, if it had one (an unreadable `~/.claude`, a
     *  malformed settings file). A machine that could not look is a different
     *  fact from a machine with nothing installed, and the UI must not merge them. */
    last_error: v.optional(v.string()),
    reported_at: v.number(),
    /** The last report for this (device, client) claimed full enumeration.
     *  Retention keys on TWO consecutive fulls: one full omitting a scope may
     *  be a fluke; two in a row is the daemon saying the scope is gone. */
    was_full: v.optional(v.boolean()),
    /** The server's authoritative copy of the machine's ownership ledgers
     *  (per-target digests). Written ONLY by reportAppliedOps — the apply path
     *  reporting what it legitimately did. The heartbeat merely mirrors the
     *  local sidecar for comparison: on divergence the server copy WINS and a
     *  conflict event fires, because the local sidecar alone is editable by
     *  any hostile capability running as the user. */
    owned_ops_json: v.optional(v.string()),
  })
    // ONE index, and every query is a prefix of it: (user) lists a fleet,
    // (user, device) lists a machine, the full tuple resolves the upsert target.
    // There is deliberately no index starting at `device_id` — an index with no
    // tenant column first is a cross-tenant read waiting for a caller who forgets
    // the filter, and this repo has already shipped that bug class
    // (publicFunctionSecretLeak.test.ts).
    .index("by_user_device_client_scope", ["user_id", "device_id", "client", "scope_key"]),

  /**
   * One capability's manifest as this user's machines observed it — the raw
   * material consent is granted against.
   *
   * Everything derived lives HERE, computed by `ingestObservation` from the raw
   * bytes a daemon submitted: `surfaces` via the shared
   * `deriveExecutionSurfaces`, `manifest_hash` via the shared `manifestHash`.
   * A client-supplied copy of either is ignored on ingest — a compromised
   * machine must not be able to lower the surfaces on a row and recompute the
   * hash to match.
   *
   * `provenance` is "device" for every row this mutation writes, and a
   * single-device row is NOT team shareable: `confirmed` turns true only when a
   * second machine independently reports the same manifest hash. One machine's
   * report proves what one machine says, and a team surface built on that would
   * let one compromised laptop publish "this plugin is markdown only" to
   * everyone.
   */
  capability_observation: defineTable({
    user_id: v.id("users"),
    /** An `AgentClientId` — same convention as `capability_state.client`. */
    client: v.string(),
    kind: v.string(),
    /** The cross-machine identity: a skill's directory name, a plugin's
     *  `name@marketplace`. Never a path. */
    name: v.string(),
    description: v.optional(v.string()),
    /** The canonical `CapabilityManifest` we stored — what was OBSERVED, never
     *  what the publisher declared. */
    manifest_json: v.string(),
    /** Computed here from `manifest_json` via the shared `manifestHash`, so it
     *  can never describe bytes we do not have. */
    manifest_hash: v.string(),
    /** Derived `ExecutionSurface[]`, in the contract's canonical order. A
     *  publisher-declared list was folded in additively only. */
    surfaces: v.array(v.string()),
    /** How this row came to exist. "device" = a daemon's raw observation. */
    provenance: v.string(),
    /** Devices whose observations matched `manifest_hash`. Reset to the single
     *  newest observer whenever the hash changes: agreement is per manifest,
     *  not per name. */
    device_ids: v.array(v.string()),
    /** Two or more independent devices agree on this manifest. The gate a team
     *  sharing surface must check. */
    confirmed: v.boolean(),
    /** The stored manifest describes less than the machine reported — a list
     *  hit its cap, or the sanitizer refused a value that was really there —
     *  and the UI must say so. Surfaces are NOT lowered by either: they are
     *  derived from the raw structure before sanitizing. */
    truncated: v.optional(v.boolean()),
    observed_at: v.number(),
  })
    // One index, every query a prefix — same tenant-first rule as
    // `capability_state`, for the same reason.
    .index("by_user_client_kind_name", ["user_id", "client", "kind", "name"]),

  /**
   * A normalised copy of the public catalogs, so browsing is a database read
   * rather than a live fetch against somebody else's rate limit.
   *
   * Public data, so no `user_id` and no privacy stamp — and, for the same
   * reason, never a synced store collection. It is read through a paginated
   * query and rendered from whatever page arrives.
   */
  /**
   * A wish: "this capability, at this scope, on or off". The resolver folds
   * these; nothing here materializes anything.
   *
   * `enabled: false` is a ROW, never a deletion — deleting the row would
   * silently re-inherit whatever broader grant the disable was overriding.
   */
  capability_bindings: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    capability_slug: v.string(),
    scope_kind: v.string(),
    scope_key: v.string(),
    enabled: v.boolean(),
    /** Claude Code userConfig values. Substituted into MCP configs and hook
     *  commands — the resolver's trust gate decides whether they may be used. */
    config: v.optional(v.record(v.string(), v.string())),
    client_filter: v.optional(v.array(v.string())),
    min_client_version: v.optional(v.string()),
    /** Optimistic-create idempotency, the tasks convention: the client mints a
     *  key, a retry upserts instead of duplicating. */
    client_key: v.optional(v.string()),
    created_by: v.optional(v.string()),
    updated_at: v.number(),
  })
    .index("by_user_scope", ["user_id", "capability_slug", "scope_kind", "scope_key"])
    .index("by_user_updated", ["user_id", "updated_at"])
    // Tenant exception, justified: team reads are gated by requireTeamAdmin /
    // membership, the same rule capability_events.by_team_created carries.
    .index("by_team_updated", ["team_id", "updated_at"])
    .index("by_client_key", ["user_id", "client_key"]),

  /**
   * One human's yes to one build of one capability on one machine.
   *
   * Keyed (user, device, slug, manifest_hash) and deliberately NOT on the
   * binding: a team-shared binding is one row serving N machines, so consent
   * living there would mean "I approved this on my laptop" silently approves it
   * on the production build box. The hash is the manifest hash — approval names
   * the BYTES, so an upstream edit (even to a description) makes a new hash
   * that has no row and must be approved again.
   */
  capability_consents: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    capability_slug: v.string(),
    manifest_hash: v.string(),
    consented_at: v.number(),
    /** Who clicked yes. Usually user_id; differs when an admin pre-approves. */
    actor_user_id: v.id("users"),
  })
    .index("by_user_device_slug", ["user_id", "device_id", "capability_slug"]),

  /**
   * The audit line an incident needs: what changed a machine's capabilities,
   * who did it, from where. One insert on paths that already write.
   */
  capability_events: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    kind: v.union(
      v.literal("bind"), v.literal("unbind"), v.literal("enable"), v.literal("disable"),
      v.literal("consent"), v.literal("apply"), v.literal("conflict"), v.literal("import"),
    ),
    actor_user_id: v.id("users"),
    device_id: v.optional(v.string()),
    scope_kind: v.optional(v.string()),
    scope_key: v.optional(v.string()),
    capability_slug: v.optional(v.string()),
    manifest_hash: v.optional(v.string()),
    /** `apply` only: what the driver actually executed. */
    ops_json: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_user_created", ["user_id", "created_at"])
    // Tenant exception, justified: the reader is requireTeamAdmin, so the
    // tenant of this index IS the team. See the invariant test's allowlist.
    .index("by_team_created", ["team_id", "created_at"])
    // Tenant exception, justified: the retention sweep ranges on age across all
    // tenants and is internal-only — no public function may touch this index.
    .index("by_created", ["created_at"]),

  capability_catalog_cache: defineTable({
    /** The flat global slug: `mkt/<marketplace>/<plugin>`, `mcp/<name>`, …
     *  Built by the ingest from a source it determined itself, never accepted
     *  from the payload — that is what stops a third party publishing under a
     *  `builtin/` name. */
    slug: v.string(),
    /** Which kind of catalog it came from: "marketplace", "mcp_registry", … */
    source: v.string(),
    /** Which instance of that source: a marketplace name, a registry host.
     *  Kept beside `source` so one dead marketplace can be re-ingested or
     *  dropped without touching the rest. */
    origin: v.string(),
    kind: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    /** Whoever the catalog says publishes it. Anyone can write "Anthropic"
     *  there, so it renders as unverified. */
    publisher: v.optional(v.string()),
    repo: v.optional(v.string()),
    homepage: v.optional(v.string()),
    /** The rest of the browse card — component counts, token cost, execution
     *  surface — as JSON, so a catalog that starts reporting a new field needs
     *  no migration to show it. */
    entry_json: v.string(),
    /** Change detector: a re-ingest that produced identical bytes must not
     *  rewrite the row, or a refresh cron rewrites the whole catalog every run. */
    entry_hash: v.string(),
    fetched_at: v.number(),
  })
    // Identity, for the upsert and for a direct lookup.
    .index("by_slug", ["slug"])
    // Browse: prefix (source) filters, the full tuple pages in a stable order.
    .index("by_source_slug", ["source", "slug"])
    // Retention sweep only: `lt(cutoff)` over the whole cache.
    .index("by_fetched_at", ["fetched_at"]),
};

/* --------------------------------------------------------------------------
 * Row types, and the typed door into them
 * -------------------------------------------------------------------------- */

export interface CapabilityStateDoc {
  _id: string;
  _creationTime: number;
  user_id: string;
  device_id: string;
  client: string;
  scope_key: string;
  entries_json: string;
  entries_hash: string;
  entry_count: number;
  dropped_count?: number;
  client_version?: string;
  last_error?: string;
  reported_at: number;
  was_full?: boolean;
  owned_ops_json?: string;
}

export interface CapabilityObservationDoc {
  _id: string;
  _creationTime: number;
  user_id: string;
  client: string;
  kind: string;
  name: string;
  description?: string;
  manifest_json: string;
  manifest_hash: string;
  surfaces: string[];
  provenance: string;
  device_ids: string[];
  confirmed: boolean;
  truncated?: boolean;
  observed_at: number;
}

export interface CapabilityCatalogDoc {
  _id: string;
  _creationTime: number;
  slug: string;
  source: string;
  origin: string;
  kind: string;
  name: string;
  description?: string;
  publisher?: string;
  repo?: string;
  homepage?: string;
  entry_json: string;
  entry_hash: string;
  fetched_at: number;
}

type NewDoc<T> = Omit<T, "_id" | "_creationTime">;

interface CapQuery<T> {
  withIndex(name: string, fn?: (q: any) => any): CapQuery<T>;
  filter(fn: (q: any) => any): CapQuery<T>;
  order(direction: "asc" | "desc"): CapQuery<T>;
  first(): Promise<T | null>;
  unique(): Promise<T | null>;
  collect(): Promise<T[]>;
  take(n: number): Promise<T[]>;
  paginate(opts: any): Promise<{ page: T[]; isDone: boolean; continueCursor: string }>;
}

/**
 * The capability tables, typed.
 *
 * `capabilityTables` is spliced into `schema.ts`, but the generated
 * `DataModel` only learns of it after the next codegen against that schema.
 * Until every environment (including test runs against a stale `_generated`)
 * sees the tables there, the cast lives here, once, behind a shape that
 * matches what the schema above declares — never as scattered `as any` at
 * call sites. Once codegen with the splice is everywhere, delete `capDb()`
 * and its interface and let `ctx.db` type itself.
 */
export interface CapabilityBindingDoc {
  _id: string;
  _creationTime: number;
  user_id: string;
  team_id?: string;
  capability_slug: string;
  scope_kind: string;
  scope_key: string;
  enabled: boolean;
  config?: Record<string, string>;
  client_filter?: string[];
  min_client_version?: string;
  client_key?: string;
  created_by?: string;
  updated_at: number;
}

export interface CapabilityConsentDoc {
  _id: string;
  _creationTime: number;
  user_id: string;
  device_id: string;
  capability_slug: string;
  manifest_hash: string;
  consented_at: number;
  actor_user_id: string;
}

export interface CapabilityEventDoc {
  _id: string;
  _creationTime: number;
  user_id: string;
  team_id?: string;
  kind: "bind" | "unbind" | "enable" | "disable" | "consent" | "apply" | "conflict" | "import";
  actor_user_id: string;
  device_id?: string;
  scope_kind?: string;
  scope_key?: string;
  capability_slug?: string;
  manifest_hash?: string;
  ops_json?: string;
  created_at: number;
}

export interface CapabilityDb {
  query(table: "capability_state"): CapQuery<CapabilityStateDoc>;
  query(table: "capability_observation"): CapQuery<CapabilityObservationDoc>;
  query(table: "capability_catalog_cache"): CapQuery<CapabilityCatalogDoc>;
  query(table: "capability_bindings"): CapQuery<CapabilityBindingDoc>;
  query(table: "capability_consents"): CapQuery<CapabilityConsentDoc>;
  query(table: "capability_events"): CapQuery<CapabilityEventDoc>;
  insert(table: "capability_state", doc: NewDoc<CapabilityStateDoc>): Promise<string>;
  insert(table: "capability_observation", doc: NewDoc<CapabilityObservationDoc>): Promise<string>;
  insert(table: "capability_catalog_cache", doc: NewDoc<CapabilityCatalogDoc>): Promise<string>;
  insert(table: "capability_bindings", doc: NewDoc<CapabilityBindingDoc>): Promise<string>;
  insert(table: "capability_consents", doc: NewDoc<CapabilityConsentDoc>): Promise<string>;
  insert(table: "capability_events", doc: NewDoc<CapabilityEventDoc>): Promise<string>;
  patch(
    id: string,
    patch:
      | Partial<NewDoc<CapabilityStateDoc>>
      | Partial<NewDoc<CapabilityObservationDoc>>
      | Partial<NewDoc<CapabilityCatalogDoc>>
      | Partial<NewDoc<CapabilityBindingDoc>>
      | Partial<NewDoc<CapabilityConsentDoc>>
      | Partial<NewDoc<CapabilityEventDoc>>,
  ): Promise<void>;
  delete(id: string): Promise<void>;
}

export function capDb(db: unknown): CapabilityDb {
  return db as CapabilityDb;
}
