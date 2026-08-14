// Grouping an inventory into the per-scope rows the server stores.
//
// The heartbeat carries ONE payload (capabilities/heartbeat.ts owns the ride:
// hash gate, hourly liveness floor, mark-sent). This module owns the SHAPE of
// that payload's rows: one row per (client, scope key), capped, with the
// overflow folded into a single summary row instead of dropped.
//
// The cap exists because rows become documents: a machine with three clients
// and thirty project scopes would write ninety documents per report, and
// projectRoots.ts caps enumeration at 300 to begin with. Fifty rows covers
// every real machine seen so far; the summary row keeps the tail visible
// ("+38 more scopes, 214 items") so a capped report never silently lies about
// how much exists.
//
// `full` is the retention contract: true ONLY when every live scope was
// enumerated. The server's sweep deletes a stored scope only when a `full`
// report omits it — a partial report omitting a scope must never delete it,
// because "I did not look there this time" is not "it is gone".

import type { Inventory, InventoryItem } from "./inventory.js";

/** Rows per report before the tail folds into one summary row. */
export const MAX_SCOPE_ROWS = 50;

export interface CapabilityScopeRow {
  /** Which agent client this row describes; "claude" today, more as the
   *  scanner grows. Carried per row so one machine's clients stay distinct. */
  client: string;
  /** "" for user scope; a project scope key otherwise. Never a raw path in
   *  team-visible rows — see capabilityScopes.buildProjectScopeKey. */
  scope_key: string;
  items: InventoryItem[];
}

export interface CapabilityStateReport {
  rows: CapabilityScopeRow[];
  /** Present only when the cap folded scopes away: how much the rows omit. */
  overflow?: { scopes: number; items: number };
  /** Every live scope was enumerated. The server's retention sweep may only
   *  treat an omission as a removal when this is true. */
  full: boolean;
}

/**
 * Group one machine's inventory into scope rows.
 *
 * `enumeratedAll` is the CALLER's claim, not derived here: only the scanner
 * knows whether it visited every project root or stopped early (permission
 * error, enumeration cap). This module can only make the flag harder to get
 * wrong — a capped report is forced to `full: false` regardless, because a
 * report that folded scopes away has, by definition, not shown all of them.
 */
export function buildCapabilityStateReport(
  inventory: Inventory,
  opts: { client?: string; enumeratedAll: boolean; maxRows?: number } = { enumeratedAll: false },
): CapabilityStateReport {
  const client = opts.client ?? "claude";
  const maxRows = opts.maxRows ?? MAX_SCOPE_ROWS;

  // Stable grouping: user scope first, then project scopes sorted by key, so
  // two identical inventories serialize identically and the hash gate holds.
  const byScope = new Map<string, InventoryItem[]>();
  for (const item of inventory.items) {
    const key = item.scope === "user" ? "" : (item.meta?.scopeKey ?? item.scope);
    const rows = byScope.get(key) ?? [];
    rows.push(item);
    byScope.set(key, rows);
  }

  const keys = [...byScope.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a < b ? -1 : 1));
  const kept = keys.slice(0, maxRows);
  const folded = keys.slice(maxRows);

  const rows: CapabilityScopeRow[] = kept.map((key) => ({
    client,
    scope_key: key,
    items: byScope.get(key)!,
  }));

  const overflowItems = folded.reduce((n, k) => n + byScope.get(k)!.length, 0);

  return {
    rows,
    ...(folded.length > 0 ? { overflow: { scopes: folded.length, items: overflowItems } } : {}),
    // A report that folded scopes away has not shown all of them, whatever the
    // caller believes about its enumeration.
    full: opts.enumeratedAll && folded.length === 0,
  };
}
