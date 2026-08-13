// What does one machine have that the others do not?
//
// `inventory.ts` answers "what is installed here" for a single machine. This
// module takes N of those answers — one per device the user owns — and lays
// them side by side: a row per capability, a cell per machine, and a verdict
// per row. It is the whole of the fleet mirror's reading surface, and it is
// pure: no filesystem, no network, no clock, no randomness. The daemon, the
// browser and the server can all run it and must all get the same answer, for
// the same reason the snippet catalog is shared code — a diff that disagrees
// with itself per machine is worse than no diff.
//
// Three rules shape everything below.
//
// **Identity never contains a path.** `/Users/ashot/.claude/skills/x/SKILL.md`
// and `/home/build/.claude/skills/x/SKILL.md` are the same skill. So a row is
// keyed by the name the ecosystem itself uses: a plugin is `name@marketplace`,
// a skill is its frontmatter name, an MCP server is its config key, a
// marketplace is its registered name. Scope is not part of identity either —
// the same skill at user scope here and project scope there is one capability
// that happens to be switched on two ways.
//
// **Drift sorts before agreement.** Nobody opens this page to admire what
// matches. The rows that come first are the ones where most machines have
// something and one does not.
//
// **One machine is not a fleet.** With fewer than two reports there is nothing
// to compare, and saying "everything is unique to this machine" would be a
// fabricated alarm. The summary says so plainly instead (`comparable: false`),
// and every row carries the `not_comparable` verdict.

import type { CapabilityKind, CapabilityScope, Inventory, InventoryItem, MarketplaceRef } from "./inventory.js";

/**
 * Marketplaces sit in the same grid as capabilities on purpose: a plugin that
 * will not resolve on one machine is usually a marketplace that machine never
 * registered, so the explanation belongs next to the symptom.
 */
export type FleetRowKind = CapabilityKind | "marketplace";

/**
 * One machine's report.
 *
 * `inventory` absent (undefined or null) means this device has never sent one —
 * a genuinely different fact from a device that reported an EMPTY inventory,
 * which is a machine that really has nothing installed. The first produces
 * `unknown` cells and does not count towards agreement; the second counts fully
 * and makes every row "absent here".
 *
 * A device may legitimately appear more than once: the server stores one report
 * per (device, client, project scope), so a caller handing us raw rows will pass
 * several for one machine. They are folded into a single column rather than
 * deduplicated, so nothing a machine reported is lost.
 */
export interface DeviceReport {
  deviceId: string;
  deviceLabel?: string;
  inventory?: Inventory | null;
}

/** One column of the grid, in the order the caller supplied. */
export interface FleetDevice {
  deviceId: string;
  /** `deviceLabel` when there is one, otherwise the id — never blank. */
  label: string;
  /** Whether this machine has reported at all. */
  reported: boolean;
}

/**
 * How one machine stands on one capability.
 *
 * `same` and `pin_differs` are relative to the row's baseline pin; the other
 * three are plain facts about this machine.
 */
export type CellStatus =
  /** Present, switched on, at the pin most of the fleet is on. */
  | "same"
  /** Present and switched on, but at a different sha, version or URL. */
  | "pin_differs"
  /** On disk here, but switched off — installed and not in play. */
  | "disabled"
  /** This machine reported, and does not have it. */
  | "absent"
  /** This machine has never reported, so we know nothing either way. */
  | "unknown";

export interface FleetDiffCell {
  deviceId: string;
  status: CellStatus;
  /** Present on this machine in any scope. False for `absent` and `unknown`. */
  present: boolean;
  /** Present AND switched on. Scopes stack, so one scope switching it on is
   *  enough — that is how Claude Code itself resolves a plugin enabled at user
   *  scope and disabled at project scope. */
  enabled: boolean;
  /** The identifying version: a plugin's commit sha (else its version), a
   *  remote MCP server's URL, a marketplace's repo. Undefined where the kind
   *  has no honest one — see `pinOf`. */
  pin?: string;
  /** Plugins only: downloaded to disk, whether or not it is switched on.
   *  `enabled` with `installed === false` is a real broken state (declared
   *  here, never fetched) and the UI can badge it without a new cell status. */
  installed?: boolean;
  /** Every scope that declares it on this machine, narrowest first — the
   *  answer to "why is this here?". Scopes stack, so there can be several. */
  scopes: CapabilityScope[];
}

export type RowStatus =
  /** The machines disagree: somebody is missing it, has it switched off, or is
   *  on a different pin. */
  | "drift"
  /** Exactly one machine has it and the others reported without it. */
  | "unique"
  /** Every machine that reported agrees, pin included. */
  | "in_sync"
  /** Fewer than two machines have reported, so there is no verdict to give. */
  | "not_comparable";

export interface FleetDiffRow {
  /** `<kind>:<identity, lowercased>`. Unique within a diff, stable across runs
   *  and across machines — safe as a React key or a server side id. */
  key: string;
  kind: FleetRowKind;
  /** The identity as first reported, for display. */
  identity: string;
  /** The first non-empty description any machine had for it. */
  description?: string;
  status: RowStatus;
  /** One cell per device, positionally parallel to `FleetDiff.devices`. */
  cells: FleetDiffCell[];
  /** Reporting machines that have it, at any pin, switched on or off. */
  presentCount: number;
  /** Reporting machines where it is present and switched on. */
  activeCount: number;
  /** Reporting machines that do not have it. */
  absentCount: number;
  /** Reporting machines that have it switched off. */
  disabledCount: number;
  /** The pin most of the fleet is on — what `same` means for this row. */
  baselinePin?: string;
  /** Every distinct pin seen, sorted. More than one means pin drift. */
  pins: string[];
  /** Machines that have it are not all on the same pin. */
  pinDrift: boolean;
  /** Machines disagree about having it, or about it being switched on. */
  stateDrift: boolean;
  /** Every scope that declares it on any machine, narrowest first. */
  scopes: CapabilityScope[];
}

export interface FleetDiffSummary {
  /** Columns in the grid. */
  devices: number;
  /** Of those, how many have actually reported. */
  reporting: number;
  /** Two or more reports. False means every row reads `not_comparable`. */
  comparable: boolean;
  /** Rows in the diff. */
  total: number;
  inSync: number;
  /** Every row that is not in sync, `unique` rows included. So
   *  `inSync + drifted === total`, and `uniqueToOne <= drifted`. */
  drifted: number;
  /** Rows exactly one machine has. */
  uniqueToOne: number;
}

export interface FleetDiff {
  devices: FleetDevice[];
  /** Most interesting first — see `compareRows`. */
  rows: FleetDiffRow[];
  summary: FleetDiffSummary;
}

// --------------------------------------------------------------- orderings

/** Narrowest scope first, as `toInvocableList` orders them (inventory.ts:398). */
const SCOPE_ORDER: CapabilityScope[] = ["local", "project", "user"];

/**
 * The order that breaks a tie between rows of equal interest. Kinds that run
 * code, or that explain another row's failure, come first; the kinds that are
 * only prose come last. `marketplace` sits next to `plugin` because a missing
 * marketplace is usually why a plugin is missing.
 */
const KIND_ORDER: FleetRowKind[] = ["plugin", "marketplace", "mcp", "skill", "command", "subagent"];

const KNOWN_KINDS = new Set<FleetRowKind>(KIND_ORDER);

// ----------------------------------------------------------------- helpers

/** A trimmed non-empty string, or undefined. Reports reach us as parsed JSON,
 *  so "a string with something in it" cannot be assumed from the types. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeOf(value: unknown): CapabilityScope {
  return value === "local" || value === "project" ? value : "user";
}

/**
 * The name that means the same thing on every machine.
 *
 * A plugin's is `name@marketplace`; `inventory.ts` already stores that as the
 * item name, but a report built by hand may carry the bare name with the
 * marketplace in `meta`, so it is composed when missing. Everything else is
 * already a bare name that the ecosystem treats as the identity.
 */
export function capabilityIdentity(
  kind: FleetRowKind,
  name: string,
  meta?: Record<string, string>,
): string | undefined {
  const base = text(name);
  if (!base) return undefined;
  if (kind !== "plugin" || base.includes("@")) return base;
  const marketplace = text(meta?.marketplace);
  return marketplace ? `${base}@${marketplace}` : base;
}

/**
 * The value that must match for two machines to be on the same thing.
 *
 * Only where a difference is genuinely a difference. A stdio MCP server's
 * command line embeds absolute paths (`node /Users/ashot/...`), which differ on
 * every machine for the same server — comparing those would report drift on a
 * perfectly synchronised fleet, which is the one failure this page cannot
 * afford. A remote server's URL has no such problem and a changed URL is real
 * drift, so that one counts.
 */
function pinOf(kind: FleetRowKind, meta?: Record<string, string>): string | undefined {
  switch (kind) {
    case "plugin":
      // Claude Code records `gitCommitSha` per install, so pinning is read, not
      // invented (inventory.ts:248-251). Version is the fallback for a
      // marketplace entry that carries no sha.
      return text(meta?.sha) ?? text(meta?.version);
    case "mcp": {
      const url = text(meta?.url);
      return url ? url.replace(/\/+$/, "") : undefined;
    }
    case "marketplace":
      return text(meta?.repo);
    default:
      return undefined;
  }
}

// ------------------------------------------------------- normalising input

/** One reported thing, reduced to the fields the diff reasons about. */
interface NormalizedItem {
  kind: FleetRowKind;
  identity: string;
  description?: string;
  scope: CapabilityScope;
  enabled: boolean;
  installed?: boolean;
  pin?: string;
}

function normalizeItem(raw: unknown): NormalizedItem | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = raw.kind as FleetRowKind;
  if (!KNOWN_KINDS.has(kind)) return undefined;
  const meta = isRecord(raw.meta)
    ? (Object.fromEntries(
        Object.entries(raw.meta).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ) as Record<string, string>)
    : undefined;
  const identity = capabilityIdentity(kind, raw.name as string, meta);
  if (!identity) return undefined;
  return {
    kind,
    identity,
    description: text(raw.description),
    scope: scopeOf(raw.scope),
    // A report that omits `enabled` describes something present; only an
    // explicit `false` means switched off.
    enabled: raw.enabled !== false,
    installed: typeof raw.installed === "boolean" ? raw.installed : undefined,
    pin: pinOf(kind, meta),
  };
}

/** A marketplace becomes an ordinary row: same identity rules, same cells, one
 *  algorithm. `MarketplaceRef` has no enabled flag — a machine either knows it
 *  or it does not. */
function normalizeMarketplace(raw: unknown): NormalizedItem | undefined {
  if (!isRecord(raw)) return undefined;
  const identity = text(raw.name as string);
  if (!identity) return undefined;
  return {
    kind: "marketplace",
    identity,
    scope: scopeOf(raw.scope),
    enabled: true,
    pin: text(raw.repo as string),
  };
}

function normalizeReport(inventory: Inventory | null | undefined): NormalizedItem[] {
  if (!isRecord(inventory)) return [];
  const out: NormalizedItem[] = [];
  // `entries_json` is stored as a string and parsed by the caller, so a
  // malformed report must yield an empty column rather than throw and take the
  // whole page down with it.
  if (Array.isArray(inventory.items)) {
    for (const raw of inventory.items as InventoryItem[]) {
      const item = normalizeItem(raw);
      if (item) out.push(item);
    }
  }
  if (Array.isArray(inventory.marketplaces)) {
    for (const raw of inventory.marketplaces as MarketplaceRef[]) {
      const item = normalizeMarketplace(raw);
      if (item) out.push(item);
    }
  }
  return out;
}

// ------------------------------------------------------------- the folding

/** Everything one machine reported about one capability, across all scopes. */
interface Fold {
  enabled: boolean;
  pin?: string;
  installed?: boolean;
  scopes: Set<CapabilityScope>;
}

interface RowAccumulator {
  key: string;
  kind: FleetRowKind;
  identity: string;
  description?: string;
  byDevice: Map<string, Fold>;
}

/** The most common value, ties broken lexicographically so the answer never
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

function sortedScopes(scopes: Set<CapabilityScope>): CapabilityScope[] {
  return SCOPE_ORDER.filter((scope) => scopes.has(scope));
}

// ------------------------------------------------------------- the ranking

/**
 * How much a row wants to be looked at. Lower is more urgent.
 *
 * The order encodes what a person came here to find. A capability most machines
 * have and one machine lacks is the moment the product exists for, so it leads.
 * A pin difference is next: everyone has it, one machine is behind. Something
 * only one machine has is often deliberate (a work laptop, a scratch skill), so
 * it sits below the two kinds of genuine loss. Agreement is last, and a single
 * machine's inventory — where there is no verdict at all — is last of all.
 */
function rankOf(row: FleetDiffRow): number {
  switch (row.status) {
    case "drift":
      return row.stateDrift ? 0 : 1;
    case "unique":
      return 2;
    case "in_sync":
      return 3;
    default:
      return 4;
  }
}

function kindRank(kind: FleetRowKind): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

/** A total order: every comparison ends at `key`, which is unique per row, so
 *  two runs over the same input produce the same list. */
function compareRows(a: FleetDiffRow, b: FleetDiffRow): number {
  const rank = rankOf(a) - rankOf(b);
  if (rank !== 0) return rank;
  // Within a rank, breadth is urgency: missing from one of five machines beats
  // missing from four of five.
  if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
  if (a.presentCount !== b.presentCount) return b.presentCount - a.presentCount;
  const kind = kindRank(a.kind) - kindRank(b.kind);
  if (kind !== 0) return kind;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// ------------------------------------------------------------------ public

/**
 * Lay every machine's inventory side by side.
 *
 * Total: malformed reports, blank names, unknown kinds and duplicate device ids
 * are absorbed rather than thrown on. This runs to render a page, and a page
 * that shows nine machines correctly is worth more than one that shows an error
 * because the tenth sent something odd.
 */
export function buildFleetDiff(reports: DeviceReport[]): FleetDiff {
  const devices: FleetDevice[] = [];
  const deviceIndex = new Map<string, number>();
  const rows = new Map<string, RowAccumulator>();

  for (const report of Array.isArray(reports) ? reports : []) {
    const deviceId = text(report?.deviceId);
    if (!deviceId) continue; // a column with no identity cannot be addressed

    let index = deviceIndex.get(deviceId);
    if (index === undefined) {
      index = devices.length;
      deviceIndex.set(deviceId, index);
      devices.push({ deviceId, label: text(report.deviceLabel) ?? deviceId, reported: false });
    } else if (devices[index].label === deviceId) {
      // A later row for the same machine may be the one carrying its label.
      devices[index].label = text(report.deviceLabel) ?? deviceId;
    }

    const reported = report.inventory !== undefined && report.inventory !== null;
    if (reported) devices[index].reported = true;

    for (const item of normalizeReport(report.inventory)) {
      // Case folding the key, not the display name: two machines that spell one
      // skill `Domain-Search` and `domain-search` mean the same skill, and
      // showing it twice would invent drift out of a filename.
      const key = `${item.kind}:${item.identity.toLowerCase()}`;
      let row = rows.get(key);
      if (!row) {
        row = { key, kind: item.kind, identity: item.identity, description: item.description, byDevice: new Map() };
        rows.set(key, row);
      }
      if (!row.description && item.description) row.description = item.description;

      const fold = row.byDevice.get(deviceId);
      if (!fold) {
        row.byDevice.set(deviceId, {
          enabled: item.enabled,
          pin: item.pin,
          installed: item.installed,
          scopes: new Set([item.scope]),
        });
        continue;
      }
      // Scopes stack rather than override (inventory.ts:19-22), so one scope
      // switching a plugin on is enough for it to be on here — the same union
      // `claude plugin list --json` reports.
      fold.enabled = fold.enabled || item.enabled;
      fold.pin = fold.pin ?? item.pin;
      fold.installed = fold.installed ?? item.installed;
      fold.scopes.add(item.scope);
    }
  }

  const reporting = devices.filter((d) => d.reported);
  const comparable = reporting.length >= 2;

  const built: FleetDiffRow[] = [];
  for (const accumulator of rows.values()) {
    built.push(buildRow(accumulator, devices, comparable));
  }
  built.sort(compareRows);

  const inSync = built.filter((r) => r.status === "in_sync").length;
  const uniqueToOne = built.filter((r) => r.status === "unique").length;

  return {
    devices,
    rows: built,
    summary: {
      devices: devices.length,
      reporting: reporting.length,
      comparable,
      total: built.length,
      // With one report there is nothing to be in sync with and nothing to
      // drift from. Reporting zeroes here is what keeps the header honest
      // instead of announcing that every capability is unique to the only
      // machine we have heard from.
      inSync: comparable ? inSync : 0,
      drifted: comparable ? built.length - inSync : 0,
      uniqueToOne: comparable ? uniqueToOne : 0,
    },
  };
}

function buildRow(accumulator: RowAccumulator, devices: FleetDevice[], comparable: boolean): FleetDiffRow {
  // Pins are compared only among machines that reported one. A machine that has
  // the plugin but no sha (declared in settings, never fetched) is an unknown
  // pin, not a different one, and calling that drift would cry wolf.
  const presentPins: string[] = [];
  const scopes = new Set<CapabilityScope>();
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
  // Whether a machine has it, and whether it is switched on, is one axis; the
  // pin is the other. Machines disagree on the first axis when they are not all
  // in the same one of its three states — on, off, or missing.
  const stateDrift = [activeCount, disabledCount, absentCount].filter((n) => n > 0).length > 1;

  const cells: FleetDiffCell[] = devices.map((device) => {
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
      scopes: sortedScopes(fold.scopes),
    };
  });

  const status: RowStatus = !comparable
    ? "not_comparable"
    : presentCount === 1
      ? "unique"
      : stateDrift || pinDrift
        ? "drift"
        : "in_sync";

  return {
    key: accumulator.key,
    kind: accumulator.kind,
    identity: accumulator.identity,
    description: accumulator.description,
    status,
    cells,
    presentCount,
    activeCount,
    absentCount,
    disabledCount,
    baselinePin,
    pins,
    pinDrift,
    stateDrift,
    scopes: sortedScopes(scopes),
  };
}
