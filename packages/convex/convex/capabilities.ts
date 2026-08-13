// The fleet mirror's server half: what each machine reports it has, and the
// cached public catalogs it could add.
//
// This module NEVER writes a file and never tells a machine to write one. It
// accepts an inventory a daemon read off its own disk, stores it once per
// (device, client, scope), and answers three questions about the set:
//
//   webList      what did each of my machines last report?
//   webFleetDiff where do my machines disagree — missing, switched off, or
//                sitting on a different pin?
//   webCatalog*  what is out there, cross-referenced against that?
//
// Two rules run through all of it.
//
// **A write must be earned.** A machine with three clients and thirty checkouts
// holds ninety documents here, and Convex versions the WHOLE document on every
// patch. If `reported_at` alone moved the row, a fleet's heartbeats would churn
// the table continuously — the exact shape of the api_tokens hot-document
// contention that once stalled the whole write path. So the mutation hashes what
// it is about to store, compares it with what is already there, and on a match
// writes nothing at all until the row is an hour stale. Same contract
// `modelInventoryValidator` states for the model list
// (`deviceSettingsShared.ts:22-30`).
//
// **Nothing here trusts its input.** The payload is assembled from files other
// products own, on a machine we do not control, by a daemon that may be older or
// newer than this code. So the wire format is a permissive JSON string, and the
// mutation parses, normalises, bounds and re-serialises it. A malformed report
// costs that one machine a column, never the page.
//
// FOUR THINGS BELOW ARE COPIES, and there is one edit that removes all four.
// `packages/shared/contracts/capabilities.ts` already exports
// `CAPABILITY_SOURCE_PREFIX`, `OBSERVED_SCOPES` / `isObservedScope`,
// `MAX_CAPABILITY_SLUG_LENGTH` and `InstalledEntry` — the shape `NormalizedItem`
// copies. The Convex runtime cannot reach them today only because the contracts
// barrel does not re-export that module, and `moduleResolution: "Bundler"`
// honours the package's exports map, so the deep path does not resolve. Add
// `export * from "./capabilities";` to `packages/shared/contracts/index.ts` and
// delete `SOURCE_PREFIX`, `observedScope`, `MAX_SLUG_CHARS` and the local item
// shape here. Verified against every other contracts module: none of those names
// collides.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import {
  CATALOG_STALE_MS,
  LIVENESS_WRITE_INTERVAL_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_ENTRIES_CHARS,
  MAX_ENTRY_COUNT,
  MAX_META_KEYS,
  MAX_META_VALUE_CHARS,
  MAX_NAME_CHARS,
  MAX_PATH_CHARS,
  MAX_REPORT_CHARS,
  MAX_SCOPE_ROWS_PER_DEVICE,
  capDb,
  type CapabilityStateDoc,
} from "./capabilitiesSchema";

/* ==========================================================================
 * Small pure helpers
 * ========================================================================== */

/**
 * A change detector over a string. Two 32-bit FNV-1a style accumulators with
 * different mixing, concatenated — 64 bits, deterministic, synchronous.
 *
 * Deliberately not sha256: `crypto.subtle` is async, and this hash never gates a
 * trust decision. It answers one question — "are these the same bytes I already
 * stored?" — where a collision costs a mirror row that stays stale until the
 * machine's inventory changes again, not a security failure. The daemon may hash
 * its own payload too, to decide whether to send; the two hashes are independent
 * on purpose, so neither side has to keep an algorithm in step with the other.
 */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
    h2 = (h2 << 13) | (h2 >>> 19);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A trimmed, length-capped string, or undefined. Reports arrive as parsed
 *  JSON, so "a string with something in it" cannot be assumed from the type. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * The same, for a field that IDENTIFIES something — a device id, a slug, the
 * scope key a row is stored under.
 *
 * Over the cap it returns nothing rather than a prefix. Truncating display text
 * costs a few characters; truncating an identity stores the row under a key its
 * writer will never look for again, and the next report creates a second row
 * beside the first. A refusal is loud and recoverable; a silent rename is not.
 */
function identityText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/* ==========================================================================
 * Normalising a report
 * ========================================================================== */

/** One capability as one machine observed it, reduced to the fields we keep.
 *  A copy of `InstalledEntry` — see the barrel note at the top of the file. */
interface NormalizedItem {
  kind: string;
  name: string;
  description?: string;
  scope: string;
  enabled: boolean;
  installed?: boolean;
  source?: string;
  meta?: Record<string, string>;
}

interface NormalizedMarketplace {
  name: string;
  repo?: string;
  scope: string;
}

export interface NormalizedInventory {
  items: NormalizedItem[];
  marketplaces: NormalizedMarketplace[];
}

/** Claude Code's own observed scopes. They STACK rather than override, so this
 *  is not the binding scope ladder and must never be widened into it. A copy of
 *  `isObservedScope` — see the barrel note at the top of the file. */
function observedScope(value: unknown): string {
  return value === "local" || value === "project" ? value : "user";
}

function normalizeMeta(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  let kept = 0;
  // Sorted so the canonical JSON — and therefore the hash — does not depend on
  // key insertion order, which a JSON parser preserves but a scanner may vary.
  for (const key of Object.keys(value).sort()) {
    if (kept >= MAX_META_KEYS) break;
    const val = text(value[key], MAX_META_VALUE_CHARS);
    if (val === undefined) continue;
    out[key] = val;
    kept += 1;
  }
  return kept > 0 ? out : undefined;
}

function normalizeItem(raw: unknown): NormalizedItem | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = text(raw.kind, 40);
  const name = text(raw.name, MAX_NAME_CHARS);
  // No allow-list on `kind`. A kind we do not model yet is still something the
  // user has, and the renderers show it verbatim rather than dropping the row
  // (`packages/web/components/capabilities/CapabilityCard.tsx` KindChip). An
  // allow-list here would make a newer daemon's new kind vanish silently, which
  // is the one failure a mirror cannot afford.
  if (!kind || !name) return undefined;
  return {
    kind,
    name,
    description: text(raw.description, MAX_DESCRIPTION_CHARS),
    scope: observedScope(raw.scope),
    // Only an explicit `false` means switched off; a report that omits the flag
    // describes something merely present.
    enabled: raw.enabled !== false,
    installed: typeof raw.installed === "boolean" ? raw.installed : undefined,
    source: text(raw.source, MAX_PATH_CHARS),
    meta: normalizeMeta(raw.meta),
  };
}

function normalizeMarketplace(raw: unknown): NormalizedMarketplace | undefined {
  if (!isRecord(raw)) return undefined;
  const name = text(raw.name, MAX_NAME_CHARS);
  if (!name) return undefined;
  return { name, repo: text(raw.repo, MAX_NAME_CHARS), scope: observedScope(raw.scope) };
}

/** Marketplaces are few and they explain missing plugins, so they are budgeted
 *  before capabilities and effectively never dropped. */
const MAX_MARKETPLACES = 200;

export interface NormalizedReport {
  inventory: NormalizedInventory;
  /** The canonical JSON we would store. */
  json: string;
  /** Entries kept. */
  count: number;
  /** Entries the byte budget forced out. */
  dropped: number;
}

/**
 * Parse an inventory — a daemon's report, or the bytes we stored from one — and
 * reduce it to the fields we keep.
 *
 * The ONE parser. Both directions go through it, so a row can never be
 * normalised one way on the way in and a different way on the way out: the fold
 * that renders the fleet page sees exactly the shape the write path validated.
 *
 * Undefined means the bytes are not JSON at all. Every other defect — an
 * unexpected top-level shape, a blank name, a hostile field — yields a smaller
 * inventory rather than a throw.
 *
 * The result is SORTED. A directory scan's order follows `readdir`, which is not
 * stable across machines or even across runs on some filesystems — hashing an
 * unsorted list would report a change every time the disk felt like it, which is
 * precisely the churn this whole design exists to avoid.
 */
export function parseInventory(entriesJson: string): NormalizedInventory | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entriesJson);
  } catch {
    return undefined;
  }

  // Two accepted shapes: the full `{ items, marketplaces }` inventory, and a
  // bare array of items from a daemon that only reports capabilities. Anything
  // else is an empty inventory, which is still a legitimate answer.
  const rawItems: unknown[] = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : [];
  const rawMarkets: unknown[] =
    isRecord(parsed) && Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [];

  const items: NormalizedItem[] = [];
  for (const raw of rawItems.slice(0, MAX_ENTRY_COUNT)) {
    const item = normalizeItem(raw);
    if (item) items.push(item);
  }
  const marketplaces: NormalizedMarketplace[] = [];
  for (const raw of rawMarkets.slice(0, MAX_MARKETPLACES)) {
    const market = normalizeMarketplace(raw);
    if (market) marketplaces.push(market);
  }

  items.sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1
      : a.name < b.name ? -1 : a.name > b.name ? 1
        : a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0,
  );
  marketplaces.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { items, marketplaces };
}

/**
 * Parse a daemon's report and reduce it to the exact bytes we will store.
 *
 * `parseInventory` plus the storage budget. The only rejections are "not JSON"
 * and "too big to parse", and both are returned rather than thrown so the daemon
 * logs one line instead of retrying forever.
 */
export function normalizeReport(entriesJson: string): NormalizedReport | { error: string } {
  if (entriesJson.length > MAX_REPORT_CHARS) {
    return { error: "payload_too_large" };
  }
  const parsed = parseInventory(entriesJson);
  if (!parsed) return { error: "unparseable_json" };
  const { items, marketplaces } = parsed;

  // Byte budget. Marketplaces are reserved first; capabilities fill what is
  // left, in sorted order, so which entries survive a truncation is the same on
  // every machine and across every run rather than a property of scan order.
  const marketsJson = JSON.stringify(marketplaces);
  let budget = MAX_ENTRIES_CHARS - marketsJson.length - 32; // 32 covers the wrapper
  const kept: NormalizedItem[] = [];
  for (const item of items) {
    const cost = JSON.stringify(item).length + 1;
    if (cost > budget) break;
    budget -= cost;
    kept.push(item);
  }

  const inventory: NormalizedInventory = { items: kept, marketplaces };
  return {
    inventory,
    json: JSON.stringify(inventory),
    count: kept.length,
    dropped: items.length - kept.length,
  };
}

/* ==========================================================================
 * reportInventory — the daemon's one write
 * ========================================================================== */

export const reportInventory = mutation({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    /** The agent client this inventory belongs to — an `AgentClientId`, so
     *  "claude" and not the `convexId` "claude_code" that the conversations
     *  table happens to store. Defaults to Claude Code, the only client with a
     *  plugin manager to read today. */
    client: v.optional(v.string()),
    /** "" (or omitted) for the machine-wide scope. A project scope carries the
     *  repo identity, never a path. */
    scope_key: v.optional(v.string()),
    /** `{ items, marketplaces }` as JSON — see normalizeReport for why this is
     *  a string rather than a validated object. */
    entries_json: v.string(),
    client_version: v.optional(v.string()),
    /** The scan's own failure, when it had one. Reported alongside whatever it
     *  did manage to read: a partial inventory with an error is more useful
     *  than no report, and the UI shows both. */
    scan_error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const deviceId = identityText(args.device_id, 200);
    if (!deviceId) return { status: "rejected" as const, reason: "invalid_device_id" };
    // Omitted means Claude Code. Present-but-unusable is a REFUSAL, not the
    // default: `identityText` returns nothing for both, and folding them
    // together would file an opencode daemon's inventory under the machine's
    // `claude` row — the mirror would then show one client's capabilities as
    // another's, and every other machine would read as drift.
    const client = args.client === undefined ? "claude" : identityText(args.client, 40);
    if (!client) return { status: "rejected" as const, reason: "invalid_client" };
    // A scope key is an identity string, never a path — but this mutation cannot
    // prove that, so it only bounds it. The refusal that matters (a team binding
    // carrying a machine-local key) lives on the binding write, which is phase 2.
    // An over-long key is refused rather than clipped: it addresses the row.
    if (args.scope_key !== undefined && args.scope_key.trim().length > 400) {
      return { status: "rejected" as const, reason: "invalid_scope_key" };
    }
    const scopeKey = args.scope_key?.trim() ?? "";

    const normalized = normalizeReport(args.entries_json);
    if ("error" in normalized) {
      return { status: "rejected" as const, reason: normalized.error };
    }

    const db = capDb(ctx.db);
    const now = Date.now();
    const hash = stableHash(normalized.json);
    const scanError = text(args.scan_error, MAX_DESCRIPTION_CHARS);
    const clientVersion = text(args.client_version, 100);

    const existing = await db
      .query("capability_state")
      .withIndex("by_user_device_client_scope", (q: any) =>
        q
          .eq("user_id", auth.userId)
          .eq("device_id", deviceId)
          .eq("client", client)
          .eq("scope_key", scopeKey),
      )
      .first();

    if (existing) {
      // The gate. Identical bytes AND identical side information means there is
      // nothing to say; the row's freshness is the only thing that could have
      // moved, and that is worth a write at most once an hour.
      //
      // The truncation count belongs in the comparison even though the hash
      // seems to cover it: the hash is over what we STORED, and `dropped` is
      // counted from the part we did not. A machine that grew from 1500 skills
      // to 2000 stores the same 689 either way, so without this line the badge
      // that says "this machine is showing a truncated inventory" would freeze
      // at the first number it ever saw.
      const sameContent =
        existing.entries_hash === hash &&
        (existing.last_error ?? undefined) === scanError &&
        (existing.client_version ?? undefined) === clientVersion &&
        (existing.dropped_count ?? 0) === normalized.dropped;
      if (sameContent) {
        if (now - existing.reported_at < LIVENESS_WRITE_INTERVAL_MS) {
          return { status: "unchanged" as const };
        }
        await db.patch(existing._id, { reported_at: now });
        return { status: "refreshed" as const };
      }
      // `undefined` here CLEARS the field rather than leaving it alone — which is
      // the point. A machine that fixed its unreadable `~/.claude`, or whose
      // inventory shrank back under the byte budget, must stop showing the old
      // error and the old truncation badge.
      await db.patch(existing._id, {
        entries_json: normalized.json,
        entries_hash: hash,
        entry_count: normalized.count,
        dropped_count: normalized.dropped > 0 ? normalized.dropped : undefined,
        client_version: clientVersion,
        last_error: scanError,
        reported_at: now,
      });
      return {
        status: "updated" as const,
        entry_count: normalized.count,
        dropped_count: normalized.dropped,
      };
    }

    // A new (client, scope) row for this machine. Bound how many one device may
    // hold: a laptop with thirty checkouts must not turn into thirty documents
    // that every fleet query then loads. When the cap is reached the OLDEST
    // project-scope row is evicted — never the machine-wide row, which is the
    // one the mirror renders.
    //
    // `collect` rather than `take`, because the index is ordered by scope key
    // and not by time: a partial read would evict the oldest row of an arbitrary
    // prefix. It is bounded by this same cap on every path that writes.
    const deviceRows = await db
      .query("capability_state")
      .withIndex("by_user_device_client_scope", (q: any) =>
        q.eq("user_id", auth.userId).eq("device_id", deviceId),
      )
      .collect();
    if (deviceRows.length >= MAX_SCOPE_ROWS_PER_DEVICE) {
      const evictable = deviceRows
        .filter((row) => row.scope_key !== "")
        .sort((a, b) => a.reported_at - b.reported_at);
      if (evictable.length === 0) {
        // Every row is machine-wide, so there is nothing safe to drop. Refuse
        // rather than evict something the mirror depends on; the daemon logs it.
        return { status: "rejected" as const, reason: "scope_cap_reached" };
      }
      await db.delete(evictable[0]._id);
    }

    await db.insert("capability_state", {
      // A type-level bridge, not a conversion: `Id<"users">` is a branded string
      // and the row type declares a plain one, because `capabilitiesSchema.ts`
      // must not import the generated data model — schema.ts imports IT, and the
      // data model is generated from schema.ts. Same rule `deviceSettingsShared`
      // states for itself.
      user_id: auth.userId as unknown as string,
      device_id: deviceId,
      client,
      scope_key: scopeKey,
      entries_json: normalized.json,
      entries_hash: hash,
      entry_count: normalized.count,
      dropped_count: normalized.dropped > 0 ? normalized.dropped : undefined,
      client_version: clientVersion,
      last_error: scanError,
      reported_at: now,
    });
    return {
      status: "created" as const,
      entry_count: normalized.count,
      dropped_count: normalized.dropped,
    };
  },
});

/* ==========================================================================
 * webList — what each of my machines last reported
 * ========================================================================== */

/** Rows one raw listing will load. Well past any real fleet; it exists so a
 *  corrupted device_id space cannot turn one query into a table scan. */
const MAX_STATE_ROWS = 200;

/**
 * Total inventory bytes one query will handle.
 *
 * Ten machines at the 256KB row ceiling is 2.5MB, and a Convex query result has
 * a hard size limit. `webList` budgets what it SHIPS: past the budget rows still
 * come back — with their counts, timestamps and errors intact — but with
 * `entries_omitted` set, so the page renders a machine it cannot fully expand
 * instead of failing outright. `webFleetDiff` budgets what it READS, and drops
 * the machines it could not read out of the grid entirely, because a column it
 * cannot fill would read as a machine that has nothing.
 */
const MAX_QUERY_ENTRY_CHARS = 3 * 1024 * 1024;

export const webList = query({
  args: {
    device_id: v.optional(v.string()),
    /** Set false for a metadata-only read — counts, freshness and scan errors
     *  without the payload. What a badge or a mobile summary wants. */
    include_entries: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // No global auth gate in this deployment: every function guards itself. An
    // unauthenticated read returns an empty fleet rather than throwing, because
    // this query is a subscription that outlives a session expiring.
    const userId = await getAuthUserId(ctx);
    if (!userId) return { items: [] as any[], truncated: false };

    const db = capDb(ctx.db);
    const deviceId = text(args.device_id, 200);
    const rows = await db
      .query("capability_state")
      .withIndex("by_user_device_client_scope", (q: any) => {
        const scoped = q.eq("user_id", userId);
        return deviceId ? scoped.eq("device_id", deviceId) : scoped;
      })
      .take(MAX_STATE_ROWS + 1);
    // One row over the cap is the only way to tell "exactly at the cap" from
    // "there is more". A raw listing that quietly ends is a listing whose reader
    // believes it has the whole fleet.
    const truncated = rows.length > MAX_STATE_ROWS;
    if (truncated) rows.length = MAX_STATE_ROWS;

    // Machine-wide rows first. A consumer keying by device — the web store's
    // `capabilityState` slice does exactly that — then lands on the row the
    // mirror is about, rather than on whichever project scope sorted first.
    rows.sort((a, b) => {
      const scope = Number(a.scope_key !== "") - Number(b.scope_key !== "");
      if (scope !== 0) return scope;
      if (a.device_id !== b.device_id) return a.device_id < b.device_id ? -1 : 1;
      return a.client < b.client ? -1 : a.client > b.client ? 1 : 0;
    });

    const includeEntries = args.include_entries !== false;
    let budget = MAX_QUERY_ENTRY_CHARS;
    const items = rows.map((row) => {
      const withinBudget = includeEntries && row.entries_json.length <= budget;
      if (withinBudget) budget -= row.entries_json.length;
      return {
        _id: row._id,
        device_id: row.device_id,
        client: row.client,
        scope_key: row.scope_key,
        entries_json: withinBudget ? row.entries_json : undefined,
        entries_omitted: includeEntries && !withinBudget,
        entries_hash: row.entries_hash,
        entry_count: row.entry_count,
        dropped_count: row.dropped_count,
        client_version: row.client_version,
        last_error: row.last_error,
        reported_at: row.reported_at,
      };
    });

    // `truncated` describes the ROW listing, and a truncated listing may be
    // missing whole machines — the index is ordered by device id, so the
    // machines that sort last are the ones that fall off. Unlike `webFleetDiff`
    // this query does not read the device roster to correct for that: it is a
    // raw listing, it is also called for one machine at a time, and a row whose
    // device has left the roster is still worth listing here. A caller that
    // needs a complete fleet asks per device.
    return { items, truncated };
  },
});

/* ==========================================================================
 * The fleet fold — present here, absent there, or on a different pin
 * ========================================================================== */

/**
 * CONSOLIDATION NOTE, and it is the first thing to fix after this ships.
 *
 * The daemon and the browser each already answer this question, from the same
 * vocabulary, in `packages/cli/src/capabilities/fleetDiff.ts`. That module is the
 * canonical algorithm and this is a second implementation of it — which exists
 * only because the Convex runtime can import `@codecast/shared` and nothing else,
 * and that module lives in the CLI package. Move `fleetDiff.ts` to
 * `packages/shared/contracts/`, export it from the contracts barrel, and this
 * whole section becomes one import. Every name below is deliberately the name
 * that module uses, so the replacement is a deletion rather than a redesign.
 *
 * THE TWO ALREADY DISAGREE, in one place, and the merge has to resolve it before
 * anything else: `fleetDiff.ts` drops an item whose kind is not in its
 * `KIND_ORDER` list, and this module keeps it. Keeping it is the position to
 * merge to — it is the same rule `normalizeItem` states above, and the mirror's
 * whole job is to show what a machine has rather than what we modelled. Today
 * the inventory reader emits five kinds and both lists cover them, so the
 * disagreement is latent; the first daemon to report a `hook` makes `cast cap
 * diff` and the web page answer differently on the same data.
 *
 * The reason the server answers it at all, rather than shipping every machine's
 * inventory and letting the client fold: ten machines is megabytes of JSON to
 * render one summary, and a phone or `cast cap status` on a third machine has no
 * business downloading a fleet to learn that one skill is missing.
 */

type CellStatus = "same" | "pin_differs" | "disabled" | "absent" | "unknown";
type RowStatus = "drift" | "unique" | "in_sync" | "not_comparable";

interface FleetCell {
  deviceId: string;
  status: CellStatus;
  present: boolean;
  enabled: boolean;
  pin?: string;
  installed?: boolean;
  scopes: string[];
}

interface FleetRow {
  key: string;
  kind: string;
  identity: string;
  description?: string;
  status: RowStatus;
  cells: FleetCell[];
  presentCount: number;
  activeCount: number;
  absentCount: number;
  disabledCount: number;
  baselinePin?: string;
  pins: string[];
  pinDrift: boolean;
  stateDrift: boolean;
  scopes: string[];
}

/** Narrowest first, as the inventory reader orders them. */
const SCOPE_ORDER = ["local", "project", "user"];

/** Tie-break between rows of equal urgency. Kinds that run code, or that explain
 *  another row's failure, come first; prose comes last. `marketplace` sits beside
 *  `plugin` because a missing marketplace is usually why a plugin is missing. */
const KIND_ORDER = ["plugin", "marketplace", "mcp", "skill", "command", "subagent"];

/**
 * The name that means the same thing on every machine.
 *
 * Never a path: `/Users/ashot/.claude/skills/x/SKILL.md` and
 * `/home/build/.claude/skills/x/SKILL.md` are the same skill. A plugin's identity
 * is `name@marketplace`; the inventory reader already stores that as the item
 * name, but a report built by hand may carry the bare name with the marketplace
 * in `meta`, so it is composed when missing.
 *
 * Undefined when there is no usable name. The caller drops the item, because an
 * item with no identity has no row key — and this runs over bytes another
 * process wrote, so `name` being a string cannot be assumed from the type.
 */
function capabilityIdentity(
  kind: string,
  name: unknown,
  meta?: Record<string, unknown>,
): string | undefined {
  const base = text(name, MAX_NAME_CHARS);
  if (!base) return undefined;
  if (kind !== "plugin" || base.includes("@")) return base;
  const marketplace = text(meta?.marketplace, MAX_NAME_CHARS);
  return marketplace ? `${base}@${marketplace}` : base;
}

/**
 * The value that must match for two machines to be on the same thing — only
 * where a difference is genuinely a difference.
 *
 * A stdio MCP server's command line embeds absolute paths (`node /Users/ashot/…`)
 * that differ on every machine for the same server, so comparing those would
 * report drift on a perfectly synchronised fleet — the one failure this page
 * cannot afford. A remote server's URL has no such problem and a changed URL is
 * real drift, so that one counts.
 */
function pinOf(kind: string, meta?: Record<string, unknown>): string | undefined {
  if (kind === "plugin") {
    return text(meta?.sha, MAX_META_VALUE_CHARS) ?? text(meta?.version, MAX_META_VALUE_CHARS);
  }
  if (kind === "mcp") {
    const url = text(meta?.url, MAX_META_VALUE_CHARS);
    return url ? url.replace(/\/+$/, "") : undefined;
  }
  if (kind === "marketplace") return text(meta?.repo, MAX_META_VALUE_CHARS);
  return undefined;
}

/** The most common value; ties broken lexicographically so the answer never
 *  depends on input order. */
function modal(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Everything one machine said about one capability, across every scope. */
interface Fold {
  enabled: boolean;
  pin?: string;
  installed?: boolean;
  scopes: Set<string>;
}

export interface FleetDevice {
  deviceId: string;
  label: string;
  /** Has this machine ever sent an inventory? A silent daemon and a clean
   *  machine are different facts, and rendering the first as the second would
   *  manufacture drift that does not exist. */
  reported: boolean;
  reportedAt?: number;
  lastError?: string;
  entryCount?: number;
}

/**
 * Lay every machine's inventory side by side.
 *
 * Pure and total: no clock, no I/O, and a malformed column is absorbed rather
 * than thrown on. A page that shows nine machines correctly beats one that shows
 * an error because the tenth sent something odd.
 */
export interface FleetSummary {
  devices: number;
  /** Of those, how many have actually reported. */
  reporting: number;
  /** Two or more reports. False means every row reads `not_comparable`. */
  comparable: boolean;
  total: number;
  inSync: number;
  /** Every row that is not in sync, `unique` rows included — so
   *  `inSync + drifted === total`. */
  drifted: number;
  uniqueToOne: number;
}

export function foldFleet(
  devices: FleetDevice[],
  reports: Map<string, NormalizedInventory[]>,
): { devices: FleetDevice[]; rows: FleetRow[]; summary: FleetSummary } {
  interface Accumulator {
    key: string;
    kind: string;
    identity: string;
    description?: string;
    byDevice: Map<string, Fold>;
  }
  const accumulators = new Map<string, Accumulator>();

  // Every field is read back as `unknown`. The stored inventories reach the fold
  // through `parseInventory`, which already guarantees these shapes — but this
  // function is exported and a second writer arrives with team bindings, so it
  // re-derives rather than trusts. An item it cannot key is dropped, the way
  // `buildFleetDiff` drops one; a page that shows nine machines beats a page
  // that shows an error because the tenth sent a number where a name goes.
  const observe = (
    deviceId: string,
    rawKind: unknown,
    rawName: unknown,
    opts: {
      description?: unknown;
      scope?: unknown;
      enabled?: unknown;
      installed?: unknown;
      meta?: unknown;
    },
  ) => {
    const kind = text(rawKind, 40);
    const meta = isRecord(opts.meta) ? opts.meta : undefined;
    const identity = kind ? capabilityIdentity(kind, rawName, meta) : undefined;
    if (!kind || !identity) return;

    // The KEY is case folded, the display name is not: two machines that spell
    // one skill `Domain-Search` and `domain-search` mean the same skill, and
    // showing it twice would invent drift out of a filename.
    const key = `${kind}:${identity.toLowerCase()}`;
    const description = text(opts.description, MAX_DESCRIPTION_CHARS);
    let accumulator = accumulators.get(key);
    if (!accumulator) {
      accumulator = { key, kind, identity, description, byDevice: new Map() };
      accumulators.set(key, accumulator);
    }
    if (!accumulator.description && description) accumulator.description = description;

    const pin = pinOf(kind, meta);
    const scope = observedScope(opts.scope);
    // Only an explicit `false` is switched off — the same rule the wire format
    // states, applied again here because this may be somebody else's array.
    const enabled = opts.enabled !== false;
    const installed = typeof opts.installed === "boolean" ? opts.installed : undefined;

    const fold = accumulator.byDevice.get(deviceId);
    if (!fold) {
      accumulator.byDevice.set(deviceId, { enabled, pin, installed, scopes: new Set([scope]) });
      return;
    }
    // Scopes stack rather than override, so one scope switching a plugin on is
    // enough for it to be on here — the same union `claude plugin list` reports.
    fold.enabled = fold.enabled || enabled;
    fold.pin = fold.pin ?? pin;
    fold.installed = fold.installed ?? installed;
    fold.scopes.add(scope);
  };

  for (const device of devices) {
    for (const inventory of reports.get(device.deviceId) ?? []) {
      for (const item of inventory.items ?? []) {
        observe(device.deviceId, item?.kind, item?.name, item ?? {});
      }
      for (const market of inventory.marketplaces ?? []) {
        // A marketplace becomes an ordinary row: same identity rules, same cells,
        // one algorithm. It has no enabled flag — a machine either knows it or
        // does not.
        observe(device.deviceId, "marketplace", market?.name, {
          scope: market?.scope,
          meta: market?.repo ? { repo: market.repo } : undefined,
        });
      }
    }
  }

  const reporting = devices.filter((d) => d.reported);
  const comparable = reporting.length >= 2;
  const rows: FleetRow[] = [];

  for (const accumulator of accumulators.values()) {
    // Pins are compared only among machines that reported one. A machine that
    // has the plugin but no sha (declared in settings, never fetched) has an
    // UNKNOWN pin, not a different one, and calling that drift would cry wolf.
    const presentPins: string[] = [];
    const scopes = new Set<string>();
    let presentCount = 0;
    let activeCount = 0;
    let absentCount = 0;
    let disabledCount = 0;

    for (const device of devices) {
      if (!device.reported) continue;
      const fold = accumulator.byDevice.get(device.deviceId);
      if (!fold) {
        absentCount += 1;
        continue;
      }
      presentCount += 1;
      if (fold.enabled) activeCount += 1;
      else disabledCount += 1;
      if (fold.pin) presentPins.push(fold.pin);
      for (const scope of fold.scopes) scopes.add(scope);
    }

    const baselinePin = modal(presentPins);
    const pins = [...new Set(presentPins)].sort();
    const pinDrift = pins.length > 1;
    // Having it and having it switched on is one axis; the pin is the other.
    // Machines disagree on the first when they are not all in the same one of
    // its three states — on, off, or missing.
    const stateDrift = [activeCount, disabledCount, absentCount].filter((n) => n > 0).length > 1;

    const cells: FleetCell[] = devices.map((device) => {
      if (!device.reported) {
        return { deviceId: device.deviceId, status: "unknown", present: false, enabled: false, scopes: [] };
      }
      const fold = accumulator.byDevice.get(device.deviceId);
      if (!fold) {
        return { deviceId: device.deviceId, status: "absent", present: false, enabled: false, scopes: [] };
      }
      const status: CellStatus = !fold.enabled
        ? "disabled"
        : fold.pin && baselinePin && fold.pin !== baselinePin
          ? "pin_differs"
          : "same";
      return {
        deviceId: device.deviceId,
        status,
        present: true,
        enabled: fold.enabled,
        pin: fold.pin,
        installed: fold.installed,
        scopes: SCOPE_ORDER.filter((s) => fold.scopes.has(s)),
      };
    });

    rows.push({
      key: accumulator.key,
      kind: accumulator.kind,
      identity: accumulator.identity,
      description: accumulator.description,
      status: !comparable
        ? "not_comparable"
        : presentCount === 1
          ? "unique"
          : stateDrift || pinDrift
            ? "drift"
            : "in_sync",
      cells,
      presentCount,
      activeCount,
      absentCount,
      disabledCount,
      baselinePin,
      pins,
      pinDrift,
      stateDrift,
      scopes: SCOPE_ORDER.filter((s) => scopes.has(s)),
    });
  }

  // Ordering encodes what a person came here to find. A capability most machines
  // have and one lacks is the moment the product exists for, so it leads. A pin
  // difference is next. Something only one machine has is often deliberate, so it
  // sits below the two kinds of genuine loss. Agreement is last.
  const rank = (row: FleetRow): number =>
    row.status === "drift" ? (row.stateDrift ? 0 : 1)
      : row.status === "unique" ? 2
        : row.status === "in_sync" ? 3 : 4;
  const kindRank = (kind: string): number => {
    const index = KIND_ORDER.indexOf(kind);
    return index === -1 ? KIND_ORDER.length : index;
  };
  rows.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    // Within a rank, breadth is urgency: missing from one of five machines beats
    // missing from four of five.
    if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
    if (a.presentCount !== b.presentCount) return b.presentCount - a.presentCount;
    const byKind = kindRank(a.kind) - kindRank(b.kind);
    if (byKind !== 0) return byKind;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const inSync = rows.filter((r) => r.status === "in_sync").length;
  const uniqueToOne = rows.filter((r) => r.status === "unique").length;
  return {
    devices,
    rows,
    summary: {
      devices: devices.length,
      reporting: reporting.length,
      comparable,
      total: rows.length,
      // With one report there is nothing to be in sync with and nothing to drift
      // from. Zeroing these is what keeps the header honest instead of announcing
      // that every capability is unique to the only machine we have heard from.
      inSync: comparable ? inSync : 0,
      drifted: comparable ? rows.length - inSync : 0,
      uniqueToOne: comparable ? uniqueToOne : 0,
    },
  };
}

/** Rows one diff response may carry. The drift-first ordering means a truncated
 *  answer still holds everything worth acting on. */
const MAX_DIFF_ROWS = 600;

/**
 * Machines one diff will compare.
 *
 * Columns past this are left OUT of the grid rather than shown empty. The whole
 * module turns on the difference between "I do not know" and "it is missing
 * there", and a column we chose not to read is neither — it is a machine we have
 * no business drawing. Most recently seen machines win the cap, because the
 * fleet a person is comparing is the fleet they are using.
 */
export const MAX_FLEET_DEVICES = 50;

export const webFleetDiff = query({
  args: {
    /** Narrow the comparison to these machines. Omitted compares the fleet. */
    device_ids: v.optional(v.array(v.string())),
    /** Restrict to these kinds ("plugin", "skill", "mcp", …). */
    kinds: v.optional(v.array(v.string())),
    /** Rows where every machine agrees are dropped by default — nobody opens
     *  this to admire what matches. */
    include_in_sync: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return {
        devices: [],
        rows: [],
        summary: { devices: 0, reporting: 0, comparable: false, total: 0, inSync: 0, drifted: 0, uniqueToOne: 0 },
        truncated: false,
        devices_truncated: false,
      };
    }

    // The device roster comes from `devices`, not from the reports, so a machine
    // that has never reported still gets a column — its cells read `unknown`
    // rather than `absent`, which is the whole difference between "I do not know"
    // and "it is missing there".
    //
    // It is also authoritative for "machines you have": a report whose device has
    // left the roster (a cloned disk re-keys itself, a machine is removed) is
    // never read at all, so it cannot leave a column for a machine the user can
    // no longer act on. The daemon writes its device row on every heartbeat,
    // before it can report anything, so a live machine is never dropped by this.
    const deviceRows = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId))
      .collect();

    const wanted = args.device_ids && args.device_ids.length > 0 ? new Set(args.device_ids) : null;
    const roster = deviceRows.filter((d: any) => !wanted || wanted.has(d.device_id));
    // The cap picks the machines a person is actually using; the GRID keeps the
    // roster's own order, so an ordinary heartbeat cannot reshuffle the columns
    // under someone reading them.
    const compared = new Set<string>(
      [...roster]
        .sort((a: any, b: any) => (b.last_seen ?? 0) - (a.last_seen ?? 0))
        .slice(0, MAX_FLEET_DEVICES)
        .map((d: any) => d.device_id),
    );
    let devicesTruncated = compared.size < roster.length;

    // One read per machine, bounded by the SAME cap the write path enforces per
    // device. Reading the fleet in one `take` instead would hand every row to
    // whichever devices sort first in the index, and the machines that lost the
    // race would render as "never reported" — a lie about a machine that
    // reported an identical inventory a second ago.
    const db = capDb(ctx.db);
    const devices: FleetDevice[] = [];
    const reports = new Map<string, NormalizedInventory[]>();
    let entryBudget = MAX_QUERY_ENTRY_CHARS;

    for (const device of roster) {
      if (!compared.has(device.device_id)) continue;
      const states = (await db
        .query("capability_state")
        .withIndex("by_user_device_client_scope", (q: any) =>
          q.eq("user_id", userId).eq("device_id", device.device_id),
        )
        .take(MAX_SCOPE_ROWS_PER_DEVICE)) as CapabilityStateDoc[];

      const bytes = states.reduce((sum, state) => sum + state.entries_json.length, 0);
      if (bytes > entryBudget) {
        // A machine whose inventory does not fit in what is left of the read
        // budget is dropped whole, column and all. Half a machine's rows would
        // read as capabilities it does not have.
        devicesTruncated = true;
        continue;
      }
      entryBudget -= bytes;

      let reportedAt = 0;
      let lastError: string | undefined;
      let entryCount = 0;
      const inventories: NormalizedInventory[] = [];
      for (const state of states) {
        // Stored bytes we cannot parse are a bug on our side, not the user's.
        // The machine still counts as having reported — with an empty inventory,
        // which is the honest reading of "it told us something we cannot read".
        inventories.push(parseInventory(state.entries_json) ?? { items: [], marketplaces: [] });
        reportedAt = Math.max(reportedAt, state.reported_at);
        lastError = state.last_error ?? lastError;
        entryCount += state.entry_count;
      }

      const reported = states.length > 0;
      if (reported) reports.set(device.device_id, inventories);
      devices.push({
        deviceId: device.device_id,
        label: device.label || device.device_id,
        reported,
        reportedAt: reported ? reportedAt : undefined,
        lastError,
        entryCount: reported ? entryCount : undefined,
      });
    }

    const folded = foldFleet(devices, reports);
    const kinds = args.kinds && args.kinds.length > 0 ? new Set(args.kinds) : null;
    let rows = folded.rows;
    if (kinds) rows = rows.filter((r) => kinds.has(r.kind));
    if (args.include_in_sync === false) rows = rows.filter((r) => r.status !== "in_sync");
    const limit = Math.max(1, Math.min(args.limit ?? MAX_DIFF_ROWS, MAX_DIFF_ROWS));
    const truncated = rows.length > limit;

    return {
      devices: folded.devices,
      rows: rows.slice(0, limit),
      // The summary describes the WHOLE fleet, not the filtered slice — a count
      // that shrinks when you filter is a count nobody can act on.
      summary: folded.summary,
      /** Rows the response could not carry. */
      truncated,
      /** Machines this comparison left out — over the device cap, or too many
       *  inventory bytes to read. They have no column, so nothing here claims
       *  anything about them; the page says how many are missing. */
      devices_truncated: devicesTruncated,
    };
  },
});

/* ==========================================================================
 * The catalog cache
 * ========================================================================== */

/**
 * Which slug prefix each source owns.
 *
 * Checked rather than trusted for one reason: slugs render as identities, so a
 * marketplace registered as `builtin` would otherwise publish rows that look
 * like ours. A copy of `CAPABILITY_SOURCE_PREFIX` — see the barrel note at the
 * top of the file.
 */
const SOURCE_PREFIX: Record<string, string> = {
  builtin: "builtin",
  marketplace: "mkt",
  git: "git",
  mcp_registry: "mcp",
  authored: "authored",
};

/** A copy of `MAX_CAPABILITY_SLUG_LENGTH` — see the barrel note at the top. */
const MAX_SLUG_CHARS = 200;

/** Entries one ingest call may carry. The caller pages; the mutation stays a
 *  bounded transaction. */
const MAX_CATALOG_BATCH = 500;

export const upsertCatalogEntries = internalMutation({
  args: {
    source: v.string(),
    origin: v.string(),
    fetched_at: v.optional(v.number()),
    // A CLOSED object here, unlike the daemon's report, because the caller is
    // our own ingest action rather than a fleet of daemons at mixed versions:
    // a shape change ships with the code that produces it.
    entries: v.array(
      v.object({
        slug: v.string(),
        kind: v.string(),
        name: v.string(),
        description: v.optional(v.string()),
        publisher: v.optional(v.string()),
        repo: v.optional(v.string()),
        homepage: v.optional(v.string()),
        /** Component counts, token cost, execution surface — whatever the browse
         *  card renders beyond the columns above. */
        detail: v.optional(v.any()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // Both of these are programming errors in our own ingest action, not bad
    // data from a catalog, so they throw — and they name the fix, because the
    // person reading the message is the person writing that action.
    const prefix = SOURCE_PREFIX[args.source];
    if (!prefix) {
      throw new Error(
        `Unknown capability source "${args.source}". Use one of: ${Object.keys(SOURCE_PREFIX).join(", ")}.`,
      );
    }
    if (args.entries.length > MAX_CATALOG_BATCH) {
      throw new Error(
        `Catalog batch of ${args.entries.length} exceeds ${MAX_CATALOG_BATCH}; page the ingest into smaller calls.`,
      );
    }

    const db = capDb(ctx.db);
    const now = args.fetched_at ?? Date.now();
    const origin = text(args.origin, MAX_NAME_CHARS) ?? args.source;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const entry of args.entries) {
      const slug = identityText(entry.slug, MAX_SLUG_CHARS);
      const name = text(entry.name, MAX_NAME_CHARS);
      const kind = identityText(entry.kind, 40);
      if (!slug || !name || !kind || !slug.startsWith(`${prefix}/`)) {
        skipped += 1;
        continue;
      }
      const detailJson = JSON.stringify(entry.detail ?? {});
      const row = {
        slug,
        source: args.source,
        origin,
        kind,
        name,
        description: text(entry.description, MAX_DESCRIPTION_CHARS),
        publisher: text(entry.publisher, MAX_NAME_CHARS),
        repo: text(entry.repo, MAX_NAME_CHARS),
        homepage: text(entry.homepage, MAX_PATH_CHARS),
        entry_json: detailJson.length > MAX_ENTRIES_CHARS ? "{}" : detailJson,
        entry_hash: "",
        fetched_at: now,
      };
      // The hash covers everything a reader sees, so an ingest that produced the
      // same card writes nothing. Without it a refresh cron rewrites the whole
      // catalog on every run and invalidates every browse subscription with it.
      row.entry_hash = stableHash(
        JSON.stringify([
          row.slug, row.source, row.origin, row.kind, row.name,
          row.description, row.publisher, row.repo, row.homepage, row.entry_json,
        ]),
      );

      const existing = await db
        .query("capability_catalog_cache")
        .withIndex("by_slug", (q: any) => q.eq("slug", slug))
        .first();
      if (!existing) {
        await db.insert("capability_catalog_cache", row);
        inserted += 1;
        continue;
      }
      if (existing.entry_hash === row.entry_hash) {
        // Refresh freshness only when the row has gone genuinely stale, so a
        // re-ingest of unchanged data is free. `fetched_at` also drives the
        // retention sweep, so it must not be allowed to rot indefinitely either.
        if (now - existing.fetched_at > LIVENESS_WRITE_INTERVAL_MS) {
          await db.patch(existing._id, { fetched_at: now });
        }
        unchanged += 1;
        continue;
      }
      await db.patch(existing._id, row);
      updated += 1;
    }

    return { inserted, updated, unchanged, skipped };
  },
});

/**
 * Card fields the SERVER decides, which a catalog's own blob may never set.
 *
 * `entry_json` holds whatever a third party catalog said beyond our columns, and
 * it is stored opaque on purpose — a catalog that starts reporting a new field
 * should show it without a migration. But the fields below are not that. The
 * first ten are the ones ingest computed and checked, `slug` above all: the
 * prefix rule is the only thing stopping a marketplace from publishing under a
 * `builtin/` name, and a payload that carried `slug: "builtin/memory"` in its
 * detail would defeat that rule on the way out instead of on the way in.
 * `installs` is the browser's — it is cross-referenced from the reader's own
 * machines, and a catalog must not be able to claim a capability is already on
 * somebody's laptop.
 */
const RESERVED_CARD_FIELDS = new Set([
  "slug",
  "kind",
  "name",
  "description",
  "publisher",
  "repo",
  "homepage",
  "source",
  "marketplace",
  "updatedAt",
  "installs",
]);

export const webCatalogList = query({
  args: {
    source: v.optional(v.string()),
    kind: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    // Public data, but not an open endpoint: an unauthenticated browse is a free
    // scraping surface, and this deployment has no global auth gate to lean on.
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [] as any[], isDone: true, continueCursor: "" };

    const db = capDb(ctx.db);
    // Catalog rows are small and uniform (a card, not a document), so a large
    // page is cheap and saves round trips on a cold browse.
    const paginationOpts = {
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 500),
    };
    const base = args.source
      ? db
          .query("capability_catalog_cache")
          .withIndex("by_source_slug", (q: any) => q.eq("source", args.source))
      : db.query("capability_catalog_cache").withIndex("by_slug");
    const result = await base.paginate(paginationOpts);

    // Kind filters after the page, not inside the index: the catalogs in play are
    // hundreds of rows, and an index per filter combination costs a write on
    // every ingest to save nothing measurable.
    const rows = args.kind ? result.page.filter((r) => r.kind === args.kind) : result.page;

    return {
      page: rows.map((row) => {
        const card: Record<string, unknown> = {
          slug: row.slug,
          kind: row.kind,
          name: row.name,
          description: row.description,
          publisher: row.publisher,
          repo: row.repo,
          homepage: row.homepage,
          source: row.source,
          marketplace: row.source === "marketplace" ? row.origin : undefined,
          updatedAt: row.fetched_at,
        };
        let detail: unknown;
        try {
          detail = JSON.parse(row.entry_json);
        } catch {
          detail = undefined;
        }
        // The detail blob EXTENDS the card; it never redefines it. Copying key
        // by key rather than spreading is what makes that true regardless of
        // order, and it is the whole defence — the columns above were validated
        // at ingest, and these bytes never were.
        if (isRecord(detail)) {
          for (const [key, value] of Object.entries(detail)) {
            if (!RESERVED_CARD_FIELDS.has(key)) card[key] = value;
          }
        }
        return card;
      }),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/* ==========================================================================
 * Housekeeping
 * ========================================================================== */

/** Delete batch size. Small enough that one sweep stays a short transaction,
 *  large enough that an hourly cron keeps up. Mirrors `sweepSlackEvents`. */
const SWEEP_BATCH = 500;

/**
 * Drop catalog rows nobody has refreshed inside the retention window.
 *
 * Age is the ONLY criterion, and deliberately so. A filter that deleted a subset
 * of each batch would re-read the rows it kept on the next pass and make no
 * progress, so the loop's termination and its predicate are the same fact: every
 * row it reads, it deletes. Clearing one specific catalog belongs to the ingest
 * that knows what that catalog now contains, not to a sweep.
 */
export const sweepCatalogCache = internalMutation({
  args: {},
  handler: async (ctx) => {
    const db = capDb(ctx.db);
    const cutoff = Date.now() - CATALOG_STALE_MS;
    let deleted = 0;
    for (let pass = 0; pass < 16; pass++) {
      const stale = await db
        .query("capability_catalog_cache")
        .withIndex("by_fetched_at", (q: any) => q.lt("fetched_at", cutoff))
        .take(SWEEP_BATCH);
      if (stale.length === 0) break;
      for (const row of stale) await db.delete(row._id);
      deleted += stale.length;
      if (stale.length < SWEEP_BATCH) break;
    }
    return { deleted };
  },
});

/**
 * Drop a machine's inventory when the machine itself goes away.
 *
 * Called from the device-removal path. Without it a deleted device keeps a
 * column in the mirror forever, and — worse — that column reads as a machine
 * that HAS things, which is drift the user can never resolve because there is
 * nothing left to fix.
 */
export const deleteDeviceState = internalMutation({
  args: { user_id: v.id("users"), device_id: v.string() },
  handler: async (ctx, args) => {
    const db = capDb(ctx.db);
    let deleted = 0;
    // Looped rather than a single `take`: the cap is enforced on the write path,
    // and a cleanup that trusts an invariant it is not the keeper of leaves rows
    // behind exactly when something has already gone wrong.
    for (let pass = 0; pass < 8; pass++) {
      const rows = await db
        .query("capability_state")
        .withIndex("by_user_device_client_scope", (q: any) =>
          q.eq("user_id", args.user_id).eq("device_id", args.device_id),
        )
        .take(SWEEP_BATCH);
      if (rows.length === 0) break;
      for (const row of rows) await db.delete(row._id);
      deleted += rows.length;
      if (rows.length < SWEEP_BATCH) break;
    }
    return { deleted };
  },
});
