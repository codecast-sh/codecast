"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Blocks, Library, MonitorSmartphone } from "lucide-react";
import { AuthGuard } from "../AuthGuard";
import { SegmentedToggle } from "../SegmentedToggle";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useDevices } from "../DeviceBadge";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  capabilityStateWakeSig,
  isCapabilityReportStale,
  parseCapabilityEntries,
  selectCapabilityIndex,
  type CapabilityStateRow,
} from "../../store/capabilities";
import {
  buildFleetRows,
  isBroken,
  catalogFromFleet,
  FleetMatrix,
  FleetSummary,
  summarizeFleet,
  withFleetInstalls,
  type FleetFilter,
  type FleetInventoryItem,
  type FleetGridRow,
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
 * What one entry in a machine's inventory looks like to this surface.
 *
 * The authoritative type is `InstalledEntry` in the shared contracts, and
 * `parseCapabilityEntries` hands those back. This is the SUBSET the matrix
 * draws, declared locally and read defensively: a field the contract has not
 * grown yet simply renders as absent instead of breaking the column.
 */
type ObservedEntry = {
  kind?: unknown;
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  enabled?: unknown;
  installed?: unknown;
  scope?: unknown;
  /** Kind-specific extras. The version, the commit and the marketplace live in
   *  here, not at the top level — that is where the daemon's reader puts them
   *  (`inventory.ts`, the `meta` folding at the end of `readInventory`). */
  meta?: unknown;
  cost?: unknown;
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

function toInventoryItem(raw: ObservedEntry, rowScopeKey: string): FleetInventoryItem | null {
  const kind = str(raw.kind);
  const name = str(raw.name);
  if (!kind || !name) return null;
  const scope = str(raw.scope);
  const meta = (raw.meta && typeof raw.meta === "object" ? raw.meta : {}) as Record<string, unknown>;
  return {
    kind,
    name,
    slug: str(raw.slug),
    description: str(raw.description),
    // The entry's own scope when it has one. Otherwise the row's: `scope_key` is
    // "" for user scope and a repo identity for a project, which is exactly the
    // distinction the cell letter shows.
    scope:
      scope === "user" || scope === "project" || scope === "local"
        ? scope
        : rowScopeKey === ""
          ? "user"
          : "project",
    // A missing `enabled` means present, matching the daemon's own reader: only
    // plugins carry a real off state, everything else is simply there.
    enabled: raw.enabled !== false,
    // Left undefined when the machine did not say. The contract requires the
    // field but the daemon's reader only fills it for plugins, so a missing one
    // means "not reported" — never "not downloaded", which would file every
    // skill on every machine as a broken install.
    installed: typeof raw.installed === "boolean" ? raw.installed : undefined,
    version: str(meta.version),
    sha: str(meta.sha),
    marketplace: str(meta.marketplace),
    cost: (raw.cost ?? undefined) as FleetInventoryItem["cost"],
  };
}

// A stable empty collection, so the wake signature does not churn before the
// slice is registered.
const NO_CAPABILITY_STATE: Record<string, CapabilityStateRow> = {};

function readCapabilityState(s: unknown): Record<string, CapabilityStateRow> {
  return (
    (s as { capabilityState?: Record<string, CapabilityStateRow> }).capabilityState ??
    NO_CAPABILITY_STATE
  );
}

/**
 * Devices plus their inventory reports.
 *
 * `useDevices()` is the roster every device chip in the app already uses;
 * everything about what the machines HAVE comes from `store/capabilities.ts`,
 * which owns the parse, the per-device rollup and the drift verdict. This hook
 * joins the two and adds nothing of its own.
 *
 * The subscription is the collection's wake signature, not the collection: a
 * background tab stays mounted, and a liveness restamp across the fleet would
 * otherwise re-render the whole matrix for a timestamp nobody reads. Staleness
 * is time-driven — no field changes when a report ages out — so the coarse clock
 * is what wakes that part.
 */
function useFleet(): {
  devices: CapabilityDevice[];
  reports: Record<string, FleetInventoryItem[] | undefined>;
  driftKeys: Set<string>;
  loading: boolean;
} {
  const { devices } = useDevices();
  // `useDevices().loaded` is `devices.length > 0`, which cannot tell "the roster
  // has not answered" from "this account owns no machines" — and that is exactly
  // the distinction between a skeleton and the "no machines yet" panel. Reading
  // the same query here costs nothing: the Convex client keys a watch by query
  // and args, so this is the identical subscription every device chip in the app
  // already holds, read for whether it has resolved rather than for its rows.
  const rosterResolved = useQuery(api.devices.listDevices, {}) !== undefined;
  const sig = useInboxStore((s) => capabilityStateWakeSig(readCapabilityState(s)));
  const now = useCoarseNow(60_000);

  return useMemo(() => {
    const collection = readCapabilityState(useInboxStore.getState());
    const index = selectCapabilityIndex({ capabilityState: collection });

    const sorted = [...devices].sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        Number(a.is_remote) - Number(b.is_remote) ||
        b.last_seen - a.last_seen,
    );

    // One machine reports several rows — one per agent client, per scope — so
    // the matrix reads the union of them.
    const reports: Record<string, FleetInventoryItem[] | undefined> = {};
    for (const id in collection) {
      const row = collection[id];
      if (!row?.device_id) continue;
      const items = reports[row.device_id] ?? (reports[row.device_id] = []);
      for (const entry of parseCapabilityEntries(row).entries) {
        const item = toInventoryItem(entry as ObservedEntry, row.scope_key ?? "");
        if (item) items.push(item);
      }
    }

    const cols = sorted.map((d) => {
      const rollup = index.devices[d.device_id];
      return toCapabilityDevice(d, {
        // Presence of a rollup — not a non-empty inventory — is what "reported"
        // means. A machine that scanned and found nothing has answered.
        reportedAt: rollup?.reportedAt,
        stale: rollup ? isCapabilityReportStale({ reported_at: rollup.reportedAt }, now) : false,
        error:
          rollup && rollup.errors.length > 0
            ? rollup.errors.join(" · ")
            : rollup && rollup.unreadableRows > 0
              ? `${rollup.unreadableRows} unreadable report${rollup.unreadableRows === 1 ? "" : "s"}`
              : undefined,
        clientVersion: rollup ? Object.values(rollup.clientVersions).join(" · ") : undefined,
      });
    });

    const driftKeys = new Set(index.drift.filter((r) => r.drifting).map((r) => r.key));
    // Loading is "we asked and nobody has answered". Once the roster resolves,
    // an empty fleet is an answer, and the empty states below say which kind of
    // nothing it is.
    return {
      devices: cols,
      reports,
      driftKeys,
      loading: !rosterResolved && devices.length === 0,
    };
    // `sig` is a dependency on purpose: the body reads the raw collection out of
    // the store, and the signature is what says a field this page draws changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, rosterResolved, sig, now]);
}

// -------------------------------------------------------------- the detail

/** What one capability looks like machine by machine — the row's own story,
 *  shown under the matrix so clicking a row never navigates away from it. */
function RowDetail({
  row,
  devices,
  onClose,
}: {
  row: FleetGridRow;
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
            <span className="font-mono text-sm text-sol-text">{row.identity}</span>
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
          const cell = row.byDevice[d.deviceId] ?? { status: "unknown" as const };
          return (
            <div
              key={d.deviceId}
              className="flex items-center gap-2 px-2 py-1.5 rounded border border-sol-border bg-sol-bg-alt"
            >
              <span className="text-[11px] text-sol-text truncate flex-1" title={d.name}>
                {d.name}
              </span>
              {cell.status === "unknown" ? (
                <span className="text-[10px] text-sol-yellow">not reported yet</span>
              ) : cell.status === "absent" ? (
                <span className="text-[10px] text-sol-text-dim">not installed</span>
              ) : isBroken(cell) ? (
                <span className="text-[10px] text-sol-red">switched on, nothing downloaded</span>
              ) : (
                <span className="flex items-center gap-1">
                  {/* Scopes stack: one capability can be switched on at user and
                      project scope at once, and each is a separate answer to
                      "why is this here?". The matrix cell shows only the notable
                      one because it has to stay scannable; this panel is where
                      the question gets answered in full, so show every scope. */}
                  {cell.scopes.map((scope) => (
                    <ScopeChip key={scope} scope={scope} />
                  ))}
                  {cell.pin && (
                    <span
                      className={`text-[10px] font-mono ${
                        cell.status === "pin_differs" ? "text-sol-orange" : "text-sol-text-muted"
                      }`}
                    >
                      {cell.pin}
                    </span>
                  )}
                  {cell.status === "disabled" && (
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
  const { devices, reports, driftKeys, loading } = useFleet();

  const urlTab = params.get("tab");
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

  const rows = useMemo(
    () => buildFleetRows(devices, reports, driftKeys),
    [devices, reports, driftKeys],
  );
  const counts = useMemo(() => summarizeFleet(rows, devices, reports), [rows, devices, reports]);
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
                reports={reports}
                rows={rows}
                filter={filter}
                query={query}
                selectedKey={selectedKey}
                onSelect={(row) => setSelectedKey((k) => (k === row.key ? null : row.key))}
                onClearFilters={() => {
                  setFilter("all");
                  setQuery("");
                }}
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
                // An entry whose slug is a matrix row key opens that row's
                // machine-by-machine detail. A public row we have nowhere is a
                // dead end here, so it goes out to its own page instead.
                if (entry.slug && rows.some((r) => r.key === entry.slug)) {
                  setSelectedKey(entry.slug);
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
