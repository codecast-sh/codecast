// `cast cap ls` — every capability across the fleet, filterable.

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "../publish.js";
import {
  formatCapabilityRow,
  jsonShape,
  parseEntries,
  type CapabilityEntry,
  type DeviceStateRow,
} from "./format.js";

export interface LsFilters {
  q?: string;
  kind?: string;
  scope?: string;
  client?: string;
}

/** Pure so the filter logic is testable without a server: which entries from
 *  which rows survive the flags. */
export function filterEntries(
  rows: DeviceStateRow[],
  filters: LsFilters,
): Array<{ entry: CapabilityEntry; row: DeviceStateRow }> {
  const out: Array<{ entry: CapabilityEntry; row: DeviceStateRow }> = [];
  const q = filters.q?.toLowerCase();
  for (const row of rows) {
    if (filters.client && row.client !== filters.client) continue;
    for (const entry of parseEntries(row).items) {
      if (filters.kind && entry.kind !== filters.kind) continue;
      if (filters.scope && (entry.scope ?? "user") !== filters.scope) continue;
      if (q && !`${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(q)) continue;
      out.push({ entry, row });
    }
  }
  return out;
}

export function registerCapLs(cap: Command, deps: PublishDeps): void {
  cap
    .command("ls")
    .alias("list")
    .description("List capabilities across your machines")
    .option("-q, --query <text>", "Filter by name or description")
    .option("--kind <kind>", "skill | command | subagent | plugin | mcp | hook | snippet")
    .option("--scope <scope>", "user | project | local")
    .option("--client <client>", "claude | codex | cursor | …")
    .option("--json", "Machine-readable output")
    .action(async (opts: { query?: string; kind?: string; scope?: string; client?: string; json?: boolean }) => {
      const rows: DeviceStateRow[] = await apiPost(deps, "/cli/cap/status", {}, { read: true });
      const hits = filterEntries(rows, {
        q: opts.query,
        kind: opts.kind,
        scope: opts.scope,
        client: opts.client,
      });
      if (opts.json) {
        // The full parsed shape when unfiltered; the filtered subset otherwise.
        console.log(
          JSON.stringify(
            opts.query || opts.kind || opts.scope || opts.client
              ? hits.map(({ entry, row }) => ({ device_id: row.device_id, client: row.client, ...entry }))
              : jsonShape(rows),
            null,
            2,
          ),
        );
        return;
      }
      if (hits.length === 0) {
        console.log(
          rows.length === 0
            ? "No machine has reported yet — run `cast cap status` for what to check."
            : "Nothing matches those filters.",
        );
        return;
      }
      for (const { entry, row } of hits) {
        console.log(formatCapabilityRow(entry, row.device_id));
      }
    });
}
