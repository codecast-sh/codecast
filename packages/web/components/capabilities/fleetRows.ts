// The fleet fold as the capabilities page reads it: one row per capability,
// one cell per machine, built on the shared diff (contracts/fleetDiff.ts).

import {
  buildFleetDiff,
  capabilityIdentity,
  fleetRowKey,
  type DeviceReport,
  type FleetDiffCell,
  type FleetDiffRow,
  type ObservedScope,
} from "@codecast/shared/contracts";
import type { CapabilityDevice, CapabilityKind } from "./kinds";

/** What `claude plugin details` reports a capability costs in context. */
export interface TokenCost {
  alwaysOn?: number;
  onInvoke?: number;
  alwaysOnUnderBound?: boolean;
  onInvokeUnderBound?: boolean;
  source?: "claude-plugin-details" | "measured" | "estimated";
  measuredAt?: number;
}

/** One capability as one machine reported it. A projection of the daemon's
 *  `InventoryItem` (packages/cli/src/capabilities/inventory.ts:36) — same field
 *  meanings, flattened so the browser never imports that Node-only module. */
export interface FleetInventoryItem {
  kind: CapabilityKind | string;
  name: string;
  /** The catalog slug when the machine knew one. Identity, when present. */
  slug?: string;
  description?: string;
  /** The contract's own scope union (`OBSERVED_SCOPES`), not a second spelling
   *  of it. The daemon reports one of these three and the diff reasons about
   *  the same three, so a local copy could only ever drift from them. */
  scope: ObservedScope;
  /** False = switched off on purpose. A decision, not an absence. */
  enabled: boolean;
  /**
   * Whether the bytes are on disk, independent of `enabled` — the pair is what
   * tells a broken install (declared, never downloaded) from an offer
   * (downloaded, never declared). Undefined means the machine did not say: most
   * kinds never report it, so only an explicit `false` is evidence of absence.
   */
  installed?: boolean;
  version?: string;
  sha?: string;
  marketplace?: string;
  cost?: TokenCost;
  source?: string;
  command?: string;
  url?: string;
  event?: string;
}

/**
 * A diff row plus the two things a grid needs that a diff does not have: its
 * cells addressable by device, and the catalog facts that only ever get printed.
 *
 * It EXTENDS `FleetDiffRow` — `identity`, `status`, `pinDrift`, `baselinePin`,
 * `cells` and the counts are the shared ones, unchanged. Nothing here restates a
 * fact the diff already carries. The name says `Grid` for the same reason: this
 * is one row as this grid draws it, not a second opinion about what a fleet row
 * is.
 */
export interface FleetGridRow extends FleetDiffRow {
  /** The library slug, when any machine had matched this entry to one. Never the
   *  identity: matching lands on one machine before another, and keying on it
   *  would split one capability into two rows. Same reasoning as the store slice
   *  (`store/capabilities.ts`, `CapabilityDriftRow.key`). */
  slug?: string;
  marketplace?: string;
  cost?: TokenCost;
  source?: string;
  command?: string;
  url?: string;
  event?: string;
  /** `FleetDiffRow.cells` keyed by device instead of positional. The array is
   *  right for computing and serialising; a column needs a lookup. Derived, so
   *  the two can never say different things. */
  byDevice: Record<string, FleetDiffCell>;
}

// --------------------------------------------------------------- the builder

export function shortPin(pin: string | undefined): string | undefined {
  if (!pin) return undefined;
  // A 40-char sha is unreadable in a 96px column and its first 7 are enough to
  // tell two installs apart, which is all this column has to do.
  return /^[0-9a-f]{16,64}$/i.test(pin) ? pin.slice(0, 7) : pin;
}

/**
 * Switched on in a settings file with nothing downloaded behind it.
 *
 * The diff gives this no cell status of its own, on purpose: it is not a state
 * of the FLEET, it is a state of one machine, and it is true even when there is
 * only one machine. It falls straight out of the two flags the contract keeps
 * separate, so reading it here costs nothing and invents nothing.
 */
export function isBroken(cell: FleetDiffCell): boolean {
  return cell.enabled && cell.installed === false;
}

/**
 * Is this machine's pin worth the cell, or is its scope?
 *
 * A cell prints one or the other, never both, so this is the whole of that
 * decision: print the pin when it is news — when this machine is not simply on
 * the one thing the fleet agreed about.
 *
 * TWO MACHINES THAT LOOK IDENTICAL AND ARE NOT. There are two ways to not be on
 * it and a cell's `status` misses both.
 *
 * `disabled` outranks `pin_differs`, so two machines with the same plugin
 * switched off at different shas both draw `disabled` and read as agreement.
 * `row.pins` catches that: it is every distinct pin any machine HOLDS, switched
 * on or off, where `pinDrift` counts only the machines running it.
 *
 * And `row.pins` is filtered to `row.pinKind`, so a machine reporting a weaker
 * kind — a version where the others have shas — is missing from that list
 * however far behind it is. On a row already badged drift, that column would
 * draw a bare slash with the one identifier it has hidden. Comparing the kinds
 * catches it, and says the honest thing: this pin never took part.
 *
 * `pin_differs` needs no clause of its own. It requires this cell's pin to be
 * of `row.pinKind` and to differ from a baseline that is also of that kind, so
 * both are in `row.pins` and the first test has already fired.
 */
export function pinIsNews(row: FleetGridRow, cell: FleetDiffCell): boolean {
  if (!cell.pin) return false;
  return row.pins.length > 1 || cell.pinKind !== row.pinKind;
}

/**
 * Rows the machines disagree about — the diff's own verdict, nothing added.
 *
 * `not_comparable` is neither drift nor agreement: with one machine reporting
 * there is no verdict to give, and filing those rows under either heading would
 * be an answer we do not have.
 */
function isDrifted(row: FleetGridRow): boolean {
  return row.status === "drift" || row.status === "unique";
}

/**
 * The fleet holds two builds of this, and nobody is running either.
 *
 * `pinDrift` counts only the machines RUNNING it, so a plugin switched off on
 * every machine at two different shas is `in_sync` by the diff's verdict — and
 * the diff is right that nobody is living with the difference today. It is
 * wrong to call it agreement, though: switch it on and the two machines load
 * different code. So the row is not drift, and it is not "in sync" either.
 */
function dormantPinSplit(row: FleetGridRow): boolean {
  return row.pins.length > 1 && !row.pinDrift;
}

/**
 * Rows worth reading first, which is a wider set than drift.
 *
 * A broken install is not a disagreement — it is true of a single machine, and
 * on a one-machine fleet it is the only thing on this page worth acting on. A
 * dormant pin split is not one either, for the opposite reason: it is true of
 * the whole fleet but of nothing it is currently running. Both belong at the top
 * without being counted as drift, which is why the section is headed "needs
 * attention" and the stat beside it still says "drift".
 */
export function needsAttention(row: FleetGridRow): boolean {
  return isDrifted(row) || dormantPinSplit(row) || row.cells.some(isBroken);
}

/**
 * Did this machine hand us a report we could read?
 *
 * TWO SILENCES, and this page must not confuse them. A machine that scanned and
 * found nothing has ANSWERED — its cells read `absent`. A machine whose report
 * never arrived or would not parse has told us nothing — its cells must read
 * `unknown`, or every capability the rest of the fleet has draws as `absent` on
 * that column and the page manufactures the drift it exists to detect.
 *
 * The report map carries the answer, and `reportedAt` cannot: the store stamps
 * that from `reported_at` when the row lands, before anything tries to parse the
 * payload. So an ENTRY in the map — empty or not — is a payload we read, and no
 * entry is a machine we have nothing usable from. `buildFleetReports`
 * (CapabilitiesPage) is what upholds that, skipping the rows the store marked
 * unreadable or withheld.
 *
 * The timestamp is still asked, second, and it is not redundant. It answers a
 * question the map cannot: whether the ROSTER has ever heard from this machine
 * at all. A leftover entry for a device the roster calls silent must not
 * resurrect it as a reporter. The two clauses fail in the same direction —
 * toward `unknown`, the state that invents no drift — which is why they are an
 * `&&` rather than a judgement call.
 *
 * Every cell, every count and every empty state on this page turns on this one
 * question, so it is asked once here instead of spelled out at each of them.
 */
export function hasReadableReport(
  device: CapabilityDevice,
  reports: Record<string, FleetInventoryItem[] | undefined>,
): boolean {
  return device.reportedAt !== null && reports[device.deviceId] !== undefined;
}

/** Display facts no diff has a reason to model, indexed by the diff's OWN row
 *  key (`fleetRowKey`). A second spelling of that key here — which is what this
 *  file used to carry — is a join that works until the day the two disagree. */
interface RowDisplay {
  slug?: string;
  marketplace?: string;
  cost?: TokenCost;
  source?: string;
  command?: string;
  url?: string;
  event?: string;
}

/**
 * Run the shared fleet diff over what the machines reported, and dress each row
 * for the grid.
 *
 * The adapter does three things and no fourth:
 *
 * **It maps the page's inputs onto `DeviceReport[]`.** The pins go back into
 * `meta`, which is where the daemon's reader puts them and where the diff looks
 * for them; this surface flattened them out only to render them.
 *
 * **It says what "reported" means** — by asking `hasReadableReport`, which is
 * where that judgement lives for the whole page.
 *
 * **It carries `driftKeys` in.** The store's index (`selectCapabilityIndex` →
 * `CapabilityDriftRow.drifting`) compares CLIENTS within one machine, which this
 * grid folds into a single column and therefore cannot see. Its keys can only
 * escalate a row that already has a verdict — never `not_comparable`, because
 * one machine still cannot disagree with itself. The store keys rows with
 * `capabilityRowKey`, which is `fleetRowKey` spelled again, so the join needs no
 * translation.
 */
export function buildFleetRows(
  devices: CapabilityDevice[],
  /** Per device: the entries we could read, `[]` for a machine that has nothing,
   *  and NO ENTRY AT ALL for a machine whose report never arrived or would not
   *  parse. The caller owns that distinction because only it has the rollup that
   *  counts readable rows. */
  reports: Record<string, FleetInventoryItem[] | undefined>,
  driftKeys?: ReadonlySet<string>,
): FleetGridRow[] {
  const display = new Map<string, RowDisplay>();

  const deviceReports: DeviceReport[] = devices.map((device) => ({
    deviceId: device.deviceId,
    deviceLabel: device.name,
    reportedAt: device.reportedAt ?? undefined,
    inventory: hasReadableReport(device, reports)
      ? { items: (reports[device.deviceId] ?? []).map(toReportedItem) }
      : undefined,
  }));

  for (const device of devices) {
    if (!hasReadableReport(device, reports)) continue;
    for (const item of reports[device.deviceId] ?? []) {
      const identity = capabilityIdentity(item.kind as FleetGridRow["kind"], item.name, {
        marketplace: item.marketplace ?? "",
      });
      if (!identity) continue;
      const key = fleetRowKey(item.kind, identity);
      const prev = display.get(key);
      if (!prev) {
        display.set(key, {
          slug: item.slug,
          marketplace: item.marketplace,
          cost: item.cost,
          source: item.source,
          command: item.command,
          url: item.url,
          event: item.event,
        });
        continue;
      }
      // First non-empty wins — machines report the same capability, so a later
      // blank must not erase an earlier value.
      prev.slug ??= item.slug;
      prev.marketplace ??= item.marketplace;
      prev.cost ??= item.cost;
      prev.source ??= item.source;
      prev.command ??= item.command;
      prev.url ??= item.url;
      prev.event ??= item.event;
    }
  }

  // Already ordered most-interesting-first by the diff (`compareRows`), which
  // ranks a capability one machine is MISSING above one that is merely a version
  // behind. Re-sorting here would only be this file guessing at the same thing.
  return buildFleetDiff(deviceReports).rows.map((row) => {
    const dressed = display.get(row.key) ?? {};
    const byDevice: Record<string, FleetDiffCell> = {};
    for (const cell of row.cells) byDevice[cell.deviceId] = cell;
    return {
      ...row,
      status:
        row.status === "in_sync" && driftKeys?.has(row.key) ? ("drift" as const) : row.status,
      ...dressed,
      byDevice,
    };
  });
}

/**
 * One reported entry in the shape the diff reads.
 *
 * The version, the commit and the marketplace go under `meta` because that is
 * where a real inventory carries them — `pinOf` in the diff reads `meta.sha`,
 * then `meta.version`, and a plugin's identity is `name@marketplace`. This page
 * hoisted them to the top level purely to render them, and hoisting them back is
 * the whole of the conversion.
 */
function toReportedItem(item: FleetInventoryItem): Record<string, unknown> {
  const meta: Record<string, string> = {};
  if (item.sha) meta.sha = item.sha;
  if (item.version) meta.version = item.version;
  if (item.marketplace) meta.marketplace = item.marketplace;
  return {
    kind: item.kind,
    name: item.name,
    description: item.description,
    scope: item.scope,
    enabled: item.enabled,
    installed: item.installed,
    meta,
  };
}

// ------------------------------------------------- fleet ↔ catalog bridging

/**
 * The bare names a capability might be known by, lowercased and namespaced by
 * kind.
 *
 * The two sides spell the same thing differently: a machine reports a plugin as
 * `code-simplifier@claude-plugins-official`, while a catalog row calls it
 * `code-simplifier` inside the marketplace `claude-plugins-official` with the
 * slug `mkt/claude-plugins-official/code-simplifier`. Matching on one spelling
 * alone silently drops the cross-reference, which is the whole value of the
 * Library tab, so every form is indexed.
 *
 * The marketplace segment on its own is deliberately NOT a name. A plugin called
 * `code-simplifier@acme` would otherwise answer to `acme`, and attach a
 * machine's install to an unrelated catalog row that happens to be named after
 * the marketplace.
 */
function nameKeys(kind: string, name: string, slug?: string): string[] {
  const keys = new Set<string>();
  const add = (n: string | undefined) => {
    if (n) keys.add(`${kind}|${n.toLowerCase()}`);
  };
  add(name);
  const at = name.indexOf("@");
  if (at > 0) add(name.slice(0, at));
  if (slug) add(slug.split("/").pop());
  return [...keys];
}

export interface FleetSummaryCounts {
  devices: number;
  reporting: number;
  silent: number;
  /** Two or more machines have reported. False means there is no verdict to
   *  give, and the comparison numbers below are all structurally zero — which is
   *  a fact about the fleet, not about the capabilities. */
  comparable: boolean;
  capabilities: number;
  drift: number;
  missing: number;
  mismatched: number;
  disabled: number;
  broken: number;
}

// -------------------------------------------------------------- the summary

export type FleetFilter = "all" | "drift" | "missing" | "mismatched" | "disabled" | "broken";

/** One predicate per filter, shared by the counts below and the grid further
 *  down so a chip can never show a different number of rows than the stat that
 *  opened it. Every one reads a field the shared diff already decided. */
export const FLEET_FILTERS: Record<FleetFilter, (row: FleetGridRow) => boolean> = {
  all: () => true,
  drift: isDrifted,
  missing: (r) => r.absentCount > 0,
  // Every row where the machines hold more than one build, whether or not
  // anybody is running them. `pinDrift` alone counts only the machines RUNNING
  // it, and a stat that read "0 pin drift" over a grid printing two shas would
  // be the page contradicting itself — the same rule the counts below are built
  // on. What the two mean apart is still visible: a dormant split sits under
  // "needs attention" rather than under drift.
  mismatched: (r) => r.pinDrift || dormantPinSplit(r),
  disabled: (r) => r.disabledCount > 0,
  broken: (r) => r.cells.some(isBroken),
};

/**
 * The header's numbers.
 *
 * Every count is `FLEET_FILTERS` applied, so a stat and the view it opens can
 * never see different rows. A header that said "0 missing" over a column of
 * dashes would be the page contradicting itself.
 */
export function summarizeFleet(
  rows: FleetGridRow[],
  devices: CapabilityDevice[],
  reports: Record<string, FleetInventoryItem[] | undefined>,
): FleetSummaryCounts {
  const reporting = devices.filter((d) => hasReadableReport(d, reports)).length;
  const count = (f: FleetFilter) => rows.filter(FLEET_FILTERS[f]).length;
  return {
    devices: devices.length,
    reporting,
    silent: devices.length - reporting,
    comparable: reporting >= 2,
    capabilities: rows.length,
    drift: count("drift"),
    missing: count("missing"),
    mismatched: count("mismatched"),
    disabled: count("disabled"),
    broken: count("broken"),
  };
}
