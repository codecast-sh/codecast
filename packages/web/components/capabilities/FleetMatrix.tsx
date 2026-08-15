"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Blocks,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Minus,
  Slash,
} from "lucide-react";
import {
  buildFleetDiff,
  capabilityIdentity,
  fleetRowKey,
  type DeviceReport,
  type FleetDiffCell,
  type FleetDiffRow,
  type ObservedScope,
} from "@codecast/shared/contracts";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { DeviceDot, relativeSeen } from "../DeviceBadge";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  kindMeta,
  type CapabilityDevice,
  type CapabilityKind,
  type CatalogEntry,
  type InstallSite,
} from "./CapabilityCard";
import { TokenCostBadge, type TokenCost } from "./TokenCostBadge";
import {
  AllInSync,
  DeviceNotReported,
  NoDevices,
  NoMatches,
  NothingInstalled,
  NothingReportedYet,
} from "./EmptyStates";

/**
 * The fleet matrix: one column per machine, one row per capability.
 *
 * It answers a question nothing else can — not `claude plugin list`, not the
 * `/plugin` browser, not a file on disk — because every one of those sees a
 * single machine. Drift is therefore the headline and the default ordering: the
 * rows where the machines disagree come first, and the rows where they agree are
 * folded away.
 *
 * The state a cell must never get wrong is "unknown". A machine that has never
 * sent an inventory is not a machine without the capability, and rendering it as
 * absent would manufacture drift that does not exist.
 *
 * THE VERDICT IS NOT COMPUTED HERE
 *
 * Every row, every cell and every count comes from `buildFleetDiff`
 * (`@codecast/shared/contracts`), the same function the daemon runs for
 * `cast cap status` and the server runs for the stored summary. This file used
 * to fold its own grid, and the two models disagreed in ways that were bugs
 * rather than preferences: a single `scope` per cell where Claude Code's scopes
 * stack, and a boolean drift flag that could not say "only one machine has
 * reported" — so a healthy lone machine read as "0 in sync".
 *
 * What stays here is display only, and it is derived from the shared row rather
 * than declared beside it: the cells keyed by device (the diff returns them as
 * an array parallel to `devices`, which is right for computing and wrong for
 * drawing a column), the short pin, and the catalog metadata the diff has no
 * reason to model.
 */

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
        display.set(key, { slug: item.slug, marketplace: item.marketplace, cost: item.cost });
        continue;
      }
      // First non-empty wins — machines report the same capability, so a later
      // blank must not erase an earlier value.
      prev.slug ??= item.slug;
      prev.marketplace ??= item.marketplace;
      prev.cost ??= item.cost;
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

function installsFromRow(row: FleetGridRow): InstallSite[] {
  const out: InstallSite[] = [];
  for (const cell of row.cells) {
    if (!cell.present) continue;
    out.push({
      deviceId: cell.deviceId,
      // `InstallSite` holds one scope where the machine reported several —
      // scopes stack, so the narrowest is the answer to "why is this here?" and
      // the rest are lost at this seam. See the note on `InstallSite` in
      // CapabilityCard.
      scope: cell.scopes[0] ?? "user",
      enabled: cell.enabled,
      broken: isBroken(cell),
      installedOnly: cell.installed === true && !cell.enabled,
      // The diff keeps a pin's kind because a commit and a version answer the
      // same question differently and must never be compared as bare strings.
      version: cell.pinKind === "version" ? cell.pin : undefined,
      sha: cell.pinKind === "sha" ? cell.pin : undefined,
    });
  }
  return out;
}

/**
 * A browsable catalog built from what your own machines already have.
 *
 * This is the honest fallback for the Library tab before any public catalog has
 * been ingested: it is a real catalog of real entries with a real
 * cross-reference, just bounded by your fleet rather than by a marketplace. It
 * reuses the matrix's rows so "what exists" is computed exactly once.
 */
export function catalogFromFleet(rows: FleetGridRow[]): CatalogEntry[] {
  return rows.map((row) => ({
    // The diff's row key, so a card maps straight back to its matrix row instead
    // of being re-derived and drifting apart. NOT `row.slug`: a slug appears
    // only once an entry has been matched to a library capability, which happens
    // on one machine before another.
    slug: row.key,
    name: row.identity,
    // A kind this release does not model is carried through verbatim. Relabelling
    // it as a skill would be a lie about the user's own machine, and every chip
    // on the card already renders an unknown kind as its own name.
    kind: row.kind,
    description: row.description,
    marketplace: row.marketplace,
    cost: row.cost,
    installs: installsFromRow(row),
  }));
}

/**
 * Attach each public catalog entry's real install sites, so a browsed row shows
 * where it already lives. Entries with no match keep an empty `installs`, which
 * renders as "installed nowhere" — correct, because every reporting machine told
 * us and none of them had it.
 *
 * A marketplace is part of the identity when both sides know one: two
 * marketplaces can publish a `code-simplifier`, and they are not the same thing.
 * The bare name is only trusted when one side has no marketplace to compare.
 */
export function withFleetInstalls(entries: CatalogEntry[], rows: FleetGridRow[]): CatalogEntry[] {
  if (rows.length === 0) return entries;
  const byName = new Map<string, FleetGridRow[]>();
  for (const row of rows) {
    for (const key of nameKeys(String(row.kind), row.identity)) {
      const bucket = byName.get(key);
      if (bucket) bucket.push(row);
      else byName.set(key, [row]);
    }
  }
  return entries.map((entry) => {
    // Public catalog rows arrive with no `installs` at all — the wire shape
    // from webCatalogList carries only what the registry knows. Absent means
    // "not cross-referenced yet", which is exactly what this function fills.
    if ((entry.installs?.length ?? 0) > 0) return entry;
    for (const key of nameKeys(String(entry.kind), entry.name, entry.slug)) {
      const row = byName
        .get(key)
        ?.find((r) => !r.marketplace || !entry.marketplace || r.marketplace === entry.marketplace);
      if (row) return { ...entry, installs: installsFromRow(row) };
    }
    return { ...entry, installs: entry.installs ?? [] };
  });
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

function SummaryStat({
  label,
  value,
  tone,
  active,
  onClick,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "accent" | "warn" | "muted";
  active?: boolean;
  onClick?: () => void;
  hint?: string;
}) {
  const valueTone =
    tone === "accent" ? "text-sol-magenta" : tone === "warn" ? "text-sol-orange" : "text-sol-text";
  const body = (
    <div
      className={`px-3 py-2 rounded-lg border text-left transition-colors ${
        active
          ? "border-sol-magenta/60 bg-sol-magenta/10"
          : "border-sol-border bg-sol-card hover:border-sol-magenta/40"
      } ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className={`font-mono text-lg leading-none ${valueTone}`}>{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-sol-text-dim">{label}</div>
    </div>
  );
  const wrapped = onClick ? (
    <button type="button" onClick={onClick} className="block">
      {body}
    </button>
  ) : (
    body
  );
  return hint ? (
    <ShortcutTooltip label={hint} side="bottom">
      {wrapped}
    </ShortcutTooltip>
  ) : (
    wrapped
  );
}

/** The header strip. Each count is also the filter that isolates it, so reading
 *  the number and acting on it are the same gesture. */
export function FleetSummary({
  counts,
  filter,
  onFilter,
}: {
  counts: FleetSummaryCounts;
  filter: FleetFilter;
  onFilter: (f: FleetFilter) => void;
}) {
  const toggle = (f: FleetFilter) => () => onFilter(filter === f ? "all" : f);
  // With one machine reporting there is nothing to compare, so these three
  // counts are zero by construction. Printing "0 drift" there would read as a
  // clean bill of health for a fleet nobody has checked; an em dash says we have
  // no answer, which is the truth.
  const compared = (n: number) => (counts.comparable ? n : "—");
  const onlyOneMachine = "only one machine has reported — there is nothing to compare yet";
  return (
    <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(112px,1fr))]">
      <SummaryStat
        label="machines"
        value={
          counts.silent > 0 ? (
            <span>
              {counts.reporting}
              <span className="text-sol-yellow text-sm">/{counts.devices}</span>
            </span>
          ) : (
            counts.devices
          )
        }
        hint={
          counts.silent > 0
            ? `${counts.silent} of ${counts.devices} have never reported an inventory`
            : "every machine has reported"
        }
      />
      <SummaryStat
        label="capabilities"
        value={counts.capabilities}
        hint="distinct skills, commands, subagents, plugins and MCP servers across the fleet"
      />
      <SummaryStat
        label="drift"
        value={compared(counts.drift)}
        tone={counts.drift > 0 ? "accent" : "muted"}
        active={filter === "drift"}
        onClick={counts.comparable ? toggle("drift") : undefined}
        hint={counts.comparable ? "rows where your machines disagree" : onlyOneMachine}
      />
      <SummaryStat
        label="missing"
        value={compared(counts.missing)}
        tone={counts.missing > 0 ? "warn" : "muted"}
        active={filter === "missing"}
        onClick={counts.comparable ? toggle("missing") : undefined}
        hint={counts.comparable ? "on some machines, absent from others" : onlyOneMachine}
      />
      <SummaryStat
        label="pin drift"
        value={compared(counts.mismatched)}
        tone={counts.mismatched > 0 ? "warn" : "muted"}
        active={filter === "mismatched"}
        onClick={counts.comparable ? toggle("mismatched") : undefined}
        hint={
          counts.comparable
            ? "your machines hold different commits or versions of it"
            : onlyOneMachine
        }
      />
      <SummaryStat
        label="switched off"
        value={counts.disabled}
        active={filter === "disabled"}
        onClick={toggle("disabled")}
        hint="present on a machine but deliberately disabled there"
      />
      <SummaryStat
        label="broken"
        value={counts.broken}
        tone={counts.broken > 0 ? "warn" : "muted"}
        active={filter === "broken"}
        onClick={toggle("broken")}
        hint="switched on in a settings file, with nothing downloaded behind it"
      />
    </div>
  );
}

// ----------------------------------------------------------------- the cell

/**
 * The scope worth printing in a cell, or nothing.
 *
 * Scopes stack, and almost everything on almost every machine is switched on at
 * user scope. Printing that is a column of noise the reader has to learn to
 * ignore; printing a single letter for it is worse, because a bare `u` next to a
 * capability name means nothing at all until somebody explains it. So user scope
 * shows no mark and the exceptional ones show their name — the narrowest, since
 * that is the one that answers "why is this here?". The full stack is in the
 * cell's tooltip, where a second scope is a detail rather than the headline.
 */
function notableScope(scopes: readonly ObservedScope[]): ObservedScope | undefined {
  // `FleetDiffCell.scopes` arrives narrowest first, so the first non-user entry
  // is the narrowest one.
  return scopes.find((s) => s !== "user");
}

/**
 * A cell's tooltip.
 *
 * Deliberately NOT `ShortcutTooltip`: that helper mounts its own
 * `TooltipProvider` per instance, which is right for the handful of chips in a
 * toolbar and wrong here — a matrix is rows times machines, so a fleet of four
 * and fifty capabilities would mount two hundred providers. `FleetMatrix` mounts
 * exactly one and every cell shares it.
 */
function CellTip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="top"
        className="bg-sol-bg text-sol-text border border-sol-border shadow-md max-w-xs"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * "b is on 2222222" — the other machines' pins, named.
 *
 * Used when the fleet has split with no majority, where "the rest of the fleet
 * is on X" would describe a fleet that does not exist. Naming the machines is
 * both true and more useful: it says who to go and look at.
 */
function otherPinsLine(row: FleetGridRow, devices: CapabilityDevice[], selfId: string): string {
  const named: string[] = [];
  let more = 0;
  for (const d of devices) {
    if (d.deviceId === selfId) continue;
    const pin = shortPin(row.byDevice[d.deviceId]?.pin);
    if (!pin) continue;
    if (named.length < 3) named.push(`${d.name} is on ${pin}`);
    else more++;
  }
  if (named.length === 0) return "no other machine reported a pin";
  return more > 0 ? `${named.join(", ")} +${more} more` : named.join(", ");
}

/** What a pin ANSWERS, so a tooltip never calls a version string a commit. */
const PIN_NOUN: Record<NonNullable<FleetDiffCell["pinKind"]>, string> = {
  sha: "commit",
  version: "version",
  url: "url",
  repo: "repo",
};

/**
 * "user scope", or "local and project scope" — scopes stack, so a cell can
 * honestly be switched on in more than one place and the tooltip says both.
 *
 * No fallback for an empty list, and that is deliberate. The diff resolves an
 * unrecorded scope to `user` in `scopeOf`, at the one place that should decide
 * it, so every cell that is present at all arrives with at least one. Defaulting
 * a second time here would be a copy of that rule sitting where nobody would
 * think to update it.
 */
function scopeLine(cell: FleetDiffCell): string {
  return `${cell.scopes.join(" and ")} scope`;
}

function Cell({
  cell,
  device,
  devices,
  row,
}: {
  cell: FleetDiffCell;
  device: CapabilityDevice;
  devices: CapabilityDevice[];
  row: FleetGridRow;
}) {
  const broken = isBroken(cell);
  const scope = notableScope(cell.scopes);
  const pin = shortPin(cell.pin);
  const showPin = pinIsNews(row, cell);

  const label = useMemo(() => {
    const head = (
      <span className="text-sol-text">
        {device.name}
        <span className="text-sol-text-dim"> · {row.identity}</span>
      </span>
    );
    // Where this machine's pin sits relative to everyone else's — the sentence
    // that explains a drifted row. `baselinePin` is the pin most of the fleet
    // RUNS; when the fleet has split with no baseline, naming the machines is
    // both true and more useful than describing a majority that does not exist.
    const pinLine = pin && (
      <span className={cell.status === "pin_differs" ? "text-sol-orange" : "text-sol-text-muted"}>
        {PIN_NOUN[cell.pinKind ?? "version"]} {pin}
        {row.pins.length > 1 &&
          ` — ${
            row.baselinePin && row.baselinePin !== cell.pin
              ? `the rest of the fleet is on ${shortPin(row.baselinePin)}`
              : otherPinsLine(row, devices, device.deviceId)
          }`}
      </span>
    );

    if (cell.status === "unknown") {
      return (
        <span className="flex flex-col text-left">
          {head}
          <span className="text-sol-yellow">
            never reported an inventory — we do not know whether it is here
          </span>
        </span>
      );
    }
    if (cell.status === "absent") {
      return (
        <span className="flex flex-col text-left">
          {head}
          <span>not installed here</span>
        </span>
      );
    }
    if (broken) {
      return (
        <span className="flex flex-col text-left">
          {head}
          <span className="text-sol-red">
            switched on at {scopeLine(cell)}, but nothing was ever downloaded
          </span>
          <span className="text-sol-text-dim">
            Nothing loads there. Reinstall it on {device.name}, or switch it off so the settings
            file stops claiming it.
          </span>
        </span>
      );
    }
    if (cell.status === "disabled") {
      return (
        <span className="flex flex-col text-left">
          {head}
          <span>
            {cell.installed === true
              ? "downloaded but never switched on"
              : `switched off at ${scopeLine(cell)}`}
          </span>
          {pinLine}
        </span>
      );
    }
    return (
      <span className="flex flex-col text-left">
        {head}
        <span>enabled at {scopeLine(cell)}</span>
        {pinLine}
      </span>
    );
  }, [cell, device, devices, row, broken, pin]);

  const body =
    cell.status === "unknown" ? (
      <CircleDashed className="w-3.5 h-3.5 text-sol-yellow" />
    ) : cell.status === "absent" ? (
      <Minus className="w-3.5 h-3.5 text-sol-text-dim" />
    ) : broken ? (
      <AlertTriangle className="w-3.5 h-3.5 text-sol-red" />
    ) : cell.status === "disabled" ? (
      <span className="inline-flex items-center gap-1 text-[10px] font-mono text-sol-text-dim">
        <Slash className="w-3 h-3 flex-shrink-0" />
        {showPin ? <span className="truncate">{pin}</span> : scope ? <span>{scope}</span> : null}
      </span>
    ) : (
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-mono min-w-0 ${
          cell.status === "pin_differs" ? "text-sol-orange" : "text-sol-text-muted"
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-[2px] flex-shrink-0 ${
            cell.status === "pin_differs" ? "bg-sol-orange" : "bg-sol-green"
          }`}
        />
        <span className="truncate">{showPin ? pin : (scope ?? "")}</span>
      </span>
    );

  return (
    <CellTip label={label}>
      <div
        className={`h-full flex items-center justify-center px-1.5 border-l ${
          cell.status === "unknown"
            ? "border-l-sol-yellow/20 bg-sol-yellow/[0.04]"
            : broken
              ? "border-l-sol-red/20 bg-sol-red/[0.07]"
              : cell.status === "pin_differs"
                ? "border-l-sol-orange/20 bg-sol-orange/[0.06]"
                : "border-l-[color-mix(in_srgb,var(--sol-border)_60%,transparent)]"
        }`}
      >
        {body}
      </div>
    </CellTip>
  );
}

// ------------------------------------------------------------- the matrix

/** `reported` is `hasReadableReport`, not `d.reportedAt !== null`: a machine
 *  whose payload would not parse has a timestamp and no inventory, and its
 *  column must say so rather than head a column of `unknown` cells with a time.
 *  The scan error underneath names which of the two silences it is. */
function DeviceHeader({ d, reported }: { d: CapabilityDevice; reported: boolean }) {
  // A coarse clock, not the data subscription: the relative time has to keep
  // moving without the matrix re-rendering on every heartbeat.
  const now = useCoarseNow(30_000);
  // `now` is a dependency on purpose: "3h ago" is a function of the clock, and
  // nothing in the row changes when the clock moves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seen = useMemo(() => relativeSeen(d.reportedAt ?? d.lastSeen), [d.reportedAt, d.lastSeen, now]);
  return (
    <div className="px-1.5 py-2 border-l border-l-[color-mix(in_srgb,var(--sol-border)_60%,transparent)] min-w-0">
      <div className="flex items-center gap-1 min-w-0">
        <DeviceDot online={d.online} />
        <span className="text-[11px] text-sol-text truncate" title={d.name}>
          {d.name}
        </span>
      </div>
      <div className="mt-0.5 text-[9px] text-sol-text-dim truncate">{d.kindLabel}</div>
      {!reported ? (
        <div className="mt-0.5">
          <DeviceNotReported name={d.name} />
        </div>
      ) : (
        <div
          className={`mt-0.5 text-[9px] truncate ${d.stale ? "text-sol-yellow" : "text-sol-text-dim"}`}
          title={
            d.stale
              ? `Last report ${seen}. The daemon writes at least hourly, so this machine's inventory may be out of date.`
              : d.clientVersion
          }
        >
          {seen}
          {d.stale ? " · stale" : ""}
        </div>
      )}
      {d.error && (
        <div className="mt-0.5 text-[9px] text-sol-red truncate" title={d.error}>
          scan failed
        </div>
      )}
    </div>
  );
}

function RowHead({
  row,
  selected,
  onSelect,
}: {
  row: FleetGridRow;
  selected: boolean;
  onSelect?: (row: FleetGridRow) => void;
}) {
  const meta = kindMeta(String(row.kind));
  // A kind this release does not model still gets an icon, so its name starts on
  // the same pixel as every other row's. The tooltip carries the raw kind, which
  // is all we honestly know about it.
  const Icon = meta?.icon ?? Blocks;
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 min-w-0 ${
        onSelect ? "cursor-pointer" : ""
      } ${needsAttention(row) ? "border-l-2 border-l-sol-magenta" : "border-l-2 border-l-transparent"}`}
      onClick={onSelect ? () => onSelect(row) : undefined}
      role={onSelect ? "button" : undefined}
      tabIndex={-1}
    >
      <CellTip label={meta?.label ?? String(row.kind)}>
        <span className="flex-shrink-0 text-sol-text-dim cursor-default">
          <Icon className="w-3.5 h-3.5" />
        </span>
      </CellTip>
      <span
        className={`font-mono text-xs truncate ${selected ? "text-sol-magenta" : "text-sol-text"}`}
        title={row.description ? `${row.identity} — ${row.description}` : row.identity}
      >
        {row.identity}
      </span>
      {row.description && (
        <span className="hidden lg:inline text-[11px] text-sol-text-dim truncate min-w-0 flex-1">
          {row.description}
        </span>
      )}
      {/* Only when a number exists. An estimate is labelled as one in the badge's
          own tooltip, and a missing cost renders nothing here rather than a
          zero — most kinds have no cost figure at all. */}
      {row.cost && (
        <span className="ml-auto flex-shrink-0 hidden xl:inline">
          <TokenCostBadge cost={row.cost} variant="compact" />
        </span>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  tone,
  children,
  defaultOpen = true,
}: {
  title: string;
  count: number;
  tone?: "accent";
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  // Derived from `defaultOpen`, not merely seeded by it. The fold state means
  // "there is something more urgent above", and that becomes true the moment the
  // first inventory lands — after this section has already mounted with nothing
  // to be more urgent than. A user's own toggle still sticks until the intent
  // itself flips.
  const [fold, setFold] = useState({ open: defaultOpen, from: defaultOpen });
  if (fold.from !== defaultOpen) setFold({ open: defaultOpen, from: defaultOpen });
  const open = fold.open;
  const setOpen = (next: (v: boolean) => boolean) =>
    setFold((f) => ({ ...f, open: next(f.open) }));
  if (count === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="col-span-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] uppercase tracking-wide text-sol-text-dim hover:text-sol-text border-t border-sol-border bg-sol-bg-alt"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className={tone === "accent" ? "text-sol-magenta" : ""}>{title}</span>
        <span className="font-mono">{count}</span>
      </button>
      {open && children}
    </>
  );
}

export function FleetMatrix({
  devices,
  reports,
  rows,
  selectedKey,
  onSelect,
  filter = "all",
  query,
  onClearFilters,
}: {
  devices: CapabilityDevice[];
  /** The same map `buildFleetRows` was given. The grid needs it for one
   *  question only — which machines answered — and that answer decides which
   *  empty state it draws, so it must be the one the cells were built from. */
  reports: Record<string, FleetInventoryItem[] | undefined>;
  rows: FleetGridRow[];
  selectedKey?: string | null;
  onSelect?: (row: FleetGridRow) => void;
  filter?: FleetFilter;
  query?: string;
  /** The filter and the query live on the page, so an empty result offers the
   *  way out only when the page hands one down. */
  onClearFilters?: () => void;
}) {
  const reporting = devices.filter((d) => hasReadableReport(d, reports));

  const visible = useMemo(() => {
    const q = query?.trim().toLowerCase();
    const matchesFilter = FLEET_FILTERS[filter] ?? FLEET_FILTERS.all;
    return rows.filter((r) => {
      if (!matchesFilter(r)) return false;
      if (!q) return true;
      return (
        r.identity.toLowerCase().includes(q) ||
        String(r.kind).toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q) ||
        (r.marketplace ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, filter, query]);

  const drifted = visible.filter(needsAttention);
  const agreed = visible.filter((r) => !needsAttention(r));

  if (devices.length === 0) return <NoDevices />;
  if (reporting.length === 0) return <NothingReportedYet deviceCount={devices.length} />;

  // The name column keeps a generous minimum so a slug is never truncated to
  // nothing, and a ceiling so two machines do not push the device columns to the
  // far edge of a wide screen. The device columns are fixed, so N machines
  // scroll rather than squeeze into unreadable slivers, and a trailing spacer
  // absorbs whatever is left.
  const template = `minmax(240px, 1fr) repeat(${devices.length}, minmax(104px, 140px))`;

  return (
    <TooltipProvider delayDuration={300}>
    <div className="rounded-lg border border-sol-border bg-sol-card overflow-x-auto">
      <div className="grid min-w-full" style={{ gridTemplateColumns: template }}>
        {/* The header carries the key. The grid uses four marks for four
            genuinely different facts, and a reader who cannot tell them apart
            reads every one of them as "not here" — the exact conflation this
            page exists to end. A tooltip would hide the answer behind a hover on
            the primary scanning surface, so it is spelled out once, in place. */}
        <div className="px-2 py-2 sticky left-0 bg-sol-card z-10">
          <div className="text-[10px] uppercase tracking-wide text-sol-text-dim">capability</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-sol-text-dim">
            <span className="inline-flex items-center gap-0.5">
              <Minus className="w-2.5 h-2.5" /> not installed
            </span>
            <span className="inline-flex items-center gap-0.5">
              <CircleDashed className="w-2.5 h-2.5 text-sol-yellow" /> never reported
            </span>
            <span className="inline-flex items-center gap-0.5">
              <Slash className="w-2.5 h-2.5" /> switched off
            </span>
            <span className="inline-flex items-center gap-0.5">
              <AlertTriangle className="w-2.5 h-2.5 text-sol-red" /> nothing downloaded
            </span>
            <span>scope named only when it is not user</span>
          </div>
        </div>
        {devices.map((d) => (
          <DeviceHeader key={d.deviceId} d={d} reported={hasReadableReport(d, reports)} />
        ))}

        {/* The answer to the question the page asks, said out loud where the
            drift section would have been. Without it, a fleet that agrees looks
            identical to a fleet nobody has compared. */}
        {drifted.length === 0 && agreed.length > 0 && reporting.length > 1 && (
          <div className="col-span-full p-3 border-t border-sol-border">
            <AllInSync deviceCount={reporting.length} />
          </div>
        )}

        {/* "needs attention" rather than "drift": a broken install is not a
            disagreement, and on a one-machine fleet it is the only thing here
            worth acting on. The stat beside it still counts drift alone. */}
        <Section title="needs attention" count={drifted.length} tone="accent">
          {drifted.map((row) => (
            <MatrixRow
              key={row.key}
              row={row}
              devices={devices}
              selected={selectedKey === row.key}
              onSelect={onSelect}
            />
          ))}
        </Section>

        <Section
          // With one machine reporting there is no verdict, and every row says
          // so (`not_comparable`). Filing them under "in sync" would announce an
          // agreement between a machine and nobody.
          title={reporting.length > 1 ? "in sync" : "not compared — one machine reporting"}
          count={agreed.length}
          // Folded by default once there is anything to fix — the point of the
          // page is the disagreement, not the long tail that already agrees.
          defaultOpen={drifted.length === 0}
        >
          {agreed.map((row) => (
            <MatrixRow
              key={row.key}
              row={row}
              devices={devices}
              selected={selectedKey === row.key}
              onSelect={onSelect}
            />
          ))}
        </Section>
      </div>

      {visible.length === 0 && (
        <div className="p-3">
          {rows.length === 0 ? (
            // Every machine that answered listed nothing. That is an answer, not
            // a silence, and saying "nothing reported" here would blame the
            // daemon for a machine that is simply bare.
            <NothingInstalled deviceCount={reporting.length} />
          ) : filter === "drift" && !query?.trim() ? (
            // Filtered to the disagreements and there are none: that is the good
            // news, not an empty list.
            <AllInSync deviceCount={reporting.length} />
          ) : (
            <NoMatches query={query?.trim() || undefined} onClear={onClearFilters} />
          )}
        </div>
      )}
    </div>
    </TooltipProvider>
  );
}

/** Module scope so the fallback is the same object every render — a fresh
 *  literal would re-fire `Cell`'s memo on every pass. */
const UNKNOWN_CELL: FleetDiffCell = {
  deviceId: "",
  status: "unknown",
  present: false,
  enabled: false,
  scopes: [],
};

function MatrixRow({
  row,
  devices,
  selected,
  onSelect,
}: {
  row: FleetGridRow;
  devices: CapabilityDevice[];
  selected: boolean;
  onSelect?: (row: FleetGridRow) => void;
}) {
  return (
    // `display: contents` so the row's cells are direct grid items and every
    // column stays aligned across rows — a nested grid per row would let each
    // one size its own columns.
    <div
      className="contents"
      data-capability-row={row.key}
      data-selected={selected ? "true" : undefined}
    >
      <div
        className={`border-t border-sol-border sticky left-0 z-10 ${
          selected ? "bg-sol-bg-highlight" : "bg-sol-card"
        }`}
      >
        <RowHead row={row} selected={selected} onSelect={onSelect} />
      </div>
      {devices.map((d) => (
        <div
          key={d.deviceId}
          className={`border-t border-sol-border ${selected ? "bg-sol-bg-highlight" : ""}`}
        >
          <Cell
            // A device the diff was never told about is `unknown`, not absent —
            // the one state this grid must never get wrong.
            cell={row.byDevice[d.deviceId] ?? UNKNOWN_CELL}
            device={d}
            devices={devices}
            row={row}
          />
        </div>
      ))}
    </div>
  );
}
