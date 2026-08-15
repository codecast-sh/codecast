"use client";

import { useMemo, type ReactNode } from "react";
import {
  Bot,
  FileText,
  Plug,
  Puzzle,
  ShieldAlert,
  ShieldQuestion,
  Sparkles,
  Terminal,
  Webhook,
} from "lucide-react";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  deviceDisplayName,
  deviceKindLabel,
  DeviceDot,
  type Device,
} from "../DeviceBadge";
import {
  isExecutionSurface,
  requiresExplicitConsent,
  type ExecutionSurface,
} from "@codecast/shared/contracts";
import { TokenCostBadge, type TokenCost } from "./TokenCostBadge";

/**
 * The view models for /capabilities, and the catalog card that renders one entry.
 *
 * This file is the type home for the surface: the matrix, the library and the
 * page all speak these shapes, so there is exactly one definition of "a
 * capability", "a machine that reports capabilities" and "where it is
 * installed". Everything here is a projection of what a daemon already reads off
 * disk (`packages/cli/src/capabilities/inventory.ts` — `InventoryItem`,
 * `MarketplaceRef`), deliberately kept structural rather than imported: that
 * module is Node-only (`fs`, `path`) and cannot be pulled into a browser bundle.
 */

// ------------------------------------------------------------------- kinds

export const CAPABILITY_KINDS = [
  "skill",
  "command",
  "subagent",
  "plugin",
  "mcp",
  "hook",
  "snippet",
] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/** Where a capability was switched on. Narrowest first — matches the CLI's
 *  `CapabilityScope`, and scopes stack rather than override. */
export type CapabilityScope = "local" | "project" | "user";

export interface KindMeta {
  label: string;
  plural: string;
  icon: any;
  /** Chip classes: border + tint + text, as ONE literal string. */
  chip: string;
  /** The card's edge rail, as one literal string. */
  rail: string;
  blurb: string;
}

export const KIND_META: Record<CapabilityKind, KindMeta> = {
  // Every colour class is written out in full. Tailwind's JIT scans source text
  // for complete class names, so a composed `bg-sol-${accent}/10` produces no CSS
  // at all — the same reason `deviceAccentClasses` in DeviceBadge.tsx spells its
  // classes out. Only the fixed-hex sol colours (and cyan, which carries an
  // <alpha-value>) accept the `/NN` modifier; the var-backed tokens (bg, card,
  // border, text-*) silently drop it.
  skill: {
    label: "Skill",
    plural: "skills",
    icon: Sparkles,
    chip: "border-sol-blue/40 bg-sol-blue/10 text-sol-blue",
    rail: "bg-sol-blue/60",
    blurb: "Instructions the agent loads when it needs them",
  },
  command: {
    label: "Command",
    plural: "commands",
    icon: Terminal,
    chip: "border-sol-cyan/40 bg-sol-cyan/10 text-sol-cyan",
    rail: "bg-sol-cyan/60",
    blurb: "A slash command you invoke by name",
  },
  subagent: {
    label: "Subagent",
    plural: "subagents",
    icon: Bot,
    chip: "border-sol-violet/40 bg-sol-violet/10 text-sol-violet",
    rail: "bg-sol-violet/60",
    blurb: "A named agent the main one can delegate to",
  },
  plugin: {
    label: "Plugin",
    plural: "plugins",
    icon: Puzzle,
    chip: "border-sol-orange/40 bg-sol-orange/10 text-sol-orange",
    rail: "bg-sol-orange/60",
    blurb: "A bundle from a marketplace — may contain any of the others",
  },
  mcp: {
    label: "MCP server",
    plural: "MCP servers",
    icon: Plug,
    chip: "border-sol-green/40 bg-sol-green/10 text-sol-green",
    rail: "bg-sol-green/60",
    blurb: "A process or endpoint that gives the agent tools",
  },
  hook: {
    label: "Hook",
    plural: "hooks",
    icon: Webhook,
    chip: "border-sol-red/40 bg-sol-red/10 text-sol-red",
    rail: "bg-sol-red/60",
    blurb: "A command that runs on an agent lifecycle event",
  },
  snippet: {
    label: "Snippet",
    plural: "snippets",
    icon: FileText,
    chip: "border-sol-yellow/40 bg-sol-yellow/10 text-sol-yellow",
    rail: "bg-sol-yellow/60",
    blurb: "Prose written into an instruction file",
  },
};

export function kindMeta(kind: string): KindMeta | undefined {
  return (KIND_META as Record<string, KindMeta | undefined>)[kind];
}

/**
 * What a capability can do to the machine, which is the axis that matters for
 * trust — not its kind. Prose is read into context; code runs.
 *
 * This is the RENDERED verdict, and it is deliberately NOT called
 * `ExecutionSurface`: the shared contract already exports that name for the
 * eight surfaces a scanner observes. Two different concepts under one exported
 * name is how a badge and the consent gate that protects the user end up
 * disagreeing, so this one is named for what it is — a confidence bucket. No
 * identifier below spells `surface` for a bucket: as a NAME that word is the
 * contract's alone.
 *
 * `confidenceFromSurfaces` derives it from real findings; `confidenceFromKind`
 * is the floor used when nothing has looked. Nothing else may produce one — see
 * `CatalogEntry.surfaces`.
 */
export type ExecutionConfidence = "prose" | "code" | "unknown";

/**
 * The badge for a capability whose surfaces have actually been observed.
 *
 * Delegates the verdict to `requiresExplicitConsent` rather than re-deciding it,
 * so the chip and the gate can never disagree — including on the contract's rule
 * that an empty classification counts as dangerous. Undefined surfaces mean
 * nothing has looked yet, which is `unknown`, not `prose`.
 */
export function confidenceFromSurfaces(
  surfaces: readonly ExecutionSurface[] | undefined,
): ExecutionConfidence {
  if (surfaces === undefined) return "unknown";
  return requiresExplicitConsent(surfaces) ? "code" : "prose";
}

/**
 * The floor used when nothing has looked inside — a guess about a kind, not a
 * finding about a capability, so it may only be as reassuring as the kind makes
 * it certain.
 *
 * Only a snippet is prose by construction: it is text written into an
 * instruction file and there is nowhere for code to hide. MCP servers, hooks and
 * plugins run code by definition. Everything in between — skills, commands,
 * subagents — is unknown rather than safe: a skill directory can ship a `bin`,
 * and a command can declare `allowed-tools` and shell out, both of which look
 * like markdown from the outside. Calling those prose would be the one thing the
 * contract forbids, an unclassified capability rendered as harmless.
 */
export function confidenceFromKind(kind: CapabilityKind | string): ExecutionConfidence {
  if (kind === "mcp" || kind === "hook" || kind === "plugin") return "code";
  return kind === "snippet" ? "prose" : "unknown";
}

/**
 * A `surfaces` value this build can actually read, or undefined for "no scan".
 *
 * The type says `ExecutionSurface[]`, but the bytes do not have to agree:
 * `webCatalogList` (`packages/convex/convex/capabilities.ts`) copies every
 * non-reserved key of a catalog row's `entry_json` onto the card verbatim, and
 * that blob is publisher-supplied and unvalidated by its own comment. So the
 * field is re-checked here rather than trusted.
 *
 * Every malformed shape lands on the same side. A string, a number, an object,
 * or a list carrying a member this build does not model all collapse to empty,
 * and the gate's own rule calls empty dangerous. The field was PRESENT, so a
 * scan ran; we just could not read what it found, and a failed read may not
 * render as reassuring. Filtering an unknown member out instead would LOWER the
 * risk of the row we understand least — `deriveExecutionSurfaces` accepts
 * declared surfaces additively for the same reason.
 *
 * Only a genuinely absent field means no scan, and only that reaches the kind
 * floor.
 */
function observedSurfaces(value: unknown): readonly ExecutionSurface[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return [];
  return value.every(isExecutionSurface) ? (value as ExecutionSurface[]) : [];
}

/**
 * The one way to get a badge for an entry: observed surfaces when a scan has
 * run, the kind floor when none has.
 *
 * It exists so the choice between the two is written once. A second copy of
 * this conditional is how one caller starts trusting a field another derives.
 */
export function entryConfidence(
  entry: Pick<CatalogEntry, "kind" | "surfaces">,
): ExecutionConfidence {
  const surfaces = observedSurfaces(entry.surfaces);
  return surfaces ? confidenceFromSurfaces(surfaces) : confidenceFromKind(entry.kind);
}

// ----------------------------------------------------------------- devices

/**
 * A machine as this surface needs it: the identity bits from `devices`, plus
 * whether it has ever reported an inventory.
 *
 * `reportedAt === null` is the load-bearing state. It means the machine is known
 * but has never told us what it has, which is NOT the same as having nothing —
 * every cell for such a column renders "unknown", never "absent".
 */
export interface CapabilityDevice {
  deviceId: string;
  name: string;
  kindLabel: string;
  online: boolean;
  lastSeen: number;
  /** Epoch ms of the last inventory report, or null if it never sent one. */
  reportedAt: number | null;
  /**
   * The report is old enough to have stopped being believable. The daemon writes
   * on change and once an hour to prove it is alive, so silence past that is a
   * machine we cannot vouch for — shown as a caveat, never as an empty machine.
   */
  stale?: boolean;
  /** The last error the daemon reported while scanning, if any. */
  error?: string;
  /** Agent client version, when the daemon recorded it (e.g. "claude 2.1.220"). */
  clientVersion?: string;
}

/** Project a `devices` row plus its inventory report into the surface's shape.
 *  Reuses the naming helpers so a machine reads identically here and in every
 *  device chip elsewhere in the app. */
export function toCapabilityDevice(
  d: Device,
  report?: { reportedAt?: number; stale?: boolean; error?: string; clientVersion?: string },
): CapabilityDevice {
  return {
    deviceId: d.device_id,
    name: deviceDisplayName(d),
    kindLabel: deviceKindLabel(d),
    online: d.online,
    lastSeen: d.last_seen,
    // Zero is not a timestamp — a rollup that saw no `reported_at` leaves it at
    // 0, and treating that as "reported at the epoch" would turn a silent
    // machine into one claiming to have nothing.
    reportedAt:
      typeof report?.reportedAt === "number" && report.reportedAt > 0 ? report.reportedAt : null,
    stale: report?.stale,
    error: report?.error,
    clientVersion: report?.clientVersion,
  };
}

// ------------------------------------------------------------------ entries

/** One place a capability actually exists, on one machine. */
export interface InstallSite {
  deviceId: string;
  /** Which scope switched it on there. */
  scope: CapabilityScope;
  /** False means switched off on purpose — a decision, not an absence. */
  enabled: boolean;
  /** Switched on there with nothing downloaded behind it. Enabled and broken are
   *  both true at once: the declaration is real, the bytes are not. */
  broken?: boolean;
  /** Downloaded but not declared anywhere. Plugins only. */
  installedOnly?: boolean;
  version?: string;
  /** The commit Claude Code pinned the install to. */
  sha?: string;
}

/** A browsable catalog entry: a thing you could have, cross-referenced against
 *  the machines you own. */
export interface CatalogEntry {
  /** Stable identity — the flat slug namespace (`mkt/<marketplace>/<plugin>`). */
  slug: string;
  name: string;
  /**
   * A modelled kind, or whatever the machine called it. Claude Code grows kinds
   * faster than this file does — output styles and statuslines already exist —
   * and a row we cannot classify is still a row the user has, so it is carried
   * through verbatim and every chip below renders an unknown kind as its name.
   */
  kind: CapabilityKind | string;
  description?: string;
  /** Who publishes it — an org or a person. */
  publisher?: string;
  /** The marketplace it is listed in, when it came from one. */
  marketplace?: string;
  /** "owner/repo" of the source, when known. */
  repo?: string;
  homepage?: string;
  /** What a bundle contains, by kind. Only plugins normally carry this. */
  contents?: Partial<Record<CapabilityKind, number>>;
  cost?: TokenCost;
  /**
   * What a scan actually observed this capability can do, in the contract's own
   * vocabulary. The rendered badge is NOT stored beside it: an adapter that
   * could hand-set the badge could hand-set a reassuring one, which is the whole
   * bug. Undefined means no scan has run, which `entryConfidence` renders as the
   * kind floor — never as prose.
   */
  surfaces?: readonly ExecutionSurface[];
  /** Every machine of yours that has it. Empty = installed nowhere. */
  /** Absent on a public catalog row straight off the wire; withFleetInstalls
   *  fills it. Readers treat undefined as empty. */
  installs?: InstallSite[];
  updatedAt?: number;
}

// -------------------------------------------------------------------- chips

export function KindChip({ kind, compact }: { kind: CapabilityKind | string; compact?: boolean }) {
  const meta = kindMeta(kind);
  if (!meta) {
    // An unknown kind is data we do not model yet. Show it verbatim rather than
    // dropping the row — a capability we cannot classify is still one the user has.
    return (
      <span className="inline-flex items-center h-5 px-1.5 rounded border border-sol-border text-[10px] font-mono text-sol-text-dim">
        {String(kind)}
      </span>
    );
  }
  const Icon = meta.icon;
  return (
    <ShortcutTooltip label={meta.blurb} side="top">
      <span
        className={`inline-flex items-center gap-1 h-5 px-1.5 rounded border text-[10px] whitespace-nowrap cursor-default ${meta.chip}`}
      >
        <Icon className="w-3 h-3" />
        {!compact && meta.label}
      </span>
    </ShortcutTooltip>
  );
}

export function ScopeChip({ scope }: { scope: CapabilityScope }) {
  const label = scope === "user" ? "user" : scope === "project" ? "project" : "local";
  return (
    <span className="inline-flex items-center h-4 px-1 rounded-sm bg-sol-bg-inset text-[9px] font-mono text-sol-text-dim">
      {label}
    </span>
  );
}

/**
 * The trust marker. Three buckets, two marks: prose renders nothing, because
 * there is nothing to warn about.
 *
 * "Unknown" gets its own quiet mark rather than silence. Silence is what a
 * reader takes for safety, and this page has no way to earn that reading — a
 * kind is not an inspection. It is deliberately subdued: the loud red mark is
 * for a capability that certainly runs code, and if the two looked alike neither
 * would mean anything.
 */
export function ExecutionChip({ confidence }: { confidence: ExecutionConfidence }) {
  if (confidence === "prose") return null;
  if (confidence === "unknown") {
    return (
      <ShortcutTooltip
        label="Nothing has looked inside this yet. A skill can ship a script and a command can declare tools, so it is not known to be text only."
        side="top"
      >
        <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded border border-dashed border-sol-border text-[10px] text-sol-text-dim whitespace-nowrap cursor-default">
          <ShieldQuestion className="w-3 h-3" />
          not inspected
        </span>
      </ShortcutTooltip>
    );
  }
  return (
    <ShortcutTooltip
      label="Runs code on the machine, not just text in the context window"
      side="top"
    >
      <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded border border-sol-red/40 bg-sol-red/10 text-[10px] text-sol-red whitespace-nowrap cursor-default">
        <ShieldAlert className="w-3 h-3" />
        runs code
      </span>
    </ShortcutTooltip>
  );
}

/** "3 skills · 2 commands · 1 MCP server" — what a bundle actually contains. */
export function ContentsLine({ contents }: { contents?: Partial<Record<CapabilityKind, number>> }) {
  const parts = useMemo(() => {
    if (!contents) return [];
    return CAPABILITY_KINDS.flatMap((k) => {
      const n = contents[k];
      if (!n) return [];
      return [`${n} ${n === 1 ? KIND_META[k].label.toLowerCase() : KIND_META[k].plural}`];
    });
  }, [contents]);
  if (parts.length === 0) return null;
  return (
    <div className="text-[11px] text-sol-text-muted font-mono truncate">{parts.join(" · ")}</div>
  );
}

// ---------------------------------------------------------- install footprint

/**
 * The cross-reference, and the reason to browse a catalog here instead of in
 * `/plugin`: for every entry, which of YOUR machines already has it.
 *
 * A machine that has never reported is rendered as unknown rather than missing.
 * Claiming "not installed on m1" when m1 never spoke would be exactly the lie
 * this page exists to prevent.
 */
export function InstallFootprint({
  entry,
  devices,
}: {
  entry: CatalogEntry;
  devices: CapabilityDevice[];
}) {
  const byDevice = useMemo(() => {
    const m = new Map<string, InstallSite>();
    for (const site of entry.installs ?? []) {
      const prev = m.get(site.deviceId);
      // Scopes stack; a site that actually works is the more useful truth to
      // show, so a working one displaces a broken or switched-off one.
      const better = (s: InstallSite) => (s.enabled && !s.broken ? 2 : s.enabled ? 1 : 0);
      if (!prev || better(site) > better(prev)) m.set(site.deviceId, site);
    }
    return m;
  }, [entry.installs]);

  const reporting = devices.filter((d) => d.reportedAt !== null);
  // "On 2 of 3" has to mean working on 2 of 3 — a machine where the declaration
  // points at nothing is not a machine that has it.
  const present = reporting.filter((d) => {
    const site = byDevice.get(d.deviceId);
    return Boolean(site && site.enabled && !site.broken);
  });

  if (devices.length === 0) {
    return <span className="text-[11px] text-sol-text-dim">No machines to compare</span>;
  }

  return (
    // One provider for the whole footprint rather than ShortcutTooltip's
    // per-instance one: a grid of cards times a fleet of machines is hundreds of
    // pills, and each would otherwise mount its own provider. Nesting inside an
    // outer provider is legal, so this stays correct wherever it is dropped.
    <TooltipProvider delayDuration={300}>
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] text-sol-text-muted">
        {reporting.length === 0 ? (
          <span className="text-sol-yellow">no machine has reported</span>
        ) : present.length === 0 ? (
          "installed nowhere"
        ) : (
          <>
            on <span className="text-sol-text">{present.length}</span> of {reporting.length}
          </>
        )}
      </span>
      {devices.map((d) => {
        const site = byDevice.get(d.deviceId);
        // A machine that never reported is unknown whatever else we hold about
        // it — nothing we could show would be something it told us.
        const state =
          d.reportedAt === null
            ? "unknown"
            : !site
              ? "absent"
              : site.broken
                ? "broken"
                : site.enabled
                  ? "on"
                  : "off";
        return (
          <Tooltip key={d.deviceId}>
            <TooltipTrigger asChild>
            <span
              className={`inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-mono cursor-default border ${
                state === "on"
                  ? "border-sol-green/40 bg-sol-green/10 text-sol-green"
                  : state === "broken"
                    ? "border-sol-red/40 bg-sol-red/10 text-sol-red"
                    : state === "off"
                      ? "border-sol-border bg-sol-bg-inset text-sol-text-dim line-through"
                      : state === "unknown"
                        ? "border-dashed border-sol-yellow/40 text-sol-yellow"
                        : "border-sol-border text-sol-text-dim"
              }`}
            >
              {state !== "unknown" && <DeviceDot online={d.online} />}
              <span className="max-w-[92px] truncate">{d.name}</span>
            </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="bg-sol-bg text-sol-text border border-sol-border shadow-md"
            >
              <span className="flex flex-col text-left">
                <span className="text-sol-text">
                  {d.name}
                  <span className="text-sol-text-dim"> · {d.kindLabel}</span>
                </span>
                <span className="text-sol-text-muted">
                  {state === "unknown"
                    ? "never reported an inventory"
                    : state === "on"
                      ? `enabled at ${site!.scope} scope${site!.version ? ` · ${site!.version}` : ""}`
                      : state === "broken"
                        ? "switched on, but nothing was ever downloaded"
                        : state === "off"
                          ? "present but switched off"
                          : "not installed here"}
                </span>
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
    </TooltipProvider>
  );
}

// --------------------------------------------------------------------- card

/**
 * One catalog entry. Dense on purpose — a browse surface is scanned, not read,
 * so identity, kind, what it costs and where it already lives all have to land
 * in one glance.
 */
export function CapabilityCard({
  entry,
  devices,
  focused,
  onOpen,
  actions,
}: {
  entry: CatalogEntry;
  devices: CapabilityDevice[];
  focused?: boolean;
  onOpen?: (entry: CatalogEntry) => void;
  /** Trailing controls — an install button lands here when writes ship. */
  actions?: ReactNode;
}) {
  const confidence = entryConfidence(entry);
  const rail = kindMeta(entry.kind)?.rail ?? "bg-sol-magenta/60";

  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? () => onOpen(entry) : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(entry);
              }
            }
          : undefined
      }
      className={`group relative flex flex-col gap-2 rounded-lg border bg-sol-card p-3 transition-colors text-left ${
        onOpen ? "cursor-pointer hover:bg-sol-card-hover" : ""
      } ${
        focused
          ? "border-sol-magenta/60 ring-1 ring-sol-magenta/30"
          : "border-sol-border hover:border-sol-magenta/40"
      }`}
    >
      {/* The kind's colour as a hairline rail — enough to sort the grid by eye
          at a glance without painting the whole card. */}
      <span aria-hidden className={`absolute left-0 top-2 bottom-2 w-[2px] rounded-full ${rail}`} />

      <div className="flex items-start gap-2 pl-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-[13px] text-sol-text truncate">{entry.name}</span>
            <KindChip kind={entry.kind} compact />
            <ExecutionChip confidence={confidence} />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-sol-text-dim font-mono truncate">
            {entry.publisher && <span className="truncate">{entry.publisher}</span>}
            {entry.publisher && entry.marketplace && <span>/</span>}
            {entry.marketplace && <span className="truncate">{entry.marketplace}</span>}
            {!entry.publisher && !entry.marketplace && entry.repo && (
              <span className="truncate">{entry.repo}</span>
            )}
          </div>
        </div>
        {actions}
      </div>

      {entry.description && (
        <p className="pl-1.5 text-xs text-sol-text-muted leading-relaxed line-clamp-2">
          {entry.description}
        </p>
      )}

      <div className="pl-1.5">
        <ContentsLine contents={entry.contents} />
      </div>

      <div className="pl-1.5 flex items-center gap-2 flex-wrap justify-between">
        <InstallFootprint entry={entry} devices={devices} />
        <TokenCostBadge cost={entry.cost} variant="compact" />
      </div>
    </div>
  );
}
