"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleDashed, Minus, Slash } from "lucide-react";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { DeviceDot, relativeSeen } from "../DeviceBadge";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  KIND_META,
  kindMeta,
  type CapabilityDevice,
  type CapabilityKind,
  type CapabilityScope,
  type CatalogEntry,
  type InstallSite,
} from "./CapabilityCard";
import { TokenCostBadge, type TokenCost } from "./TokenCostBadge";
import { AllInSync, DeviceNotReported, NoDevices, NothingReportedYet } from "./EmptyStates";

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
  scope: CapabilityScope;
  /** False = switched off on purpose. A decision, not an absence. */
  enabled: boolean;
  /** Downloaded but declared nowhere. Plugins only. */
  installed?: boolean;
  version?: string;
  sha?: string;
  marketplace?: string;
  cost?: TokenCost;
}

export type CellState = "present" | "absent" | "different" | "disabled" | "unknown";

export interface FleetCell {
  state: CellState;
  scope?: CapabilityScope;
  /** The pin as reported: a commit sha wins over a version string. */
  pin?: string;
  version?: string;
  sha?: string;
  installedOnly?: boolean;
}

export interface FleetRow {
  key: string;
  name: string;
  kind: CapabilityKind | string;
  description?: string;
  marketplace?: string;
  cost?: TokenCost;
  cells: Record<string, FleetCell>;
  /** The machines disagree about this row. */
  drift: boolean;
  /** Why they disagree — drives the summary counts and the filter chips. */
  missingOn: string[];
  mismatchedOn: string[];
  disabledOn: string[];
  /** The pin the majority of machines carry, when there is one. */
  majorityPin?: string;
}

// --------------------------------------------------------------- the builder

function shortPin(pin: string | undefined): string | undefined {
  if (!pin) return undefined;
  // A 40-char sha is unreadable in a 96px column and its first 7 are enough to
  // tell two installs apart, which is all this column has to do.
  return /^[0-9a-f]{16,64}$/i.test(pin) ? pin.slice(0, 7) : pin;
}

/** The pin most machines agree on. Deterministic on ties (lowest string wins)
 *  so the same input always produces the same matrix. */
function majorityPin(pins: string[]): string | undefined {
  if (pins.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const p of pins) counts.set(p, (counts.get(p) ?? 0) + 1);
  let best: string | undefined;
  let bestN = -1;
  for (const [pin, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = pin;
      bestN = n;
    }
  }
  return best;
}

/**
 * Fold every machine's inventory into one row per capability, with the per-cell
 * detail a matrix has to draw: which scope switched it on there, and at which
 * pin.
 *
 * **The fleet-wide drift verdict is not decided here.** `store/capabilities.ts`
 * owns it (`selectCapabilityIndex` → `CapabilityDriftRow.drifting`), and passing
 * its keys in as `driftKeys` is how the number in this header stays equal to the
 * number in a sidebar badge. What this layer adds is the axis that index does
 * not model: two machines that both have a capability, pinned to different
 * commits. Without `driftKeys` it falls back to its own presence comparison, so
 * the function stays pure and testable on its own.
 *
 * Row keys follow the store slice's rule — the slug when a machine knew one,
 * else `<kind>:<name>` — so the two sides can be joined by key.
 *
 * Scopes stack rather than override — the daemon reports the same plugin once
 * per scope that switched it on — so several reports can land in one cell. The
 * enabled one wins, because "on here, off there" is the fact worth showing.
 */
export function buildFleetRows(
  devices: CapabilityDevice[],
  reports: Record<string, FleetInventoryItem[] | undefined>,
  driftKeys?: ReadonlySet<string>,
): FleetRow[] {
  const reporting = devices.filter((d) => d.reportedAt !== null);
  const rows = new Map<
    string,
    {
      row: Omit<FleetRow, "drift" | "missingOn" | "mismatchedOn" | "disabledOn" | "majorityPin">;
      byDevice: Map<string, FleetInventoryItem>;
    }
  >();

  for (const device of reporting) {
    for (const item of reports[device.deviceId] ?? []) {
      const key = item.slug && item.slug !== "" ? item.slug : `${item.kind}:${item.name}`;
      let bucket = rows.get(key);
      if (!bucket) {
        bucket = {
          row: {
            key,
            name: item.name,
            kind: item.kind,
            description: item.description,
            marketplace: item.marketplace,
            cost: item.cost,
            cells: {},
          },
          byDevice: new Map(),
        };
        rows.set(key, bucket);
      }
      // First non-empty description/cost wins — machines report the same
      // capability, so a later blank must not erase an earlier value.
      bucket.row.description ??= item.description;
      bucket.row.marketplace ??= item.marketplace;
      bucket.row.cost ??= item.cost;

      const prev = bucket.byDevice.get(device.deviceId);
      if (!prev || (!prev.enabled && item.enabled)) bucket.byDevice.set(device.deviceId, item);
    }
  }

  const out: FleetRow[] = [];
  for (const { row, byDevice } of rows.values()) {
    const pins: string[] = [];
    for (const item of byDevice.values()) {
      const pin = item.sha ?? item.version;
      if (pin) pins.push(pin);
    }
    const majority = majorityPin(pins);

    const cells: Record<string, FleetCell> = {};
    const missingOn: string[] = [];
    const mismatchedOn: string[] = [];
    const disabledOn: string[] = [];

    for (const device of devices) {
      if (device.reportedAt === null) {
        cells[device.deviceId] = { state: "unknown" };
        continue;
      }
      const item = byDevice.get(device.deviceId);
      if (!item) {
        cells[device.deviceId] = { state: "absent" };
        missingOn.push(device.deviceId);
        continue;
      }
      const pin = item.sha ?? item.version;
      // Downloaded but never declared reads as off, because that is what it is:
      // present on disk, doing nothing.
      const off = !item.enabled;
      const mismatched = Boolean(pin && majority && pin !== majority);
      if (off) disabledOn.push(device.deviceId);
      if (mismatched) mismatchedOn.push(device.deviceId);
      cells[device.deviceId] = {
        state: off ? "disabled" : mismatched ? "different" : "present",
        scope: item.scope,
        pin: shortPin(pin),
        version: item.version,
        sha: item.sha,
        installedOnly: item.installed === true && !item.enabled,
      };
    }

    // A pin mismatch is drift on this layer's own authority — the store's index
    // does not look at commits — and the presence verdict comes from `driftKeys`
    // when the caller has it.
    //
    // The fallback: drift needs at least two machines that actually spoke, since
    // one machine cannot disagree with itself. "Switched off on every machine
    // that has it" is agreement, not drift — a deliberate, consistent decision
    // should not be reported as a problem.
    const offEverywhere =
      disabledOn.length === reporting.length && missingOn.length === 0 && mismatchedOn.length === 0;
    const presenceDrift = driftKeys
      ? driftKeys.has(row.key)
      : reporting.length > 1 &&
        (missingOn.length > 0 || disabledOn.length > 0) &&
        !offEverywhere;
    const drift = presenceDrift || mismatchedOn.length > 0;

    out.push({ ...row, cells, drift, missingOn, mismatchedOn, disabledOn, majorityPin: majority });
  }

  const kindOrder = Object.keys(KIND_META);
  return out.sort(
    (a, b) =>
      // Drift first — it is the reason to open this page at all.
      Number(b.drift) - Number(a.drift) ||
      b.missingOn.length - a.missingOn.length ||
      kindOrder.indexOf(String(a.kind)) - kindOrder.indexOf(String(b.kind)) ||
      a.name.localeCompare(b.name),
  );
}

// ------------------------------------------------- fleet ↔ catalog bridging

/**
 * Every name a capability might be known by, lowercased.
 *
 * The two sides spell the same thing differently: a machine reports a plugin as
 * `code-simplifier@claude-plugins-official`, while a catalog row calls it
 * `code-simplifier` inside the marketplace `claude-plugins-official` with the
 * slug `mkt/claude-plugins-official/code-simplifier`. Matching on any one of
 * those spellings alone silently drops the cross-reference, which is the whole
 * value of the Library tab, so we index every form and match on overlap.
 */
function matchKeys(kind: string, name: string, slug?: string, marketplace?: string): string[] {
  const keys = new Set<string>();
  const add = (n: string | undefined) => {
    if (n) keys.add(`${kind}|${n.toLowerCase()}`);
  };
  add(name);
  const at = name.indexOf("@");
  if (at > 0) {
    add(name.slice(0, at));
    add(name.slice(at + 1));
  }
  if (marketplace) add(`${name}@${marketplace}`);
  if (slug) {
    const tail = slug.split("/").pop();
    add(tail);
    if (marketplace && tail) add(`${tail}@${marketplace}`);
  }
  return [...keys];
}

function installsFromRow(row: FleetRow): InstallSite[] {
  const out: InstallSite[] = [];
  for (const [deviceId, cell] of Object.entries(row.cells)) {
    if (cell.state === "absent" || cell.state === "unknown") continue;
    out.push({
      deviceId,
      scope: cell.scope ?? "user",
      enabled: cell.state !== "disabled",
      installedOnly: cell.installedOnly,
      version: cell.version,
      sha: cell.sha,
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
export function catalogFromFleet(rows: FleetRow[]): CatalogEntry[] {
  return rows.map((row) => ({
    // The row key IS the identity — the catalog slug when a machine knew one,
    // else `<kind>:<name>`. Reusing it means a card can be mapped straight back
    // to its matrix row instead of being re-derived and drifting apart.
    slug: row.key,
    name: row.name,
    kind: (kindMeta(String(row.kind)) ? row.kind : "skill") as CapabilityKind,
    description: row.description,
    marketplace: row.marketplace,
    cost: row.cost,
    installs: installsFromRow(row),
  }));
}

/** Attach each public catalog entry's real install sites, so a browsed row shows
 *  where it already lives. Entries with no match keep an empty `installs`, which
 *  renders as "installed nowhere" — correct, because every reporting machine
 *  told us and none of them had it. */
export function withFleetInstalls(entries: CatalogEntry[], rows: FleetRow[]): CatalogEntry[] {
  if (rows.length === 0) return entries;
  const index = new Map<string, FleetRow>();
  for (const row of rows) {
    for (const key of matchKeys(String(row.kind), row.name, undefined, row.marketplace)) {
      if (!index.has(key)) index.set(key, row);
    }
  }
  return entries.map((entry) => {
    if (entry.installs.length > 0) return entry;
    for (const key of matchKeys(entry.kind, entry.name, entry.slug, entry.marketplace)) {
      const row = index.get(key);
      if (row) return { ...entry, installs: installsFromRow(row) };
    }
    return entry;
  });
}

export interface FleetSummaryCounts {
  devices: number;
  reporting: number;
  silent: number;
  capabilities: number;
  drift: number;
  missing: number;
  mismatched: number;
  disabled: number;
}

export function summarizeFleet(rows: FleetRow[], devices: CapabilityDevice[]): FleetSummaryCounts {
  const reporting = devices.filter((d) => d.reportedAt !== null).length;
  return {
    devices: devices.length,
    reporting,
    silent: devices.length - reporting,
    capabilities: rows.length,
    drift: rows.filter((r) => r.drift).length,
    missing: rows.filter((r) => r.missingOn.length > 0 && r.drift).length,
    mismatched: rows.filter((r) => r.mismatchedOn.length > 0).length,
    disabled: rows.filter((r) => r.disabledOn.length > 0).length,
  };
}

// -------------------------------------------------------------- the summary

export type FleetFilter = "all" | "drift" | "missing" | "mismatched" | "disabled";

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
        value={counts.drift}
        tone={counts.drift > 0 ? "accent" : "muted"}
        active={filter === "drift"}
        onClick={toggle("drift")}
        hint="rows where your machines disagree"
      />
      <SummaryStat
        label="missing"
        value={counts.missing}
        tone={counts.missing > 0 ? "warn" : "muted"}
        active={filter === "missing"}
        onClick={toggle("missing")}
        hint="on some machines, absent from others"
      />
      <SummaryStat
        label="pin drift"
        value={counts.mismatched}
        tone={counts.mismatched > 0 ? "warn" : "muted"}
        active={filter === "mismatched"}
        onClick={toggle("mismatched")}
        hint="installed everywhere, but at different commits or versions"
      />
      <SummaryStat
        label="switched off"
        value={counts.disabled}
        active={filter === "disabled"}
        onClick={toggle("disabled")}
        hint="present on a machine but deliberately disabled there"
      />
    </div>
  );
}

// ----------------------------------------------------------------- the cell

const SCOPE_LETTER: Record<CapabilityScope, string> = { user: "u", project: "p", local: "l" };

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

function Cell({ cell, device, row }: { cell: FleetCell; device: CapabilityDevice; row: FleetRow }) {
  const label = useMemo(() => {
    const head = (
      <span className="text-sol-text">
        {device.name}
        <span className="text-sol-text-dim"> · {row.name}</span>
      </span>
    );
    switch (cell.state) {
      case "unknown":
        return (
          <span className="flex flex-col text-left">
            {head}
            <span className="text-sol-yellow">
              never reported an inventory — we do not know whether it is here
            </span>
          </span>
        );
      case "absent":
        return (
          <span className="flex flex-col text-left">
            {head}
            <span>not installed here</span>
          </span>
        );
      case "disabled":
        return (
          <span className="flex flex-col text-left">
            {head}
            <span>
              {cell.installedOnly
                ? "downloaded but never switched on"
                : `switched off at ${cell.scope ?? "user"} scope`}
            </span>
          </span>
        );
      case "different":
        return (
          <span className="flex flex-col text-left">
            {head}
            <span className="text-sol-orange">
              {cell.sha ? "commit" : "version"} {cell.pin} — the rest of the fleet is on{" "}
              {shortPin(row.majorityPin)}
            </span>
            <span className="text-sol-text-dim">{cell.scope} scope</span>
          </span>
        );
      default:
        return (
          <span className="flex flex-col text-left">
            {head}
            <span>
              enabled at {cell.scope} scope{cell.pin ? ` · ${cell.pin}` : ""}
            </span>
          </span>
        );
    }
  }, [cell, device.name, row.name, row.majorityPin]);

  const body =
    cell.state === "unknown" ? (
      <CircleDashed className="w-3.5 h-3.5 text-sol-yellow" />
    ) : cell.state === "absent" ? (
      <Minus className="w-3.5 h-3.5 text-sol-text-dim" />
    ) : cell.state === "disabled" ? (
      <span className="inline-flex items-center gap-0.5 text-sol-text-dim">
        <Slash className="w-3 h-3" />
        <span className="text-[9px] font-mono">{cell.scope ? SCOPE_LETTER[cell.scope] : ""}</span>
      </span>
    ) : (
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-mono ${
          cell.state === "different" ? "text-sol-orange" : "text-sol-text-muted"
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-[2px] ${
            cell.state === "different" ? "bg-sol-orange" : "bg-sol-green"
          }`}
        />
        {cell.pin ?? (cell.scope ? SCOPE_LETTER[cell.scope] : "")}
      </span>
    );

  return (
    <CellTip label={label}>
      <div
        className={`h-full flex items-center justify-center px-1.5 border-l ${
          cell.state === "unknown"
            ? "border-l-sol-yellow/20 bg-sol-yellow/[0.04]"
            : cell.state === "different"
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

function DeviceHeader({ d }: { d: CapabilityDevice }) {
  // A coarse clock, not the data subscription: the relative time has to keep
  // moving without the matrix re-rendering on every heartbeat.
  const now = useCoarseNow(30_000);
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
      {d.reportedAt === null ? (
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
  row: FleetRow;
  selected: boolean;
  onSelect?: (row: FleetRow) => void;
}) {
  const meta = kindMeta(String(row.kind));
  const Icon = meta?.icon;
  return (
    <div
      className={`flex items-center gap-2 px-2 py-1.5 min-w-0 ${
        onSelect ? "cursor-pointer" : ""
      } ${row.drift ? "border-l-2 border-l-sol-magenta" : "border-l-2 border-l-transparent"}`}
      onClick={onSelect ? () => onSelect(row) : undefined}
      role={onSelect ? "button" : undefined}
      tabIndex={-1}
    >
      {Icon && (
        <CellTip label={meta!.label}>
          <span className="flex-shrink-0 text-sol-text-dim cursor-default">
            <Icon className="w-3.5 h-3.5" />
          </span>
        </CellTip>
      )}
      <span
        className={`font-mono text-xs truncate ${selected ? "text-sol-magenta" : "text-sol-text"}`}
        title={row.description ? `${row.name} — ${row.description}` : row.name}
      >
        {row.name}
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
  const [open, setOpen] = useState(defaultOpen);
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
  rows,
  selectedKey,
  onSelect,
  filter = "all",
  query,
}: {
  devices: CapabilityDevice[];
  rows: FleetRow[];
  selectedKey?: string | null;
  onSelect?: (row: FleetRow) => void;
  filter?: FleetFilter;
  query?: string;
}) {
  const reporting = devices.filter((d) => d.reportedAt !== null);

  const visible = useMemo(() => {
    const q = query?.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "drift" && !r.drift) return false;
      if (filter === "missing" && !(r.drift && r.missingOn.length > 0)) return false;
      if (filter === "mismatched" && r.mismatchedOn.length === 0) return false;
      if (filter === "disabled" && r.disabledOn.length === 0) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        String(r.kind).toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q) ||
        (r.marketplace ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, filter, query]);

  const drifted = visible.filter((r) => r.drift);
  const agreed = visible.filter((r) => !r.drift);

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
        {/* header */}
        <div className="px-2 py-2 text-[10px] uppercase tracking-wide text-sol-text-dim sticky left-0 bg-sol-card z-10">
          capability
        </div>
        {devices.map((d) => (
          <DeviceHeader key={d.deviceId} d={d} />
        ))}

        <Section title="drift" count={drifted.length} tone="accent">
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
          title="in sync"
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
            <NothingReportedYet deviceCount={devices.length} />
          ) : filter === "all" && !query?.trim() ? (
            <AllInSync deviceCount={reporting.length} />
          ) : (
            <div className="text-center text-xs text-sol-text-dim py-6">
              No capability matches this view.
            </div>
          )}
        </div>
      )}
    </div>
    </TooltipProvider>
  );
}

function MatrixRow({
  row,
  devices,
  selected,
  onSelect,
}: {
  row: FleetRow;
  devices: CapabilityDevice[];
  selected: boolean;
  onSelect?: (row: FleetRow) => void;
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
          <Cell cell={row.cells[d.deviceId] ?? { state: "unknown" }} device={d} row={row} />
        </div>
      ))}
    </div>
  );
}
