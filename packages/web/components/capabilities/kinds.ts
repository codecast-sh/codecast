// What every capability surface shares: the kinds and how they are drawn,
// the execution-confidence verdict derived from the consent gate, and the
// device shape the fleet rows are keyed by.

import { Bot, FileText, Plug, Puzzle, Sparkles, Terminal, Webhook } from "lucide-react";
import { deviceDisplayName, deviceKindLabel, type Device } from "../DeviceBadge";
import {
  isExecutionSurface,
  requiresExplicitConsent,
  type ExecutionSurface,
} from "@codecast/shared/contracts";

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
  entry: { kind: CapabilityKind | string; surfaces?: unknown },
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
