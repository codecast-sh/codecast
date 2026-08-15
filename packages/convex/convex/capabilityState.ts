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
// The vocabulary — kinds, sources, scopes, surfaces, the manifest and its hash
// — is imported from `@codecast/shared/contracts`, never copied. Four runtimes
// have to agree byte for byte on those, and the shared module is the agreement.
// The one remaining duplicate is the fleet fold below, and it carries its own
// consolidation note.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  CAPABILITY_SOURCE_PREFIX,
  MAX_CAPABILITY_SLUG_LENGTH,
  deriveExecutionSurfaces,
  isCapabilityKind,
  isExecutionSurface,
  isObservedScope,
  manifestHash,
  type CapabilityManifest,
  type ExecutionSurface,
  type InstalledEntry,
  type ObservedScope,
  isWellFormedCapabilitySlug,
} from "@codecast/shared/contracts";
import { internalMutation, mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import {
  CATALOG_STALE_MS,
  LIVENESS_WRITE_INTERVAL_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_ENTRIES_CHARS,
  MAX_ENTRY_COUNT,
  MAX_ITEM_CHARS,
  MAX_MANIFEST_LIST,
  MAX_META_KEYS,
  MAX_META_VALUE_CHARS,
  MAX_NAME_CHARS,
  MAX_OBSERVATION_DEVICES,
  MAX_OBSERVATION_ROWS_PER_CLIENT,
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
 * The change detector over anything we store: the shared `manifestHash`, whose
 * canonical form sorts object keys at every depth, so two writers that built
 * the same value in a different order agree.
 *
 * ONE hasher project-wide, on purpose. Consent is granted against a manifest
 * hash, and the daemon, the browser and this module must all compute the same
 * one from the same value — a second algorithm here is a disagreement waiting
 * for its first byte. `manifestHash`'s parameter is typed for its primary
 * caller; its canonical walk handles any JSON value, which is what the cast
 * states. It never gates a trust decision — a collision costs a stale mirror
 * row, and integrity against an adversary is the pin's job, not this.
 */
export function canonicalHash(value: unknown): string {
  return manifestHash(value as CapabilityManifest);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How a reported string is used, which decides what it may contain:
 *
 *   "text"       display prose (a description). Truncated over its cap.
 *   "identity"   addresses a row (a device id, a scope key, a slug, a
 *                capability's kind and name). REFUSED over its cap, never
 *                clipped — a clipped identity stores the row under a key its
 *                writer will never look for again, and two different over-long
 *                identities clip to the SAME key and silently merge.
 *   "source"     a machine-local hint (an item's path, an MCP command line).
 *                Single line; an absolute path is legitimate content.
 *   "diagnostic" a scan's own error text. Prose rules — newlines kept, and a
 *                long stack trace is truncated rather than refused, because a
 *                dropped error reads as "nothing installed" when the truth is
 *                "could not look" — AND a path is legitimate content, because
 *                the failure it names is machine-local ("~/.claude unreadable").
 */
export type ReportedField = "text" | "identity" | "source" | "diagnostic";

/** Whole string is a filesystem location: `/…`, `~/…`, or `C:\…`. */
const ABSOLUTE_PATH = /^(?:\/|~[\\/]|[A-Za-z]:[\\/])/;
/** An environment ASSIGNMENT — `NAME=value`. The name alone is fine. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** C0 controls (newline and tab excepted for prose) and DEL. */
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * THE sanitizer for reported strings. Every ingest in this module — the
 * inventory report, the observation, the catalog upsert — funnels each foreign
 * string through here; nothing else in this file inspects one.
 *
 * `null` means REJECTED, and rejected is deliberately distinguishable from
 * cleared at every call site — `sanitizeSshHost`'s convention (`devices.ts:938`).
 * Three rejections are absolute, whatever the field:
 *
 *   Control characters. Prose keeps newline and tab; everything else is a
 *   payload aimed at a terminal or a log line, and it is rejected whole rather
 *   than silently cleaned — a cleaned payload looks like data we verified.
 *
 *   Environment ASSIGNMENTS (`AWS_SECRET=sk-…`). A manifest may name the env
 *   vars a capability wants; a report that carries a VALUE is one scanner bug
 *   away from storing and rendering a secret. Names pass, values never do.
 *
 *   Absolute paths outside `"source"` fields. A path is a property of one
 *   disk; in an identity it can never match across machines, and in prose it
 *   leaks the machine's layout into team-visible text.
 */
export function sanitizeReported(value: unknown, max: number, field: ReportedField = "text"): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const prose = field === "text" || field === "diagnostic";
  const pathIsContent = field === "source" || field === "diagnostic";
  if (prose ? FORBIDDEN_CONTROLS.test(trimmed) : ANY_CONTROL.test(trimmed)) return null;
  if (ENV_ASSIGNMENT.test(trimmed)) return null;
  if (!pathIsContent && ABSOLUTE_PATH.test(trimmed)) return null;
  if (trimmed.length > max) {
    return prose ? trimmed.slice(0, max) : null;
  }
  return trimmed;
}

/** An environment variable NAME, or nothing. There is no truncation case: a
 *  clipped name is a different variable, and a value must never be stored at
 *  all — this is the manifest contract's "names only" rule made mechanical. */
export function sanitizeEnvKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(trimmed) ? trimmed : null;
}

/** `sanitizeReported`, with absence spelled the way this module's optional
 *  fields spell it. */
export function text(value: unknown, max: number, field: ReportedField = "text"): string | undefined {
  return sanitizeReported(value, max, field) ?? undefined;
}

/** See `ReportedField` — refusal over the cap is the point. */
export function identityText(value: unknown, max: number): string | undefined {
  return sanitizeReported(value, max, "identity") ?? undefined;
}

/* ==========================================================================
 * Normalising a report
 * ========================================================================== */

/**
 * One capability as one machine observed it, reduced to the fields we keep.
 * `InstalledEntry` with two narrowings the wire forces:
 *
 *   `kind` is an open string, not `CapabilityKind` — a kind we do not model yet
 *   is still something the user has (see the allow-list note in `normalizeItem`).
 *   `enabled` is required — the wire's "absent means on" was resolved on the
 *   way in, so a stored row never re-litigates it.
 */
interface NormalizedItem extends Omit<InstalledEntry, "kind"> {
  kind: string;
  enabled: boolean;
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

/** Claude Code's own observed scopes STACK rather than override, so this is
 *  not the binding scope ladder and must never be widened into it. The check is
 *  the shared contract's; only the "anything else means user" fold is ours. */
function observedScope(value: unknown): ObservedScope {
  return isObservedScope(value) ? value : "user";
}

function normalizeMeta(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  let kept = 0;
  // Sorted so the canonical JSON — and therefore the hash — does not depend on
  // key insertion order, which a JSON parser preserves but a scanner may vary.
  for (const key of Object.keys(value).sort()) {
    if (kept >= MAX_META_KEYS) break;
    // Keys address the value, so they take the identity rules; values are
    // machine-local extras (an MCP command line is the canonical case), so a
    // bare absolute path is legitimate there — but an env ASSIGNMENT never is,
    // and `sanitizeReported` rejects one in every class.
    if (sanitizeReported(key, 64, "identity") !== key) continue;
    const val = text(value[key], MAX_META_VALUE_CHARS, "source");
    if (val === undefined) continue;
    out[key] = val;
    kept += 1;
  }
  return kept > 0 ? out : undefined;
}

function normalizeItem(raw: unknown): NormalizedItem | undefined {
  if (!isRecord(raw)) return undefined;
  // Kind and name form the fleet row's key (`foldFleet` keys on
  // `${kind}:${identity}`), so both take the identity class: refused over
  // their caps, never clipped. Clipping would merge two different over-long
  // names into one row and hide real drift between them.
  const kind = identityText(raw.kind, 40);
  const name = identityText(raw.name, MAX_NAME_CHARS);
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
    // The one field whose JOB is an absolute path on that machine.
    source: text(raw.source, MAX_PATH_CHARS, "source"),
    // The library slug when the scanner could name it with certainty (a
    // builtin section is builtin/<slug> by construction). Kept only when it
    // parses as a well-formed slug — a scanner cannot mint an identity the
    // grammar refuses, or a hostile report could claim builtin/ for anything.
    slug: (() => {
      const candidate = identityText(raw.slug, MAX_CAPABILITY_SLUG_LENGTH);
      return candidate && isWellFormedCapabilitySlug(candidate) ? candidate : undefined;
    })(),
    meta: normalizeMeta(raw.meta),
  };
}

function normalizeMarketplace(raw: unknown): NormalizedMarketplace | undefined {
  if (!isRecord(raw)) return undefined;
  // A marketplace's name becomes its fleet row key too — same identity rules.
  const name = identityText(raw.name, MAX_NAME_CHARS);
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
  return parseInventoryCounted(entriesJson)?.inventory;
}

/** `parseInventory`, plus how many entries the count cap refused to even parse.
 *  Zero on everything this module ever stored — only a raw report can exceed
 *  the cap — so the public parser need not carry the number. */
function parseInventoryCounted(
  entriesJson: string,
): { inventory: NormalizedInventory; overCountCap: number } | undefined {
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
  // Entries past the count cap were never parsed — deliberately, so a
  // pathological report cannot make us build a huge array to throw away. They
  // are still COUNTED: `normalizeReport` folds them into `dropped`, because a
  // cap that trims silently tells the machine's owner they have less than they
  // do.
  return {
    inventory: { items, marketplaces },
    overCountCap: Math.max(0, rawItems.length - MAX_ENTRY_COUNT),
  };
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
  const parsed = parseInventoryCounted(entriesJson);
  if (!parsed) return { error: "unparseable_json" };
  const { items, marketplaces } = parsed.inventory;

  // Byte budget. Marketplaces are reserved first; capabilities fill what is
  // left, in sorted order, so which entries survive a truncation is the same on
  // every machine and across every run rather than a property of scan order.
  const marketsJson = JSON.stringify(marketplaces);
  let budget = MAX_ENTRIES_CHARS - marketsJson.length - 32; // 32 covers the wrapper
  const kept: NormalizedItem[] = [];
  for (const item of items) {
    const cost = JSON.stringify(item).length + 1;
    // An item over its OWN cap is skipped rather than breaking the loop: the
    // field caps keep a well-formed item under this, so one that reaches it is
    // pathological, and letting it end the fill would starve every ordinary
    // item sorted after it. It is counted into `dropped` like any other loss.
    if (cost > MAX_ITEM_CHARS) continue;
    if (cost > budget) break;
    budget -= cost;
    kept.push(item);
  }

  const inventory: NormalizedInventory = { items: kept, marketplaces };
  return {
    inventory,
    json: JSON.stringify(inventory),
    count: kept.length,
    // Everything reported that we did not store, whichever cap took it: the
    // count cap (never parsed), the per-item cap, or the byte budget. This is
    // the number the truncation badge renders, so a loss missing from it is a
    // silent drop by definition.
    dropped: items.length - kept.length + parsed.overCountCap,
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
    /** This report enumerated EVERY live scope (the daemon's state module sets
     *  it false whenever it capped or stopped early). Only full reports may
     *  retire scope rows, and only two in a row — see the retention block. */
    full: v.optional(v.boolean()),
    /** With `full`: every scope key the enumeration saw, so omission is
     *  meaningful. Without `full` this is ignored. */
    covered_scopes: v.optional(v.array(v.string())),
    /** The machine's local ownership-ledger digests, mirrored for comparison.
     *  NEVER written to the server copy here — see owned_ops_json's comment. */
    local_owned_ops_json: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const deviceId = identityText(args.device_id, 200);
    if (!deviceId) return { status: "rejected" as const, reason: "invalid_device_id" };
    // Omitting the client means Claude Code. Sending one we cannot use is a
    // REFUSAL, not that default: `identityText` returns nothing in both cases,
    // and treating them alike would file an opencode daemon's inventory under
    // the machine's `claude` row. The mirror would then show one client's
    // capabilities as another's, and every other machine would read as drift.
    const client = args.client === undefined ? "claude" : identityText(args.client, 40);
    if (!client) return { status: "rejected" as const, reason: "invalid_client" };
    // A scope key is an identity string, never a path. The sanitizer enforces
    // the mechanical half (no controls, no bare path, refused over the cap
    // rather than clipped — it addresses the row); the semantic refusal that
    // matters (a team binding carrying a machine-local key) lives on the
    // binding write, which is phase 2. "" — the machine-wide scope — is not a
    // rejection, so it bypasses the sanitizer's empty-means-null rule.
    const rawScopeKey = args.scope_key?.trim() ?? "";
    const scopeKey = rawScopeKey === "" ? "" : sanitizeReported(rawScopeKey, 400, "identity");
    if (scopeKey === null) {
      return { status: "rejected" as const, reason: "invalid_scope_key" };
    }

    const normalized = normalizeReport(args.entries_json);
    if ("error" in normalized) {
      return { status: "rejected" as const, reason: normalized.error };
    }

    const db = capDb(ctx.db);
    const now = Date.now();

    // ── Scope retention on full reports ──
    //
    // A deleted project or a destroyed worktree leaves its scope row behind
    // forever; the mirror then renders a checkout that stopped existing. The
    // daemon cannot delete what it no longer sees, so omission is the only
    // signal — and omission is only meaningful when the report claims FULL
    // enumeration, twice in a row: one full omitting a scope may be a fluke
    // (a transient read error), two is the daemon saying it is gone. Partial
    // reports never retire anything.
    const machineRow = await db
      .query("capability_state")
      .withIndex("by_user_device_client_scope", (q: any) =>
        q.eq("user_id", auth.userId).eq("device_id", deviceId).eq("client", client).eq("scope_key", ""),
      )
      .first();
    const fullReport = args.full === true;
    if (fullReport && machineRow?.was_full === true) {
      const covered = new Set(args.covered_scopes ?? []);
      const deviceRowsForRetire = await db
        .query("capability_state")
        .withIndex("by_user_device_client_scope", (q: any) =>
          q.eq("user_id", auth.userId).eq("device_id", deviceId).eq("client", client),
        )
        .collect();
      for (const row of deviceRowsForRetire) {
        if (row.scope_key !== "" && !covered.has(row.scope_key)) await db.delete(row._id);
      }
    }
    // One write, and only on a transition — a steady stream of identical full
    // reports must stay zero-write (the hash gate's whole argument).
    if (machineRow && (machineRow.was_full ?? false) !== fullReport) {
      await db.patch(machineRow._id, { was_full: fullReport });
    }

    // Ledger integrity (ct-42860): the local sidecar mirrored up disagrees
    // with the server's authoritative copy. The server copy WINS — the local
    // sidecar is editable by any hostile capability running as the user, so a
    // divergence is a signal, never an update. One conflict event per report;
    // the response hands the server copy back for the daemon to restore.
    let ownedOpsConflict: string | undefined;
    if (
      args.local_owned_ops_json !== undefined &&
      machineRow?.owned_ops_json !== undefined &&
      machineRow.owned_ops_json !== args.local_owned_ops_json
    ) {
      ownedOpsConflict = machineRow.owned_ops_json;
      await db.insert("capability_events", {
        user_id: auth.userId as unknown as string,
        kind: "conflict",
        actor_user_id: auth.userId as unknown as string,
        device_id: deviceId,
        ops_json: JSON.stringify({
          reason: "owned_ops_divergence",
          local: args.local_owned_ops_json.slice(0, 4000),
        }),
        created_at: now,
      });
    }
    const hash = canonicalHash(normalized.inventory);
    // A scan error is diagnostic prose: it may span lines ("EACCES\n  at
    // readdir"), it may name the machine-local path that failed ("~/.claude
    // unreadable"), and over its cap it must be clipped rather than refused.
    // The source class would refuse the first, the text class the second, and
    // either refusal silently merges "could not look" into "nothing installed"
    // — the exact distinction `last_error` exists to keep.
    const scanError = text(args.scan_error, MAX_DESCRIPTION_CHARS, "diagnostic");
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
        // Compare the BYTES we would store against the bytes we hold, not the
        // hash we recorded when we last held them: the canonical form can gain
        // a field (slug did) and every stored row's old hash would then agree
        // with a report that renders differently. Same-hash-different-bytes is
        // exactly the "mirror shows stale data forever" failure.
        existing.entries_json === normalized.json &&
        (existing.last_error ?? undefined) === scanError &&
        (existing.client_version ?? undefined) === clientVersion &&
        (existing.dropped_count ?? 0) === normalized.dropped;
      if (sameContent) {
        if (now - existing.reported_at < LIVENESS_WRITE_INTERVAL_MS) {
          return { status: "unchanged" as const, server_owned_ops: ownedOpsConflict };
        }
        await db.patch(existing._id, { reported_at: now });
        return { status: "refreshed" as const, server_owned_ops: ownedOpsConflict };
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
        server_owned_ops: ownedOpsConflict,
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
      was_full: scopeKey === "" ? fullReport : undefined,
    });
    return {
      status: "created" as const,
      entry_count: normalized.count,
      dropped_count: normalized.dropped,
      server_owned_ops: ownedOpsConflict,
    };
  },
});

/**
 * The apply path reporting what it legitimately did. This is the ONLY writer
 * of the server's owned-ops copy: the heartbeat mirrors and compares, never
 * writes — otherwise a tampered sidecar would launder itself into authority on
 * the next beat and the comparison would protect nothing.
 */
export const reportAppliedOps = mutation({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    client: v.optional(v.string()),
    owned_ops_json: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const deviceId = identityText(args.device_id, 200);
    if (!deviceId) return { status: "rejected" as const, reason: "invalid_device_id" };
    const client = args.client === undefined ? "claude" : identityText(args.client, 40);
    if (!client) return { status: "rejected" as const, reason: "invalid_client" };
    if (args.owned_ops_json.length > MAX_ENTRIES_CHARS) {
      return { status: "rejected" as const, reason: "payload_too_large" };
    }
    const db = capDb(ctx.db);
    const machineRow = await db
      .query("capability_state")
      .withIndex("by_user_device_client_scope", (q: any) =>
        q.eq("user_id", auth.userId).eq("device_id", deviceId).eq("client", client).eq("scope_key", ""),
      )
      .first();
    if (!machineRow) return { status: "rejected" as const, reason: "no_state_row" };
    if (machineRow.owned_ops_json === args.owned_ops_json) {
      return { status: "unchanged" as const };
    }
    await db.patch(machineRow._id, { owned_ops_json: args.owned_ops_json });
    return { status: "recorded" as const };
  },
});

/* ==========================================================================
 * ingestObservation — raw manifest in, derived surfaces and hash out
 * ========================================================================== */

/** A non-blank string: something the machine genuinely reported, whether or
 *  not the sanitizer will accept its bytes. The line between "a value we
 *  refused" (which must still raise surfaces and the truncated flag) and
 *  type junk that was never a value at all. */
function reportedString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** One string list off a raw manifest: sanitized per field class, capped, and
 *  SORTED — two scanners walking one directory in different orders must hash
 *  alike, or cross-device confirmation could never fire. `truncated` is true
 *  when the stored list describes less than the machine reported: the length
 *  cap cut it, or the sanitizer refused a value that was really there. */
function stringList(
  value: unknown,
  max: number,
  field: ReportedField,
): { list?: string[]; truncated: boolean } {
  if (!Array.isArray(value)) return { truncated: false };
  const list: string[] = [];
  let rejected = false;
  for (const raw of value.slice(0, MAX_MANIFEST_LIST)) {
    const item = text(raw, max, field);
    if (item !== undefined) list.push(item);
    else if (reportedString(raw)) rejected = true;
  }
  list.sort();
  return {
    list: list.length > 0 ? list : undefined,
    truncated: rejected || value.length > MAX_MANIFEST_LIST,
  };
}

/**
 * Reduce a raw observation's manifest to the canonical `CapabilityManifest`.
 *
 * Every field is what was OBSERVED to be there, sanitized by its use: `bin`,
 * `scripts`, `hooks` and an MCP `command` are machine-local locations (source
 * class — an absolute path is their content), component and tool names are
 * prose, and `envKeys` takes only environment variable NAMES — a VALUE is
 * rejected outright, because this object is hashed, stored and rendered, and a
 * secret in it would leak through all three.
 *
 * `truncated` is true whenever the stored manifest describes LESS than the
 * machine reported — a list hit its length cap, or the sanitizer refused a
 * value that was really there. The row must say so rather than let a partial
 * manifest read as the whole — a hash over a silently cut manifest would also
 * "confirm" against another machine's identically cut one.
 *
 * Sanitizer refusal deliberately does NOT lower the derived surfaces: those
 * are read off the RAW structure by `structuralSurfaces` before this runs.
 */
export function normalizeManifest(value: unknown): { manifest: CapabilityManifest; truncated: boolean } {
  const m = isRecord(value) ? value : {};
  let truncated = false;
  const take = (raw: unknown, max: number, field: ReportedField): string[] | undefined => {
    const result = stringList(raw, max, field);
    truncated = truncated || result.truncated;
    return result.list;
  };

  const components: NonNullable<CapabilityManifest["components"]> = {};
  let hasComponents = false;
  if (isRecord(m.components)) {
    for (const key of Object.keys(m.components).sort()) {
      // A component kind we do not model cannot be stored under a typed record;
      // unlike an inventory item it has nowhere honest to render, so it is left
      // to the raw report rather than misfiled under a kind it is not.
      if (!isCapabilityKind(key)) continue;
      const list = take(m.components[key], MAX_NAME_CHARS, "text");
      if (list) {
        components[key] = list;
        hasComponents = true;
      }
    }
  }

  const mcp: NonNullable<CapabilityManifest["mcp"]> = [];
  if (Array.isArray(m.mcp)) {
    for (const raw of m.mcp.slice(0, MAX_MANIFEST_LIST)) {
      if (!isRecord(raw)) continue;
      const name = text(raw.name, MAX_NAME_CHARS);
      const command = text(raw.command, MAX_PATH_CHARS, "source");
      const url = text(raw.url, MAX_PATH_CHARS);
      // A field the sanitizer refused was still reported — the stored entry
      // (or its absence) describes less than the machine saw.
      if (
        (name === undefined && reportedString(raw.name)) ||
        (command === undefined && reportedString(raw.command)) ||
        (url === undefined && reportedString(raw.url))
      ) {
        truncated = true;
      }
      if (!name && !command && !url) continue;
      mcp.push({
        ...(name !== undefined ? { name } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(url !== undefined ? { url } : {}),
      });
    }
    truncated = truncated || m.mcp.length > MAX_MANIFEST_LIST;
    // Same determinism rule as the flat lists, keyed on the whole entry.
    mcp.sort((a, b) => {
      const ka = JSON.stringify([a.name, a.command, a.url]);
      const kb = JSON.stringify([b.name, b.command, b.url]);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  const envRaw = Array.isArray(m.envKeys) ? m.envKeys : [];
  const envKeys: string[] = [];
  for (const raw of envRaw.slice(0, MAX_MANIFEST_LIST)) {
    const key = sanitizeEnvKey(raw);
    if (key) envKeys.push(key);
    // A refused entry (an env VALUE, a malformed name) is still something the
    // machine reported; the row must not present the cut list as the whole.
    else if (reportedString(raw)) truncated = true;
  }
  envKeys.sort();
  truncated = truncated || envRaw.length > MAX_MANIFEST_LIST;

  const bin = take(m.bin, MAX_PATH_CHARS, "source");
  const scripts = take(m.scripts, MAX_PATH_CHARS, "source");
  const hooks = take(m.hooks, MAX_PATH_CHARS, "source");
  // Claude Code spells it `allowed-tools` in frontmatter; the contract spells
  // it `allowedTools`. Both arrive, depending on which layer parsed the file.
  const allowedTools = take(m.allowedTools ?? m["allowed-tools"], MAX_NAME_CHARS, "text");

  // Empty lists are OMITTED, not stored as `[]`, so "nothing observed" and
  // "field absent" canonicalize — and therefore hash — identically.
  // The artifact pin rides the manifest so the hash covers the BYTES: a moved
  // gitCommitSha re-opens consent even when nothing else in the listing moved.
  // Accepted under its contract name and the wire spellings inventory uses.
  const artifactPin = identityText(
    (m as Record<string, unknown>).artifactPin ??
      (m as Record<string, unknown>).gitCommitSha ??
      (m as Record<string, unknown>).folderHash,
    MAX_NAME_CHARS,
  );

  return {
    manifest: {
      ...(hasComponents ? { components } : {}),
      ...(bin ? { bin } : {}),
      ...(scripts ? { scripts } : {}),
      ...(hooks ? { hooks } : {}),
      ...(mcp.length > 0 ? { mcp } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(envKeys.length > 0 ? { envKeys } : {}),
      ...(artifactPin ? { artifactPin } : {}),
    },
    truncated,
  };
}

/**
 * The surfaces a raw manifest's STRUCTURE implies, read before any sanitizing.
 *
 * The stored manifest is the sanitized one, and the sanitizer REFUSES values —
 * a control character, an env-assignment prefix (`NODE_ENV=production node
 * server.js` is an everyday MCP command), an over-cap path. If surfaces were
 * derived only from what survived, one refused byte would strip
 * `mcp_stdio_command` from the row: the consent sheet would then under-state
 * risk, and two machines refusing identically would even "confirm" the
 * degraded row. That is the exact lowering `deriveExecutionSurfaces`' additive
 * rule exists to prevent, so structure is read here, raw, and folded into the
 * declared list — sanitizing decides only which bytes we store.
 *
 * The checks mirror `deriveExecutionSurfaces` field for field; only the
 * "counts as present" test differs, because these bytes are unvalidated:
 * a non-blank string was reported, whatever the sanitizer thinks of it.
 * Over-raising is safe — a surface added wrongly costs a consent prompt,
 * one removed wrongly removes the prompt.
 */
export function structuralSurfaces(raw: unknown): ExecutionSurface[] {
  if (!isRecord(raw)) return [];
  const listed = (value: unknown): boolean =>
    Array.isArray(value) && value.some(reportedString);
  const found: ExecutionSurface[] = [];
  if (listed(raw.bin)) found.push("ships_bin");
  if (listed(raw.scripts)) found.push("ships_scripts");
  if (listed(raw.hooks)) found.push("declares_hooks");
  if (listed(raw.allowedTools) || listed(raw["allowed-tools"])) found.push("declares_allowed_tools");
  if (Array.isArray(raw.mcp)) {
    // The whole array, not the stored slice: an entry past the length cap is
    // still an MCP server this machine runs.
    for (const entry of raw.mcp) {
      if (!isRecord(entry)) continue;
      if (reportedString(entry.command)) found.push("mcp_stdio_command");
      if (reportedString(entry.url)) found.push("mcp_remote_url");
    }
  }
  return found;
}

/**
 * Store one machine's raw observation of one capability, deriving everything a
 * trust decision will later read.
 *
 * The daemon submits RAW material only — the parsed manifest, `claude plugin
 * details` output, the marketplace entry. This mutation computes
 * `manifest_hash` with the shared `manifestHash` from what it STORED, and
 * derives the surfaces with the shared `deriveExecutionSurfaces` from the
 * stored manifest PLUS the raw structure (`structuralSurfaces` — so a value
 * the sanitizer refused still raises the surface it implied). A hash or
 * surface list in the payload is ignored, with one asymmetry: a declared
 * surface list may only RAISE risk (the shared derive folds it in additively).
 * Otherwise a publisher declares `surfaces: ["prose"]` on an entry whose
 * config runs `npx -y @evil/thing` and the consent sheet says "markdown only"
 * — or a compromised machine lowers the surfaces on a row and recomputes the
 * hash to match.
 *
 * Provenance is "device", and one device's word is not team shareable:
 * `confirmed` turns true only when a second, different machine reports the
 * same manifest hash. A changed hash resets the agreement to the machine that
 * reported it — agreement is per manifest, not per name.
 *
 * Internal on purpose: the caller (the daemon's authenticated report path)
 * resolved the user; this mutation never reads auth.
 */
export const ingestObservation = internalMutation({
  args: {
    user_id: v.id("users"),
    device_id: v.string(),
    client: v.string(),
    /** `{ kind, name, description?, manifest?, surfaces? }` as JSON — permissive
     *  for the same reason `entries_json` is: daemons run at mixed versions. */
    raw_json: v.string(),
  },
  handler: async (ctx, args) => {
    const deviceId = identityText(args.device_id, 200);
    if (!deviceId) return { status: "rejected" as const, reason: "invalid_device_id" };
    const client = identityText(args.client, 40);
    if (!client) return { status: "rejected" as const, reason: "invalid_client" };
    if (args.raw_json.length > MAX_REPORT_CHARS) {
      return { status: "rejected" as const, reason: "payload_too_large" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(args.raw_json);
    } catch {
      return { status: "rejected" as const, reason: "unparseable_json" };
    }
    if (!isRecord(raw)) return { status: "rejected" as const, reason: "unparseable_json" };

    // Kind and name are the row's index key, so they take the identity class:
    // refused over their caps. Clipped, two different over-long names would
    // address ONE row and thrash it — each re-observation reads as a manifest
    // change and resets the other's device agreement.
    const kind = identityText(raw.kind, 40);
    const name = identityText(raw.name, MAX_NAME_CHARS);
    // No identity, no row — same rule as the inventory. The kind stays an open
    // string (see `normalizeItem`); only the identity is non-negotiable.
    if (!kind || !name) return { status: "rejected" as const, reason: "missing_identity" };
    const description = text(raw.description, MAX_DESCRIPTION_CHARS);

    // Accept the manifest nested (the usual shape) or flattened onto the
    // observation (a bare `claude plugin details` parse).
    const rawManifest = isRecord(raw.manifest) ? raw.manifest : raw;
    const { manifest, truncated } = normalizeManifest(rawManifest);
    const declared = Array.isArray(raw.surfaces)
      ? (raw.surfaces.filter(isExecutionSurface) as ExecutionSurface[])
      : [];
    // Two additive-only signals on top of the stored manifest: what the
    // publisher declared, and what the RAW structure implies. The second is
    // what stops a sanitizer refusal — one bell character in a command —
    // from lowering the surfaces consent is granted against.
    const surfaces: string[] = deriveExecutionSurfaces(manifest, [
      ...declared,
      ...structuralSurfaces(rawManifest),
    ]);
    const hash = manifestHash(manifest);
    const manifestJson = JSON.stringify(manifest);

    const db = capDb(ctx.db);
    const now = Date.now();
    const existing = await db
      .query("capability_observation")
      .withIndex("by_user_client_kind_name", (q: any) =>
        q.eq("user_id", args.user_id).eq("client", client).eq("kind", kind).eq("name", name),
      )
      .first();

    if (existing) {
      if (existing.manifest_hash === hash) {
        const knownDevice = existing.device_ids.includes(deviceId);
        const sameSide =
          (existing.description ?? undefined) === description &&
          (existing.truncated ?? false) === truncated;
        if (knownDevice && sameSide) {
          // The gate: a byte-identical re-observation writes nothing until the
          // row is an hour stale — same contract as `reportInventory`.
          if (now - existing.observed_at < LIVENESS_WRITE_INTERVAL_MS) {
            return { status: "unchanged" as const, manifest_hash: hash, confirmed: existing.confirmed };
          }
          await db.patch(existing._id, { observed_at: now });
          return { status: "refreshed" as const, manifest_hash: hash, confirmed: existing.confirmed };
        }
        // A NEW device agreeing is the event `confirmed` exists for. The list
        // stops growing at its cap — by then agreement is long proven.
        const deviceIds =
          knownDevice || existing.device_ids.length >= MAX_OBSERVATION_DEVICES
            ? existing.device_ids
            : [...existing.device_ids, deviceId];
        const confirmed = existing.confirmed || deviceIds.length >= 2;
        await db.patch(existing._id, {
          device_ids: deviceIds,
          confirmed,
          description,
          truncated: truncated || undefined,
          observed_at: now,
        });
        return { status: "updated" as const, manifest_hash: hash, confirmed };
      }
      // The manifest CHANGED. Surfaces and hash are re-derived from the new
      // bytes, and the agreement resets to the one machine that saw them —
      // otherwise a capability could keep its "confirmed" badge across an
      // update nobody else has verified.
      //
      // Re-consent trigger (ct-42855): if a consent on this device names the
      // OLD manifest hash and none names the new one, the change fires a
      // consent-kind audit event within one heartbeat — a moved ref or a new
      // commit behind an unchanged tag surfaces here, because the sha rides in
      // the manifest and so moves the hash. Never on a version string, which
      // is not part of the hash. Matched BY HASH, because the observation is
      // keyed (kind, name) while consent is keyed by slug — the hash is the
      // one identity both sides carry, and the consent row supplies the slug.
      const deviceConsents = await db
        .query("capability_consents")
        .withIndex("by_user_device_slug", (q: any) =>
          q.eq("user_id", args.user_id as unknown as string).eq("device_id", deviceId),
        )
        .collect();
      const oldConsent = deviceConsents.find((row) => row.manifest_hash === existing.manifest_hash);
      const hasNew = deviceConsents.some((row) => row.manifest_hash === hash);
      if (oldConsent && !hasNew) {
        await db.insert("capability_events", {
          user_id: args.user_id as unknown as string,
          kind: "consent",
          actor_user_id: args.user_id as unknown as string,
          device_id: deviceId,
          capability_slug: oldConsent.capability_slug,
          manifest_hash: hash,
          created_at: now,
        });
      }
      await db.patch(existing._id, {
        description,
        manifest_json: manifestJson,
        manifest_hash: hash,
        surfaces,
        device_ids: [deviceId],
        confirmed: false,
        truncated: truncated || undefined,
        observed_at: now,
      });
      return { status: "updated" as const, manifest_hash: hash, confirmed: false };
    }

    // First sighting. Bound how many observation rows one (user, client) may
    // hold — checked only here, so re-observation never pays for the count.
    const clientRows = await db
      .query("capability_observation")
      .withIndex("by_user_client_kind_name", (q: any) =>
        q.eq("user_id", args.user_id).eq("client", client),
      )
      .take(MAX_OBSERVATION_ROWS_PER_CLIENT);
    if (clientRows.length >= MAX_OBSERVATION_ROWS_PER_CLIENT) {
      return { status: "rejected" as const, reason: "observation_cap_reached" };
    }

    await db.insert("capability_observation", {
      // Same type-level bridge as `capability_state` — see the note there.
      user_id: args.user_id as unknown as string,
      client,
      kind,
      name,
      description,
      manifest_json: manifestJson,
      manifest_hash: hash,
      surfaces,
      provenance: "device",
      device_ids: [deviceId],
      confirmed: false,
      truncated: truncated || undefined,
      observed_at: now,
    });
    return { status: "created" as const, manifest_hash: hash, confirmed: false };
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
    /** Incremental watermark: only rows with reported_at > since. The store
     *  feeds pages into syncTable without pruning, so a full list every poll
     *  would re-push unchanged rows; with the watermark, a quiet fleet costs
     *  zero rows. Filtered in memory AFTER the capped index read — the per-user
     *  row count is already bounded (scope cap x device count), so a time
     *  index would buy nothing and cost a second write per report. */
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // No global auth gate in this deployment: every function guards itself. An
    // unauthenticated read returns an empty fleet rather than throwing, because
    // this query is a subscription that outlives a session expiring.
    const userId = await getAuthUserId(ctx);
    if (!userId) return { items: [] as any[], truncated: false };

    const db = capDb(ctx.db);
    // Identity class, like every device id in this module. A filter the
    // sanitizer refuses names a machine that cannot exist (the write path
    // refused the same bytes), so the honest answer is an empty fleet — the
    // truncating class would instead drop the filter and list every machine.
    const deviceId = identityText(args.device_id, 200);
    if (args.device_id !== undefined && args.device_id.trim() !== "" && !deviceId) {
      return { items: [] as any[], truncated: false };
    }
    const rows = await db
      .query("capability_state")
      .withIndex("by_user_device_client_scope", (q: any) => {
        const scoped = q.eq("user_id", userId);
        return deviceId ? scoped.eq("device_id", deviceId) : scoped;
      })
      .take(MAX_STATE_ROWS + 1);
    const fresh =
      args.since === undefined ? rows : rows.filter((r) => r.reported_at > args.since!);
    // One row over the cap is the only way to tell "exactly at the cap" from
    // "there is more". A raw listing that quietly ends is a listing whose reader
    // believes it has the whole fleet.
    const truncated = rows.length > MAX_STATE_ROWS;
    if (truncated) rows.length = MAX_STATE_ROWS;
    const page = args.since === undefined ? rows : fresh.slice(0, MAX_STATE_ROWS);

    // Machine-wide rows first. A consumer keying by device — the web store's
    // `capabilityState` slice does exactly that — then lands on the row the
    // mirror is about, rather than on whichever project scope sorted first.
    page.sort((a, b) => {
      const scope = Number(a.scope_key !== "") - Number(b.scope_key !== "");
      if (scope !== 0) return scope;
      if (a.device_id !== b.device_id) return a.device_id < b.device_id ? -1 : 1;
      return a.client < b.client ? -1 : a.client > b.client ? 1 : 0;
    });

    const includeEntries = args.include_entries !== false;
    let budget = MAX_QUERY_ENTRY_CHARS;
    const items = page.map((row) => {
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
  // Identity class, never the truncating text class: two over-long names that
  // share a 200-char prefix would clip to the SAME key and fold into one row,
  // masking whatever drift the second one carried. Refusal drops each into
  // "no identity, no row" instead — the honest loss.
  const base = identityText(name, MAX_NAME_CHARS);
  if (!base) return undefined;
  if (kind !== "plugin" || base.includes("@")) return base;
  const marketplace = identityText(meta?.marketplace, MAX_NAME_CHARS);
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

/** The header line: how many machines, how many spoke, and how far apart they
 *  are. It describes the WHOLE fleet — a filter narrows rows, never counts. */
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

/**
 * Lay every machine's inventory side by side.
 *
 * Pure and total: no clock, no I/O, and every field is re-derived from
 * `unknown`, so an item another writer got wrong costs its own row and nothing
 * else. A page that shows nine machines correctly beats one that shows an error
 * because the tenth sent something odd.
 */
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
    // Same identity rules as `normalizeItem`: the kind is half the row key.
    const kind = identityText(rawKind, 40);
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
    const inventories = reports.get(device.deviceId);
    for (const inventory of Array.isArray(inventories) ? inventories : []) {
      for (const item of Array.isArray(inventory?.items) ? inventory.items : []) {
        observe(device.deviceId, item?.kind, item?.name, item ?? {});
      }
      for (const market of Array.isArray(inventory?.marketplaces) ? inventory.marketplaces : []) {
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
      if (entryBudget < 0) {
        // The budget is checked BEFORE the read and spent after it, so the last
        // machine to fit is read whole. Stopping half way through a machine's
        // scope rows would render the scopes we skipped as capabilities it does
        // not have — the one thing this page must never say.
        devicesTruncated = true;
        break;
      }
      const states = (await db
        .query("capability_state")
        .withIndex("by_user_device_client_scope", (q: any) =>
          q.eq("user_id", userId).eq("device_id", device.device_id),
        )
        .take(MAX_SCOPE_ROWS_PER_DEVICE)) as CapabilityStateDoc[];

      let reportedAt = 0;
      let lastError: string | undefined;
      let entryCount = 0;
      const inventories: NormalizedInventory[] = [];
      for (const state of states) {
        entryBudget -= state.entries_json.length;
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
 * Drop a machine's inventory when the machine itself goes away.
 *
 * Called from the device-removal path. Without it a deleted device keeps a
 * column in the mirror forever, and — worse — that column reads as a machine
 * that HAS things, which is drift the user can never resolve because there is
 * nothing left to fix.
 */
/** Rows one sweep transaction may touch — both this sweep and the catalog's. */
export const SWEEP_BATCH = 500;

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

// ------------------------------------------------------------ owner queries
//
// The CLI's flat read shape (ct-42827). entries_json stays OPAQUE on this
// wire: parsing belongs to the shared contract, so the CLI, the web and mobile
// decode one format by construction instead of three drifting ones. The
// store's incremental delta shape is a different contract and lives with the
// web queries, not here.

export const listCapabilityState = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const rows = await ctx.db
      .query("capability_state")
      .withIndex("by_user_device_client_scope", (q) => q.eq("user_id", auth.userId))
      .collect();
    // Owner-only by construction: the index leads with user_id and the caller
    // IS the user. No cross-user row can be reached from here.
    return rows.map((row) => ({
      device_id: row.device_id,
      client: row.client,
      scope_key: row.scope_key,
      entries_json: row.entries_json,
      hash: row.entries_hash,
      reported_at: row.reported_at,
      client_version: row.client_version ?? null,
      scan_error: row.last_error ?? null,
      // dropped_count > 0 is this schema's spelling of "the report was capped".
      truncated: (row.dropped_count ?? 0) > 0,
    }));
  },
});

export const getDeviceCapabilityState = query({
  args: {
    api_token: v.string(),
    device_id: v.string(),
    scope_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const rows = await ctx.db
      .query("capability_state")
      .withIndex("by_user_device_client_scope", (q) =>
        q.eq("user_id", auth.userId).eq("device_id", args.device_id),
      )
      .collect();
    const scoped =
      args.scope_key === undefined ? rows : rows.filter((r) => r.scope_key === args.scope_key);
    return scoped.map((row) => ({
      client: row.client,
      scope_key: row.scope_key,
      entries_json: row.entries_json,
      hash: row.entries_hash,
      reported_at: row.reported_at,
    }));
  },
});

/* ==========================================================================
 * Retention sweep — rows whose machine is gone
 * ========================================================================== */

/** How long a device may be silent before its mirror rows stop being data.
 *  90 days: long past any vacation, well before the table is mostly ghosts. */
export const DEVICE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Delete capability rows for devices that have not heartbeated in 90 days.
 *
 * A wiped laptop or a retired VM never reports again, so its rows sit in every
 * fleet read forever, rendering a machine offline since Tuesday long after
 * Tuesday stopped mattering. The daemon cannot clean up a machine that no
 * longer exists; only the server can notice the silence.
 *
 * Shaped on sweepSlackEvents: bounded batches inside one run, registered on the
 * daily cron. The devices table is small (a handful per user), so a paginated
 * full scan is the honest cost — there is no by_last_seen index to lean on and
 * adding one for a daily sweep would tax every heartbeat write.
 */
export const sweepCapabilityState = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - DEVICE_RETENTION_MS;
    const db = capDb(ctx.db);
    let deleted = 0;

    let devicePage = await ctx.db.query("devices").paginate({ cursor: null, numItems: 200 });
    for (let hop = 0; hop < 16; hop++) {
      for (const device of devicePage.page) {
        if ((device.last_seen ?? 0) >= cutoff) continue;
        const rows = await db
          .query("capability_state")
          .withIndex("by_user_device_client_scope", (q: any) =>
            q.eq("user_id", device.user_id).eq("device_id", device.device_id),
          )
          .take(SWEEP_BATCH);
        for (const row of rows) await db.delete(row._id);
        deleted += rows.length;
        // A device with more rows than one batch finishes on a later run —
        // bounded transactions outrank a same-run guarantee here.
      }
      if (devicePage.isDone) break;
      devicePage = await ctx.db
        .query("devices")
        .paginate({ cursor: devicePage.continueCursor, numItems: 200 });
    }
    return { deleted };
  },
});
