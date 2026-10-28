"use client";

// What the machines report, joined to the device roster: the one data hook
// behind /capabilities.

import { useMemo } from "react";
import { useDevices } from "../DeviceBadge";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useSyncCapabilityState, useSyncCapabilityBindings } from "../../hooks/useSyncCapabilityState";
import { useSyncDevices } from "../../hooks/useSyncDevices";
import { useSyncTeamKit } from "../../hooks/useSyncTeamKit";
import {
  capabilityStateWakeSig,
  isCapabilityReportStale,
  parseCapabilityEntries,
  selectCapabilityIndex,
  type CapabilityStateRow,
} from "../../store/capabilities";
import type { FleetInventoryItem } from "./fleetRows";
import { toCapabilityDevice, type CapabilityDevice } from "./kinds";

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
  source?: unknown;
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
    source: str(raw.source),
    command: str(meta.command),
    url: str(meta.url),
    event: str(meta.event),
    cost: (raw.cost ?? undefined) as FleetInventoryItem["cost"],
  };
}

/**
 * The per-device report map the matrix reads: what each machine told us, and
 * NO ENTRY AT ALL for a machine that told us nothing we could use.
 *
 * That absence is the load-bearing part, and it is the reason this is a function
 * rather than a loop inside the hook. `hasReadableReport` treats an entry —
 * empty or not — as a machine that answered, so a machine seeded here with `[]`
 * has every capability the rest of the fleet holds drawn as `absent` in its
 * column. Two of the three ways a row can carry no entries are not answers:
 *
 * - **unreadable**: the payload would not parse.
 * - **withheld**: the payload was never sent. `webList` spends a response byte
 *   budget across the fleet and elides the payload of the rows past it, so the
 *   machine with the MOST installed is the first to lose its payload — the exact
 *   machine that would then render as the emptiest, with every row on the page
 *   badged drift against it.
 *
 * Only the third — parsed, and it listed nothing — is a machine that answered.
 *
 * One machine sends several rows, one per agent client and scope. A client whose
 * payload is missing does not silence the machine, so the entry is created by
 * the rows that DID parse and the rest contribute nothing.
 */
export function buildFleetReports(
  collection: Record<string, CapabilityStateRow>,
): Record<string, FleetInventoryItem[] | undefined> {
  const reports: Record<string, FleetInventoryItem[] | undefined> = {};
  for (const id in collection) {
    const row = collection[id];
    if (!row?.device_id) continue;
    const parsed = parseCapabilityEntries(row);
    if (parsed.unreadable || parsed.withheld) continue;
    const items = reports[row.device_id] ?? (reports[row.device_id] = []);
    for (const entry of parsed.entries) {
      const item = toInventoryItem(entry as ObservedEntry, row.scope_key ?? "");
      if (item) items.push(item);
    }
  }
  return reports;
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
// Mounted by the page (not the layout): the fleet mirror is only worth its
// subscription while someone is looking at it.
export function useCapabilityFleet(): {
  devices: CapabilityDevice[];
  reports: Record<string, FleetInventoryItem[] | undefined>;
  driftKeys: Set<string>;
  loading: boolean;
} {
  useSyncCapabilityState();
  useSyncCapabilityBindings();
  useSyncTeamKit();
  const { devices } = useDevices();
  // `useDevices().loaded` is `devices.length > 0`, which cannot tell "the roster
  // has not answered" from "this account owns no machines" — and that is exactly
  // the distinction between a skeleton and the "no machines yet" panel. Reading
  // the same query here costs nothing: the Convex client keys a watch by query
  // and args, so this is the identical subscription every device chip in the app
  // already holds, read for whether it has resolved rather than for its rows.
  // Store-fed: a persisted roster resolves at boot; the feeder's `ready` (or a
  // populated cache) is what tells the skeleton from the "no machines" panel.
  const { ready: rosterLive } = useSyncDevices();
  const rosterCached = useInboxStore((s) => s.machineRoster.length > 0);
  const rosterResolved = rosterLive || rosterCached;
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

    const reports = buildFleetReports(collection);

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
