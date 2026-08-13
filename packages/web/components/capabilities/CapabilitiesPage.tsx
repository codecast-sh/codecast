"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Blocks, Library, MonitorSmartphone } from "lucide-react";
import { AuthGuard } from "../AuthGuard";
import { SegmentedToggle } from "../SegmentedToggle";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useDevices } from "../DeviceBadge";
import { useInboxStore } from "../../store/inboxStore";
import {
  buildFleetRows,
  catalogFromFleet,
  FleetMatrix,
  FleetSummary,
  summarizeFleet,
  withFleetInstalls,
  type FleetFilter,
  type FleetInventoryItem,
  type FleetRow,
} from "./FleetMatrix";
import { LibraryBrowse } from "./LibraryBrowse";
import {
  kindMeta,
  ScopeChip,
  toCapabilityDevice,
  type CapabilityDevice,
  type CatalogEntry,
} from "./CapabilityCard";
import { TokenCostBadge } from "./TokenCostBadge";
import { Cmd, LoadingMatrix } from "./EmptyStates";

/**
 * /capabilities — what every machine you own actually has, and what you could add.
 *
 * Two tabs, and they answer different questions:
 *
 *   Machines  one column per device, one row per capability. Drift first, because
 *             "my laptop is missing the skill I use every day" is the thing no
 *             single-machine tool can ever tell you.
 *   Library   the public catalogs, cross-referenced against your fleet and priced
 *             in context tokens — the two columns `/plugin` and the web catalogs
 *             do not have.
 *
 * This page never writes anything. It reads inventories the daemons already
 * report and renders the comparison, so it carries no consent model, no ownership
 * ledger and no security surface.
 */

// ------------------------------------------------------------- data plumbing

/**
 * One machine's inventory report, as `capability_state` holds it.
 *
 * `entries_json` is a JSON string on purpose, not an object: the inventory is
 * kilobytes and Convex versions whole documents, so keeping it as an opaque
 * string in its own table is what stops a heartbeat from rewriting the whole
 * payload (the same reason `user_skills.skills_json` exists). We parse it here,
 * once per distinct string.
 */
interface CapabilityStateRow {
  device_id?: string;
  entries_json?: string;
  /** Already-parsed entries, when a source hands them over directly. */
  entries?: FleetInventoryItem[];
  reported_at?: number;
  last_error?: string;
  client_version?: string;
}

// Parsing the same multi-kilobyte string on every render would be pure waste,
// and the string only changes when a machine's inventory actually changes (the
// daemon hash-gates the report). Keyed by the raw string, bounded so a long
// session cannot accumulate stale payloads.
const PARSE_CACHE = new Map<string, FleetInventoryItem[]>();

function parseEntries(row: CapabilityStateRow | undefined): FleetInventoryItem[] | undefined {
  if (!row) return undefined;
  if (Array.isArray(row.entries)) return row.entries;
  const raw = row.entries_json;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const hit = PARSE_CACHE.get(raw);
  if (hit) return hit;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed report is a machine problem, not a page problem. Treat it as
    // "nothing parseable" — the device still renders, with its scan error.
    return undefined;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { items?: unknown })?.items)
      ? (parsed as { items: unknown[] }).items
      : null;
  if (!items) return undefined;
  const clean = items.filter(
    (i): i is FleetInventoryItem =>
      typeof i === "object" &&
      i !== null &&
      typeof (i as FleetInventoryItem).name === "string" &&
      typeof (i as FleetInventoryItem).kind === "string",
  );
  if (PARSE_CACHE.size > 32) PARSE_CACHE.clear();
  PARSE_CACHE.set(raw, clean);
  return clean;
}

/**
 * Devices plus their inventory reports.
 *
 * `useDevices()` is the roster every device chip in the app already uses. The
 * reports come from the store's `capabilityState` slice, read structurally
 * because that slice lands in a sibling change — until it does, every device
 * reports `reportedAt: null`, which the matrix renders as "not reported yet"
 * rather than as an empty machine. That is the correct answer either way: a
 * silent daemon and a clean machine are different facts.
 */
function useFleet(): { devices: CapabilityDevice[]; reports: Record<string, FleetInventoryItem[] | undefined>; loading: boolean } {
  const { devices, loaded } = useDevices();
  const capabilityState = useInboxStore(
    (s) => (s as unknown as { capabilityState?: Record<string, CapabilityStateRow> }).capabilityState,
  );

  return useMemo(() => {
    const sorted = [...devices].sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        Number(a.is_remote) - Number(b.is_remote) ||
        b.last_seen - a.last_seen,
    );
    const reports: Record<string, FleetInventoryItem[] | undefined> = {};
    const cols = sorted.map((d) => {
      const row = capabilityState?.[d.device_id];
      const entries = parseEntries(row);
      reports[d.device_id] = entries;
      return toCapabilityDevice(d, {
        // A row with no parseable entries has still reported if it carries a
        // timestamp — an empty machine is a real answer.
        reportedAt: row && typeof row.reported_at === "number" ? row.reported_at : undefined,
        error: row?.last_error,
        clientVersion: row?.client_version,
      });
    });
    return { devices: cols, reports, loading: !loaded && devices.length === 0 };
  }, [devices, loaded, capabilityState]);
}

// -------------------------------------------------------------- the detail

/** What one capability looks like machine by machine — the row's own story,
 *  shown under the matrix so clicking a row never navigates away from it. */
function RowDetail({
  row,
  devices,
  onClose,
}: {
  row: FleetRow;
  devices: CapabilityDevice[];
  onClose: () => void;
}) {
  const meta = kindMeta(String(row.kind));
  const Icon = meta?.icon ?? Blocks;
  return (
    <div className="rounded-lg border border-sol-magenta/40 bg-sol-card p-3">
      <div className="flex items-start gap-2">
        <Icon className="w-4 h-4 mt-0.5 text-sol-magenta flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-sol-text">{row.name}</span>
            <span className="text-[10px] text-sol-text-dim">{meta?.label ?? String(row.kind)}</span>
            {row.marketplace && (
              <span className="text-[10px] font-mono text-sol-text-dim">{row.marketplace}</span>
            )}
            <TokenCostBadge cost={row.cost} />
          </div>
          {row.description && (
            <p className="mt-1 text-xs text-sol-text-muted leading-relaxed">{row.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-sol-text-dim hover:text-sol-text"
        >
          close
        </button>
      </div>

      <div className="mt-3 grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
        {devices.map((d) => {
          const cell = row.cells[d.deviceId] ?? { state: "unknown" as const };
          return (
            <div
              key={d.deviceId}
              className="flex items-center gap-2 px-2 py-1.5 rounded border border-sol-border bg-sol-bg-alt"
            >
              <span className="text-[11px] text-sol-text truncate flex-1" title={d.name}>
                {d.name}
              </span>
              {cell.state === "unknown" ? (
                <span className="text-[10px] text-sol-yellow">not reported yet</span>
              ) : cell.state === "absent" ? (
                <span className="text-[10px] text-sol-text-dim">not installed</span>
              ) : (
                <span className="flex items-center gap-1">
                  {cell.scope && <ScopeChip scope={cell.scope} />}
                  {cell.pin && (
                    <span
                      className={`text-[10px] font-mono ${
                        cell.state === "different" ? "text-sol-orange" : "text-sol-text-muted"
                      }`}
                    >
                      {cell.pin}
                    </span>
                  )}
                  {cell.state === "disabled" && (
                    <span className="text-[10px] text-sol-text-dim">off</span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] text-sol-text-dim">
        This page only reads. To change a machine, run <Cmd>cast cap</Cmd> on it — copying a
        capability across the fleet lands in a later release.
      </p>
    </div>
  );
}

// ----------------------------------------------------------------- the page

type Tab = "machines" | "library";

export interface CapabilitiesPageProps {
  /**
   * The public catalog page, when a source is wired up. Left out, the Library
   * tab still works — it browses what your own machines have, which is a real
   * catalog with a real cross-reference, just bounded by your fleet.
   */
  catalog?: CatalogEntry[];
  catalogLoading?: boolean;
  catalogError?: string | null;
  onCatalogRetry?: () => void;
  hasMoreCatalog?: boolean;
  loadingMoreCatalog?: boolean;
  onLoadMoreCatalog?: () => void;
}

function CapabilitiesContent(props: CapabilitiesPageProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { devices, reports, loading } = useFleet();

  const urlTab = params?.get("tab");
  const tab: Tab = urlTab === "library" ? "library" : "machines";
  const setTab = (t: string) => {
    const base = pathname && pathname.startsWith("/capabilities") ? pathname : "/capabilities";
    // Through the router, so the tab is in the URL, survives a reload and lands
    // in browser history like every other view change in the shell.
    router.push(t === "machines" ? base : `${base}?tab=${t}`);
  };

  const [filter, setFilter] = useState<FleetFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const rows = useMemo(() => buildFleetRows(devices, reports), [devices, reports]);
  const counts = useMemo(() => summarizeFleet(rows, devices), [rows, devices]);
  const selected = selectedKey ? (rows.find((r) => r.key === selectedKey) ?? null) : null;

  // A public catalog when one is wired up, otherwise the fleet's own. Either way
  // the install sites come from the fleet, because that cross-reference is the
  // reason to browse here rather than in `/plugin`.
  const catalog: CatalogEntry[] | undefined = useMemo(() => {
    if (props.catalog) return withFleetInstalls(props.catalog, rows);
    if (rows.length === 0) return undefined;
    return catalogFromFleet(rows);
  }, [props.catalog, rows]);

  const kindTally = useMemo(() => {
    const t = new Map<string, number>();
    for (const r of rows) t.set(String(r.kind), (t.get(String(r.kind)) ?? 0) + 1);
    return [...t.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <div className="h-full overflow-y-auto" data-main-scroll>
      <div className="mx-auto w-full max-w-[1400px] px-4 py-5 space-y-4">
        <header className="flex items-start gap-3 flex-wrap">
          <div className="mt-0.5 text-sol-magenta">
            <Blocks className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-serif text-sol-text">Capabilities</h1>
            <p className="text-sm text-sol-text-muted mt-1 max-w-2xl leading-relaxed">
              Every skill, command, subagent, plugin and MCP server your machines have — side by
              side. Nothing here writes to a machine.
            </p>
          </div>
          <SegmentedToggle
            value={tab}
            onChange={setTab}
            items={[
              { key: "machines", label: "Machines", icon: MonitorSmartphone, title: "Compare your fleet" },
              { key: "library", label: "Library", icon: Library, title: "Browse what you could add" },
            ]}
          />
        </header>

        {tab === "machines" ? (
          loading ? (
            <LoadingMatrix />
          ) : (
            <>
              <FleetSummary counts={counts} filter={filter} onFilter={setFilter} />

              <div className="flex items-center gap-2 flex-wrap">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setQuery("");
                    }
                  }}
                  placeholder="Filter capabilities"
                  className="h-7 px-2 w-56 text-xs bg-sol-bg-alt border border-sol-border rounded text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-magenta/60"
                />
                {kindTally.length > 0 && (
                  <span className="text-[11px] text-sol-text-dim font-mono truncate">
                    {kindTally
                      .map(([k, n]) => `${n} ${kindMeta(k)?.plural ?? k}`)
                      .join(" · ")}
                  </span>
                )}
                <div className="flex-1" />
                <span className="hidden md:inline-flex items-center gap-1 text-[10px] text-sol-text-dim">
                  <KeyCap size="xs">Esc</KeyCap>
                  clears
                </span>
              </div>

              <FleetMatrix
                devices={devices}
                rows={rows}
                filter={filter}
                query={query}
                selectedKey={selectedKey}
                onSelect={(row) => setSelectedKey((k) => (k === row.key ? null : row.key))}
              />

              {selected && (
                <RowDetail row={selected} devices={devices} onClose={() => setSelectedKey(null)} />
              )}

              {counts.silent > 0 && counts.reporting > 0 && (
                <p className="text-[11px] text-sol-text-dim">
                  {counts.silent} {counts.silent === 1 ? "machine has" : "machines have"} never sent
                  an inventory, so {counts.silent === 1 ? "its" : "their"} column reads unknown
                  rather than empty. Update the CLI there with <Cmd>cast update</Cmd>.
                </p>
              )}
            </>
          )
        ) : (
          <>
            {!props.catalog && catalog && (
              <p className="text-[11px] text-sol-text-dim">
                Browsing what your own machines report. The public marketplace catalog has not been
                ingested for this deployment yet — when it is, these rows keep their
                cross-reference and gain everything you have not installed.
              </p>
            )}
            <LibraryBrowse
              entries={catalog}
              devices={devices}
              loading={props.catalogLoading || loading}
              error={props.catalogError ?? null}
              onRetry={props.onCatalogRetry}
              hasMore={props.hasMoreCatalog}
              loadingMore={props.loadingMoreCatalog}
              onLoadMore={props.onLoadMoreCatalog}
              onOpen={(entry) => {
                // Catalog entries derived from the fleet map straight back onto a
                // matrix row, so opening one shows the machine-by-machine detail
                // instead of a dead end.
                const key = `${entry.kind}:${entry.name}`;
                if (rows.some((r) => r.key === key)) {
                  setSelectedKey(key);
                  setTab("machines");
                } else if (entry.homepage) {
                  window.open(entry.homepage, "_blank", "noopener,noreferrer");
                }
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default function CapabilitiesPage(props: CapabilitiesPageProps) {
  return (
    <AuthGuard>
      <CapabilitiesContent {...props} />
    </AuthGuard>
  );
}
