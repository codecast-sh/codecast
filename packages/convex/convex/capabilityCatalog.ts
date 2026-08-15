// The public capability catalog: cached rows from external registries
// (marketplaces, the MCP registry), refreshed by actions and served to the
// library UI. Split from capabilityState.ts (ct-42828) because catalog rows
// are shared and refreshed on their own clock, while state rows are per-user
// mirror data — different write patterns, different sweeps, different tests.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { CAPABILITY_SOURCE_PREFIX } from "@codecast/shared/contracts";
import { internalMutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { MAX_CAPABILITY_SLUG_LENGTH } from "@codecast/shared/contracts";
import {
  CATALOG_STALE_MS,
  LIVENESS_WRITE_INTERVAL_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_ENTRIES_CHARS,
  MAX_NAME_CHARS,
  MAX_PATH_CHARS,
  capDb,
} from "./capabilitiesSchema";
import { sanitizeReported, canonicalHash, text, identityText, isRecord, SWEEP_BATCH } from "./capabilityState";

/**
 * Which slug prefix each source owns — the shared contract's own table.
 *
 * Checked rather than trusted for one reason: slugs render as identities, so a
 * marketplace registered as `builtin` would otherwise publish rows that look
 * like ours.
 */
const SOURCE_PREFIX: Record<string, string> = CAPABILITY_SOURCE_PREFIX;

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
      const slug = identityText(entry.slug, MAX_CAPABILITY_SLUG_LENGTH);
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
      row.entry_hash = canonicalHash([
        row.slug, row.source, row.origin, row.kind, row.name,
        row.description, row.publisher, row.repo, row.homepage, row.entry_json,
      ]);

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
 * should show it without a migration. But the fields below are not that. All of
 * them except `installs` are columns ingest computed and checked, `slug` above
 * all: the prefix rule is the only thing stopping a marketplace from publishing
 * under a `builtin/` name, and a payload carrying `slug: "builtin/memory"` in
 * its detail would defeat that rule on the way out instead of on the way in.
 * `installs` belongs to the browser, which fills it from the reader's own
 * machines; a catalog must not be able to claim a capability is already on
 * somebody's laptop.
 *
 * Add a field to the card above, add its name here.
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
