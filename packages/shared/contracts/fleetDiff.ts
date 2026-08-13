// What does one machine have that the others do not?
//
// `packages/cli/src/capabilities/inventory.ts` answers "what is installed here"
// for a single machine. This module takes N of those answers — one per device
// the user owns, arriving as JSON over the wire — and lays them side by side: a
// row per capability, a cell per machine, and a verdict per row. It is the whole
// of the fleet mirror's reading surface, and it is pure: no filesystem, no
// network, no clock, no randomness.
//
// It lives in the shared contracts because THREE runtimes render this grid — the
// daemon for `cast cap status`, the browser for `/capabilities`, and Convex for
// the stored summary — and a diff that disagrees with itself per machine is
// worse than no diff. While it lived in the CLI package the other two could only
// reimplement it, and they did, with different vocabularies and different
// answers. Same rule as the snippet catalog: one copy, or the copies drift.
//
// Four rules shape everything below.
//
// **Identity never contains a path.** `/Users/ashot/.claude/skills/x/SKILL.md`
// and `/home/build/.claude/skills/x/SKILL.md` are the same skill. So a row is
// keyed by the name the ecosystem itself uses: a plugin is `name@marketplace`,
// a skill is its frontmatter name, an MCP server is its config key, a
// marketplace is its registered name. Scope is not part of identity either —
// the same skill at user scope here and project scope there is one capability
// that happens to be switched on two ways.
//
// **A pin is only comparable to a pin of the same kind.** Two reporters answer
// "which build of this plugin?" and they answer it differently: the settings
// reader gets a commit sha out of `installed_plugins.json`, while
// `claude plugin list --json` only ever knows a version. Both are true, neither
// can be read as the other, and comparing them as bare strings marks an
// identical fleet as drifted the moment one machine reports through a different
// client. So a pin carries its kind, a row is compared on one kind, and a
// machine holding a weaker kind is an unknown pin rather than a different one.
//
// **Drift sorts before agreement.** Nobody opens this page to admire what
// matches. The rows that come first are the ones where a machine is missing
// something another machine has.
//
// **One machine is not a fleet.** With fewer than two reports there is nothing
// to compare, and saying "everything is unique to this machine" would be a
// fabricated alarm. The summary says so plainly instead (`comparable: false`),
// and every row carries the `not_comparable` verdict. A machine whose report we
// could not read has told us nothing either, so it is not a second machine.

// The scope vocabulary is the contract's own (`capabilities.ts`), not a second
// spelling of it: `ObservedScope` is already "the scope Claude Code itself
// reports for something on disk", which is exactly what a cell means by scope.
// `CapabilityKind` is the wider library vocabulary; the kinds a machine
// inventory can actually report are the narrower list `KIND_ORDER` ranks below.
import type { CapabilityKind, ObservedScope } from "./capabilities";

/**
 * Marketplaces sit in the same grid as capabilities on purpose: a plugin that
 * will not resolve on one machine is usually a marketplace that machine never
 * registered, so the explanation belongs next to the symptom.
 *
 * The capability half is the library's whole vocabulary, not the subset one
 * client reports today: a machine that sends a kind this module has never ranked
 * has it dropped, and a dropped row reads as a missing capability.
 */
export type FleetRowKind = CapabilityKind | "marketplace";

/**
 * What a machine says it has.
 *
 * Typed as `unknown` on purpose. This arrives as JSON parsed from a report sent
 * by another machine, possibly written by an older binary, so `Inventory` here
 * would be a promise the wire cannot keep. Every field is validated below, and
 * a real `Inventory` satisfies this shape unchanged.
 */
export interface ReportedInventory {
  items?: unknown;
  marketplaces?: unknown;
}

/**
 * One machine's report.
 *
 * `inventory` absent (undefined, null, or a payload we cannot read) means this
 * device has told us nothing — a genuinely different fact from a device that
 * reported an EMPTY inventory, which is a machine that really has nothing
 * installed. The first produces `unknown` cells and does not count towards
 * agreement; the second counts fully and makes every row "absent here".
 *
 * A device may legitimately appear more than once: the server stores one report
 * per (device, client, project scope), so a caller handing us raw rows will pass
 * several for one machine. They are folded into a single column rather than
 * deduplicated, so nothing a machine reported is lost.
 */
export interface DeviceReport {
  deviceId: string;
  deviceLabel?: string;
  inventory?: ReportedInventory | null;
  /** Column metadata — see `FleetDevice`. Carried through, never reasoned about. */
  reportedAt?: number;
  lastError?: string;
  entryCount?: number;
}

/** One column of the grid, in the order the caller supplied. */
export interface FleetDevice {
  deviceId: string;
  /** `deviceLabel` when there is one, otherwise the id — never blank. */
  label: string;
  /** Whether this machine has sent a report we could read. */
  reported: boolean;
  /**
   * Display facts about the column that the diff itself never branches on: when
   * this machine last reported, why its last scan failed, and how many entries
   * it sent. Folded here rather than at each call site because the server, the
   * browser and `cast cap status` all render the same column and would
   * otherwise each invent their own rule for a machine that reported twice.
   * Newest report wins for the time and the error; entry counts add up.
   */
  reportedAt?: number;
  lastError?: string;
  entryCount?: number;
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

/**
 * Which identifier a pin is.
 *
 * Only pins of one kind are ever compared. `sha` and `version` both answer
 * "which build of this plugin", `url` identifies a remote MCP server, `repo`
 * identifies a marketplace.
 */
export type PinKind = "sha" | "version" | "url" | "repo";

export interface Pin {
  kind: PinKind;
  value: string;
}

export interface FleetDiffCell {
  deviceId: string;
  status: CellStatus;
  /** Present on this machine in any scope. False for `absent` and `unknown`. */
  present: boolean;
  /** Present AND switched on. Scopes stack, so one scope switching it on is
   *  enough — that is how Claude Code itself resolves a plugin enabled at user
   *  scope and disabled at project scope. */
  enabled: boolean;
  /** What this machine is on, as this machine reported it. May be of a weaker
   *  kind than `FleetDiffRow.pinKind`, in which case it did not take part in the
   *  comparison — render it, do not compare it. */
  pin?: string;
  pinKind?: PinKind;
  /** Plugins only: downloaded to disk, whether or not it is switched on.
   *  `enabled` with `installed === false` is a real broken state (declared
   *  here, never fetched) and the UI can badge it without a new cell status. */
  installed?: boolean;
  /** Every scope that declares it on this machine, narrowest first — the
   *  answer to "why is this here?". Scopes stack, so there can be several. */
  scopes: ObservedScope[];
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
  /** The kind of pin this row was compared on: the most precise kind reported by
   *  the machines running it, or — when nobody is running it — the most precise
   *  kind anybody holds. Undefined where no machine reported a pin at all. */
  pinKind?: PinKind;
  /** The pin most of the fleet runs — what `same` means for this row. Decided
   *  among machines that have it switched ON, since a pin nobody is running is
   *  not a baseline anybody is off. */
  baselinePin?: string;
  /** Every distinct pin of `pinKind` seen on a machine that has it, switched on
   *  or off, sorted. More than one entry with `pinDrift === false` means the
   *  difference is dormant — switched off on the machines that differ. */
  pins: string[];
  /** Machines that are RUNNING it are not all on the same pin. */
  pinDrift: boolean;
  /** Machines disagree about having it, or about it being switched on. */
  stateDrift: boolean;
  /** Every scope that declares it on any machine, narrowest first. */
  scopes: ObservedScope[];
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

/** Narrowest scope first, as `toInvocableList` orders them (packages/cli/src/capabilities/inventory.ts:398).
 *  This is a ranking, so it is spelled out rather than borrowed from a
 *  declaration list that happens to read the same way today. */
const SCOPE_ORDER = ["local", "project", "user"] as const satisfies readonly ObservedScope[];

/**
 * The order that breaks a tie between rows of equal interest. Kinds that run
 * code, or that explain another row's failure, come first; the kinds that are
 * only prose come last. `marketplace` sits next to `plugin` because a missing
 * marketplace is usually why a plugin is missing.
 *
 * Every kind the library knows is ranked, not only the five a Claude Code
 * inventory reports today. `normalizeItem` DROPS a kind that is not in this
 * list, and a dropped row is invisible in exactly the way an absent capability
 * is — so a vocabulary that grows here without a rank would look like machines
 * losing things. `_EveryKindIsRanked` below is what makes that a build failure.
 */
const KIND_ORDER = [
  "plugin",
  "marketplace",
  "mcp",
  "hook",
  "skill",
  "command",
  "subagent",
  "snippet",
] as const satisfies readonly FleetRowKind[];

/** Most precise first. A machine on a weaker kind than the row is compared on
 *  did not answer the question the row is asking. */
const PIN_STRENGTH = ["sha", "version", "url", "repo"] as const satisfies readonly PinKind[];

/**
 * Compile-time completeness. `normalizeItem` drops any kind not in `KIND_ORDER`
 * and `sortedScopes` drops any scope not in `SCOPE_ORDER`, so a vocabulary that
 * grows without a ranking here would lose rows in silence. These fail the build
 * instead.
 */
type Ranked<T extends never> = T;
type _EveryKindIsRanked = Ranked<Exclude<FleetRowKind, (typeof KIND_ORDER)[number]>>;
type _EveryScopeIsRanked = Ranked<Exclude<ObservedScope, (typeof SCOPE_ORDER)[number]>>;
type _EveryPinKindIsRanked = Ranked<Exclude<PinKind, (typeof PIN_STRENGTH)[number]>>;

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

function scopeOf(value: unknown): ObservedScope {
  return value === "local" || value === "project" ? value : "user";
}

function scopeRank(scope: ObservedScope): number {
  return SCOPE_ORDER.indexOf(scope);
}

function pinStrength(kind: PinKind): number {
  return PIN_STRENGTH.indexOf(kind);
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
 * The value that must match for two machines to be on the same thing, and which
 * question that value answers.
 *
 * Only where a difference is genuinely a difference. A stdio MCP server's
 * command line embeds absolute paths (`node /Users/ashot/...`), which differ on
 * every machine for the same server — comparing those would report drift on a
 * perfectly synchronised fleet, which is the one failure this page cannot
 * afford. A remote server's URL has no such problem and a changed URL is real
 * drift, so that one counts.
 */
function pinOf(kind: FleetRowKind, meta?: Record<string, string>): Pin | undefined {
  switch (kind) {
    case "plugin": {
      // Claude Code records `gitCommitSha` per install, so pinning is read, not
      // invented (packages/cli/src/capabilities/inventory.ts:248-251). A reporter that only knows the version
      // — `claude plugin list --json` never sees a sha — says so with its kind
      // rather than passing a version off as a sha.
      const sha = text(meta?.sha);
      if (sha) return { kind: "sha", value: sha };
      const version = text(meta?.version);
      return version ? { kind: "version", value: version } : undefined;
    }
    case "mcp": {
      const url = text(meta?.url);
      return url ? { kind: "url", value: url.replace(/\/+$/, "") } : undefined;
    }
    case "marketplace": {
      const repo = text(meta?.repo);
      return repo ? { kind: "repo", value: repo } : undefined;
    }
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
  scope: ObservedScope;
  enabled: boolean;
  installed?: boolean;
  pin?: Pin;
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
  const identity = text(raw.name);
  if (!identity) return undefined;
  const repo = text(raw.repo);
  return {
    kind: "marketplace",
    identity,
    scope: scopeOf(raw.scope),
    enabled: true,
    pin: repo ? { kind: "repo", value: repo } : undefined,
  };
}

/**
 * What one report says, or undefined when the payload is not something we could
 * read at all.
 *
 * Unreadable is not the same as empty, and this is the only place that decides
 * which one a payload is — `reported` on the column is this answer, so the two
 * can never drift apart. A machine whose report we cannot parse has told us
 * nothing; counting it as a machine with nothing installed would mark every row
 * in the fleet as drifted on the strength of one bad JSON blob.
 */
function readReport(inventory: unknown): NormalizedItem[] | undefined {
  if (!isRecord(inventory)) return undefined;
  const rawItems = Array.isArray(inventory.items) ? inventory.items : undefined;
  const rawMarketplaces = Array.isArray(inventory.marketplaces) ? inventory.marketplaces : undefined;
  if (!rawItems && !rawMarketplaces) return undefined;

  const out: NormalizedItem[] = [];
  for (const raw of rawItems ?? []) {
    const item = normalizeItem(raw);
    if (item) out.push(item);
  }
  for (const raw of rawMarketplaces ?? []) {
    const item = normalizeMarketplace(raw);
    if (item) out.push(item);
  }
  return out;
}

// ------------------------------------------------------------- the folding

/** Everything one machine reported about one capability, across all scopes. */
interface Fold {
  enabled: boolean;
  pin?: Pin;
  /** Scope rank of the declaration that supplied `pin`. */
  pinRank: number;
  installed?: boolean;
  scopes: Set<ObservedScope>;
}

/**
 * Does this declaration decide the machine's pin?
 *
 * A pin is not a union, it is a resolution: the narrowest scope wins, the same
 * rule `toInvocableList` uses for a name collision (packages/cli/src/capabilities/inventory.ts:397-408). Two
 * declarations at one scope come from two clients describing one machine, so
 * the more precise answer wins — and if even that ties, the smaller string
 * does, which is arbitrary but keeps the answer independent of the order the
 * reports arrived in.
 */
function supersedes(next: Pin, nextRank: number, current: Pin | undefined, currentRank: number): boolean {
  if (!current) return true;
  if (nextRank !== currentRank) return nextRank < currentRank;
  const strength = pinStrength(next.kind) - pinStrength(current.kind);
  if (strength !== 0) return strength < 0;
  return next.value < current.value;
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

/** The most precise pin kind present, which is the one the row is compared on. */
function strongestKind(pins: Pin[]): PinKind | undefined {
  let best: PinKind | undefined;
  for (const pin of pins) {
    if (best === undefined || pinStrength(pin.kind) < pinStrength(best)) best = pin.kind;
  }
  return best;
}

function sortedScopes(scopes: Set<ObservedScope>): ObservedScope[] {
  return SCOPE_ORDER.filter((scope) => scopes.has(scope));
}

// ------------------------------------------------------------- the ranking

/**
 * How much a row wants to be looked at. Lower is more urgent.
 *
 * The order encodes what a person came here to find. A capability one machine
 * lacks and the others have is the moment the product exists for, so it leads —
 * including when the fleet is a laptop and a desktop, where "present on one,
 * absent on the other" is `unique` by definition and would otherwise sort below
 * a version bump. A pin difference is next: everyone runs it, one machine is
 * behind. Something one machine out of several has is more often deliberate (a
 * work laptop, a scratch skill), so it sits below the two kinds of genuine
 * loss. Agreement is last, and a single machine's inventory — where there is no
 * verdict at all — is last of all.
 */
function rankOf(row: FleetDiffRow): number {
  switch (row.status) {
    case "drift":
      return row.stateDrift ? 0 : 1;
    case "unique":
      return row.absentCount === 1 ? 0 : 2;
    case "in_sync":
      return 3;
    default:
      return 4;
  }
}

function kindRank(kind: FleetRowKind): number {
  const index = (KIND_ORDER as readonly FleetRowKind[]).indexOf(kind);
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
    foldColumnMeta(devices[index], report);

    const items = readReport(report.inventory);
    if (!items) continue; // told us nothing: the column stays `unknown`
    devices[index].reported = true;

    for (const item of items) {
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

      const rank = scopeRank(item.scope);
      let fold = row.byDevice.get(deviceId);
      if (!fold) {
        fold = { enabled: false, pinRank: SCOPE_ORDER.length, scopes: new Set() };
        row.byDevice.set(deviceId, fold);
      }
      // Scopes stack rather than override (packages/cli/src/capabilities/inventory.ts:19-22), so one scope
      // switching a plugin on is enough for it to be on here — the same union
      // `claude plugin list --json` reports. The same goes for the bytes on
      // disk: one declaration finding them is enough.
      fold.enabled = fold.enabled || item.enabled;
      if (item.installed !== undefined) fold.installed = (fold.installed ?? false) || item.installed;
      if (item.pin && supersedes(item.pin, rank, fold.pin, fold.pinRank)) {
        fold.pin = item.pin;
        fold.pinRank = rank;
      }
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

/** The fold described on `FleetDevice`. Reports with no timestamp cannot be put
 *  in order, so the first error one of them carries is the one that stands. */
function foldColumnMeta(column: FleetDevice, report: DeviceReport): void {
  const at = typeof report.reportedAt === "number" && Number.isFinite(report.reportedAt) ? report.reportedAt : undefined;
  if (at !== undefined && (column.reportedAt === undefined || at > column.reportedAt)) {
    column.reportedAt = at;
    column.lastError = text(report.lastError);
  } else if (column.reportedAt === undefined && column.lastError === undefined) {
    column.lastError = text(report.lastError);
  }
  if (typeof report.entryCount === "number" && Number.isFinite(report.entryCount)) {
    column.entryCount = (column.entryCount ?? 0) + report.entryCount;
  }
}

function buildRow(accumulator: RowAccumulator, devices: FleetDevice[], comparable: boolean): FleetDiffRow {
  // Two pin lists, and the difference is the whole of `pinDrift`'s meaning.
  // `livePins` is what the fleet is RUNNING; `heldPins` includes machines that
  // have it switched off. A plugin switched off everywhere at two different
  // shas is not a difference anyone is living with — and calling it drift would
  // badge a row whose every cell reads `disabled`, leaving nothing on screen to
  // point at. The dormant pins still reach the UI through `pins` and the cells.
  const livePins: Pin[] = [];
  const heldPins: Pin[] = [];
  const scopes = new Set<ObservedScope>();
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
    if (fold.pin) {
      heldPins.push(fold.pin);
      if (fold.enabled) livePins.push(fold.pin);
    }
    for (const scope of fold.scopes) scopes.add(scope);
  }

  // Compared on the most precise kind anybody is running. A machine that only
  // knows the version of a plugin others report by sha did not answer this
  // question, so it is an unknown pin — exactly how a machine with no pin at
  // all is treated, and for the same reason: calling it drift would cry wolf.
  const pinKind = strongestKind(livePins) ?? strongestKind(heldPins);
  const comparablePins = livePins.filter((p) => p.kind === pinKind).map((p) => p.value);
  const baselinePin = modal(comparablePins);
  const pins = [...new Set(heldPins.filter((p) => p.kind === pinKind).map((p) => p.value))].sort();
  const pinDrift = new Set(comparablePins).size > 1;
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
    const behind =
      fold.pin !== undefined &&
      fold.pin.kind === pinKind &&
      baselinePin !== undefined &&
      fold.pin.value !== baselinePin;
    return {
      deviceId: device.deviceId,
      status: !fold.enabled ? "disabled" : behind ? "pin_differs" : "same",
      present: true,
      enabled: fold.enabled,
      pin: fold.pin?.value,
      pinKind: fold.pin?.kind,
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
    pinKind,
    baselinePin,
    pins,
    pinDrift,
    stateDrift,
    scopes: sortedScopes(scopes),
  };
}
