// Every `cast cap` verb's rendering, in one place.
//
// Five commands across two phases print the same device and capability rows,
// and all of them show publisher-controlled text to a reader that may be an
// agent. One formatter module means the fence and truncation rules are applied
// exactly once — a verb cannot forget them, because no verb formats anything
// itself.

import { fenceUnlessBuiltin } from "./fence.js";

/** One device's report as /cli/cap/status returns it. */
export interface DeviceStateRow {
  device_id: string;
  client: string;
  scope_key: string;
  entries_json: string;
  hash: string;
  reported_at: number;
  client_version: string | null;
  scan_error: string | null;
  truncated: boolean;
}

export interface CapabilityEntry {
  kind: string;
  name: string;
  scope?: string;
  enabled?: boolean;
  slug?: string;
  description?: string;
  meta?: Record<string, string>;
}

/** Publisher text bounded for a terminal: the server caps at 1024, this is a
 *  display bound — a description is a line, not a page. */
const DESCRIPTION_COLUMN = 96;

export function relativeAge(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Parse a row's opaque entries. Total: bad JSON is a report problem to show,
 *  never a crash. */
export function parseEntries(row: DeviceStateRow): { items: CapabilityEntry[]; error?: string } {
  try {
    const parsed = JSON.parse(row.entries_json);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return { items };
  } catch {
    return { items: [], error: "unreadable report (bad JSON)" };
  }
}

/**
 * The status matrix: one line per device per client, counts by kind, honest
 * about staleness, truncation and scan errors.
 */
export function formatDeviceMatrix(rows: DeviceStateRow[], now = Date.now()): string {
  if (rows.length === 0) {
    return [
      "No machine has reported capabilities yet.",
      "The daemon reports on its heartbeat once it runs a build with the scanner —",
      "check `cast doctor`, or update the CLI on the machine you expected here.",
    ].join("\n");
  }
  const lines: string[] = [];
  for (const row of rows) {
    const { items, error } = parseEntries(row);
    const byKind = new Map<string, number>();
    for (const item of items) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    const counts =
      [...byKind.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`)
        .join(", ") || "nothing installed";
    const scope = row.scope_key === "" ? "" : `  [${row.scope_key}]`;
    const flags = [
      row.truncated ? "TRUNCATED report" : "",
      error ?? "",
      row.scan_error ? `scan error: ${row.scan_error}` : "",
    ]
      .filter(Boolean)
      .map((f) => `  !! ${f}`)
      .join("");
    lines.push(
      `${row.device_id}  ${row.client}${scope}  ${counts}  · ${relativeAge(row.reported_at, now)}${flags}`,
    );
  }
  return lines.join("\n");
}

/** One capability as a list line. Foreign text fenced with its provenance. */
export function formatCapabilityRow(entry: CapabilityEntry, deviceLabel?: string): string {
  const state = entry.enabled === false ? "off" : "on";
  const scope = entry.scope && entry.scope !== "user" ? ` @${entry.scope}` : "";
  const where = deviceLabel ? `  (${deviceLabel})` : "";
  const head = `${entry.kind}  ${entry.name}${scope}  ${state}${where}`;
  if (!entry.description) return head;
  const provenance = entry.meta?.marketplace
    ? `marketplace ${entry.meta.marketplace}`
    : `${entry.kind} ${entry.name}`;
  const bounded =
    entry.description.length > DESCRIPTION_COLUMN
      ? entry.description.slice(0, DESCRIPTION_COLUMN - 1) + "…"
      : entry.description;
  return `${head}\n  ${fenceUnlessBuiltin(bounded, entry.slug ?? "", provenance).split("\n").join("\n  ")}`;
}

/** The --json shapes are the parsed data, never the fenced strings: a program
 *  consuming JSON applies its own trust handling, and baking terminal fences
 *  into JSON would just teach parsers to strip them. */
export function jsonShape(rows: DeviceStateRow[]): unknown {
  return rows.map((row) => {
    const { items, error } = parseEntries(row);
    return {
      device_id: row.device_id,
      client: row.client,
      scope_key: row.scope_key,
      reported_at: row.reported_at,
      hash: row.hash,
      truncated: row.truncated,
      scan_error: row.scan_error,
      parse_error: error ?? null,
      items,
    };
  });
}
