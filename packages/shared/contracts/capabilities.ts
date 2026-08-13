// The shared vocabulary for the capability library: what a capability IS, where
// it can be switched on, and what a machine is supposed to end up with.
//
// Four runtimes import this file and must agree byte for byte — the daemon (to
// reconcile disk), the browser (to preview a change before it happens), Convex
// (to tell a device what it should have) and Hermes on mobile. A disagreement
// between them is the worst bug this system can have: invisible, per machine,
// and shaped like "the toggle did not take". So this module is PURE data and
// pure functions — no Node builtins, no `import.meta`, no `window`/`document`,
// no clock, no randomness. Same rule the snippet catalog states for itself
// (`snippets.ts:17-18`).
//
// Three separate ideas live here and are deliberately not merged:
//
//   kind      what a capability is (a skill, an MCP server, a plugin, …)
//   source    where its bytes come from (built in, a marketplace, a git repo, …)
//   scope     where a person switched it on (this session, this project, …)
//
// The resolver in `capabilityResolver.ts` consumes all three; this file never
// decides anything.

/* --------------------------------------------------------------------------
 * Kinds
 * -------------------------------------------------------------------------- */

/**
 * What a capability is.
 *
 * `command` is a READ ONLY legacy shape. Claude Code merged commands into
 * skills upstream and a skill wins a name clash, so we never materialize a
 * command — but bare `<dir>/<name>.md` command files are still on real disks
 * and the machine inventory reports them (`packages/cli/src/capabilities/inventory.ts`),
 * so the vocabulary has to be able to name one. `MATERIALIZABLE_KINDS` is the
 * list a driver may write.
 *
 * `mcp` rather than `mcp_server`: the inventory reader already emits `"mcp"`
 * and renaming at the seam buys nothing but a conversion function that can be
 * wrong in one direction.
 */
export const CAPABILITY_KINDS = [
  "snippet",
  "skill",
  "command",
  "subagent",
  "mcp",
  "plugin",
  "hook",
] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/** The kinds a driver is allowed to write. See the `command` note above. */
export const MATERIALIZABLE_KINDS = [
  "snippet",
  "skill",
  "subagent",
  "mcp",
  "plugin",
  "hook",
] as const satisfies readonly CapabilityKind[];

export type MaterializableKind = (typeof MATERIALIZABLE_KINDS)[number];

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return typeof value === "string" && (CAPABILITY_KINDS as readonly string[]).includes(value);
}

export function isMaterializableKind(value: unknown): value is MaterializableKind {
  return typeof value === "string" && (MATERIALIZABLE_KINDS as readonly string[]).includes(value);
}

/* --------------------------------------------------------------------------
 * Sources
 * -------------------------------------------------------------------------- */

/** Where a capability's bytes come from. */
export const CAPABILITY_SOURCES = [
  "builtin",
  "git",
  "marketplace",
  "mcp_registry",
  "authored",
] as const;

export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

export function isCapabilitySource(value: unknown): value is CapabilitySource {
  return typeof value === "string" && (CAPABILITY_SOURCES as readonly string[]).includes(value);
}

/**
 * The slug prefix each source owns.
 *
 * The prefix is what makes a builtin unclaimable: a slug beginning `builtin/`
 * can only be produced by `formatCapabilitySlug` with source `builtin`, so a
 * third party entry can never render with an official looking name. Ingest
 * BUILDS slugs from a source it determined itself; it never accepts one.
 */
export const CAPABILITY_SOURCE_PREFIX = {
  builtin: "builtin",
  marketplace: "mkt",
  git: "git",
  mcp_registry: "mcp",
  authored: "authored",
} as const satisfies Record<CapabilitySource, string>;

const PREFIX_TO_SOURCE: Record<string, CapabilitySource> = {
  builtin: "builtin",
  mkt: "marketplace",
  git: "git",
  mcp: "mcp_registry",
  authored: "authored",
};

/* --------------------------------------------------------------------------
 * CapabilityRef — the identity that survives leaving this machine
 * -------------------------------------------------------------------------- */

/**
 * A capability's identity, stable across machines, checkouts and clients.
 *
 * Never a filesystem path: a path is a property of one disk, so a binding
 * carrying one means a fresh clone somewhere else does not match, and a team
 * shared row means one member picking a directory on everyone else's machine.
 * The wire form is the flat `slug`; the parsed fields are a convenience for
 * rendering and for the content store.
 *
 *   builtin/memory
 *   mkt/claude-plugins-official/code-simplifier
 *   git/anthropics/skills@30287f5#skills/pdf
 *   mcp/io.github.foo/server
 *   authored/ashot/deploy-checklist
 */
export interface CapabilityRef {
  /** The canonical wire form. Globally unique; what a binding stores. */
  slug: string;
  source: CapabilitySource;
  /** Path segments after the source prefix. Always at least one. */
  segments: string[];
  /** `git` only: the pin after `@` — a commit sha or a tag. */
  pin?: string;
  /** `git` only: the path inside the repository after `#`. */
  subpath?: string;
}

/** The longest slug we accept. A slug becomes a directory name in the content
 *  store and a JSON key on the wire, so it is bounded on purpose. */
export const MAX_CAPABILITY_SLUG_LENGTH = 200;

// A segment may hold letters, digits, dot, underscore and hyphen. Plugin and
// marketplace names in the wild use all of these. Everything else — spaces,
// slashes, `@`, `#`, control characters, anything non-ASCII — is rejected,
// because a slug is used as a path segment and as a display string, and both
// uses have been exploited elsewhere by confusable or traversing names.
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidSegment(segment: string): boolean {
  if (!SEGMENT_PATTERN.test(segment)) return false;
  // `.` and `..` pass the character test and are exactly the two that escape a
  // directory when a slug is joined onto a store path.
  return segment !== "." && segment !== "..";
}

/**
 * Build the canonical slug for a capability. Returns null when any part is
 * unusable, so a caller has to decide what to do rather than persisting a
 * broken identity.
 */
export function formatCapabilitySlug(ref: Omit<CapabilityRef, "slug">): string | null {
  if (!isCapabilitySource(ref.source)) return null;
  if (!Array.isArray(ref.segments) || ref.segments.length === 0) return null;
  if (!ref.segments.every(isValidSegment)) return null;

  const isGit = ref.source === "git";
  if (!isGit && (ref.pin !== undefined || ref.subpath !== undefined)) return null;
  if (ref.pin !== undefined && !isValidSegment(ref.pin)) return null;
  if (ref.subpath !== undefined) {
    const parts = ref.subpath.split("/");
    if (parts.length === 0 || !parts.every(isValidSegment)) return null;
  }

  let slug = `${CAPABILITY_SOURCE_PREFIX[ref.source]}/${ref.segments.join("/")}`;
  if (ref.pin !== undefined) slug += `@${ref.pin}`;
  if (ref.subpath !== undefined) slug += `#${ref.subpath}`;
  return slug.length <= MAX_CAPABILITY_SLUG_LENGTH ? slug : null;
}

/**
 * Parse a slug back into its parts. Returns null for anything malformed —
 * following `sanitizeSshHost`'s convention (`devices.ts:938`), a rejected
 * input is null rather than a throw, because this runs over rows written by
 * other machines and one bad row must not break a whole render.
 */
export function parseCapabilitySlug(slug: unknown): CapabilityRef | null {
  if (typeof slug !== "string") return null;
  if (slug.length === 0 || slug.length > MAX_CAPABILITY_SLUG_LENGTH) return null;
  if (slug !== slug.trim()) return null;

  // Order matters: `#` may only appear after `@`, and neither may appear in the
  // prefix or in a non-git slug.
  let rest = slug;
  let subpath: string | undefined;
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    subpath = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  let pin: string | undefined;
  const atAt = rest.indexOf("@");
  if (atAt >= 0) {
    pin = rest.slice(atAt + 1);
    rest = rest.slice(0, atAt);
  }

  const parts = rest.split("/");
  const prefix = parts.shift();
  if (prefix === undefined) return null;
  const source = PREFIX_TO_SOURCE[prefix];
  if (source === undefined) return null;
  if (parts.length === 0 || !parts.every(isValidSegment)) return null;

  if (source !== "git" && (pin !== undefined || subpath !== undefined)) return null;
  if (pin !== undefined && !isValidSegment(pin)) return null;
  if (subpath !== undefined && !subpath.split("/").every(isValidSegment)) return null;

  return { slug, source, segments: parts, ...(pin ? { pin } : {}), ...(subpath ? { subpath } : {}) };
}

/** The source a slug claims, or null when the slug is malformed. */
export function capabilitySlugSource(slug: unknown): CapabilitySource | null {
  return parseCapabilitySlug(slug)?.source ?? null;
}

/**
 * Whether a slug may be stored against a capability from this source. Ingest
 * calls this before writing a row: a `marketplace` entry claiming
 * `builtin/memory` is the builtin hijack, and it is rejected here rather than
 * discovered later in a UI that renders it as ours.
 */
export function slugMatchesSource(slug: unknown, source: CapabilitySource): boolean {
  return capabilitySlugSource(slug) === source;
}

/* --------------------------------------------------------------------------
 * Execution surfaces
 * -------------------------------------------------------------------------- */

/**
 * What a capability can actually do once it is on disk. The file is not the
 * risk; the runtime is — a plugin and a skill can both ship a `bin` directory,
 * and a "markdown only" skill that declares `allowed-tools` has removed the
 * last interactive checkpoint.
 *
 * Derived structurally from what a capability had to populate for it to work,
 * never accepted from a publisher: a declared list may only RAISE risk.
 */
export const EXECUTION_SURFACES = [
  "prose",
  "reads_files",
  "declares_allowed_tools",
  "ships_scripts",
  "ships_bin",
  "declares_hooks",
  "mcp_stdio_command",
  "mcp_remote_url",
] as const;

export type ExecutionSurface = (typeof EXECUTION_SURFACES)[number];

export function isExecutionSurface(value: unknown): value is ExecutionSurface {
  return typeof value === "string" && (EXECUTION_SURFACES as readonly string[]).includes(value);
}

/** The two surfaces a machine can carry without a human agreeing to it first. */
export const BENIGN_EXECUTION_SURFACES = ["prose", "reads_files"] as const satisfies
  readonly ExecutionSurface[];

/**
 * True when materializing this capability needs consent from the person on the
 * machine it lands on. Everything past prose and reading files either runs code
 * or removes a prompt that would have asked.
 */
export function requiresExplicitConsent(surfaces: readonly ExecutionSurface[] | undefined): boolean {
  if (!surfaces || surfaces.length === 0) {
    // An unclassified capability is treated as dangerous. The alternative —
    // "no surfaces recorded, so assume prose" — turns a failed classification
    // into a silent install.
    return true;
  }
  return surfaces.some((s) => !(BENIGN_EXECUTION_SURFACES as readonly string[]).includes(s));
}

/* --------------------------------------------------------------------------
 * The scope ladder
 * -------------------------------------------------------------------------- */

/**
 * Where a capability was switched on or off. Listed widest first, which is the
 * order a UI reads them in; `SCOPE_PRECEDENCE` carries the ranking the resolver
 * uses.
 */
export const SCOPE_KINDS = ["team", "user", "device", "project", "session"] as const;

export type ScopeKind = (typeof SCOPE_KINDS)[number];

/**
 * Narrowest wins. The numbers are ranks, not weights — nothing adds them.
 *
 * The ladder reads as "the more specific answer to the more general question":
 * a team offers, a user decides for themselves, a device decides for one
 * machine, a project decides for one checkout, a session decides for one
 * conversation.
 */
export const SCOPE_PRECEDENCE = {
  team: 1,
  user: 2,
  device: 3,
  project: 4,
  session: 5,
} as const satisfies Record<ScopeKind, number>;

export function isScopeKind(value: unknown): value is ScopeKind {
  return typeof value === "string" && (SCOPE_KINDS as readonly string[]).includes(value);
}

export function scopePrecedence(kind: ScopeKind): number {
  return SCOPE_PRECEDENCE[kind];
}

/** Sort comparator putting the NARROWEST scope first. */
export function compareScopeNarrowness(a: ScopeKind, b: ScopeKind): number {
  return SCOPE_PRECEDENCE[b] - SCOPE_PRECEDENCE[a];
}

/* --------------------------------------------------------------------------
 * The persisted shapes
 * -------------------------------------------------------------------------- */

/** A pin identifies the exact bytes a capability resolved to. */
export interface CapabilityPin {
  /** Claude Code's own model: the commit a plugin install came from. */
  gitSha?: string;
  /** skills.sh's model: a hash over the capability's file tree. */
  folderHash?: string;
  /** Human facing only. A version string is not a pin — it can be re-tagged. */
  version?: string;
}

/**
 * A capability as the library knows it, independent of any machine.
 *
 * `surfaces` and `manifestHash` are derived server side from raw observations.
 * A publisher supplied copy of either is compared, never trusted: a mismatch is
 * an integrity signal worth surfacing, not a value worth adopting.
 */
export interface Capability {
  slug: string;
  kind: CapabilityKind;
  source: CapabilitySource;
  /** Display name. Not an identity — the directory name is (skills), or the
   *  `name@marketplace` id is (plugins). */
  name: string;
  description?: string;
  /** Copied from the source's `author.name`. Anyone can write "Anthropic"
   *  there, so it renders as unverified and never in a builtin's typography. */
  publisher?: string;
  pin?: CapabilityPin;
  surfaces?: ExecutionSurface[];
  /** Covers the component inventory, surfaces, MCP commands and urls, env keys,
   *  `allowed-tools` and hooks. Consent is against this, not against a version. */
  manifestHash?: string;
}

/**
 * The scope Claude Code itself reports for something on disk. This is NOT the
 * ladder above and must not be widened into it: `local` is a settings FILE
 * (`settings.local.json`), and Claude Code's scopes stack rather than override,
 * so the same plugin enabled at user and project scope is observed twice.
 */
export const OBSERVED_SCOPES = ["local", "project", "user"] as const;

export type ObservedScope = (typeof OBSERVED_SCOPES)[number];

export function isObservedScope(value: unknown): value is ObservedScope {
  return typeof value === "string" && (OBSERVED_SCOPES as readonly string[]).includes(value);
}

/**
 * One capability as observed on one machine, for one client.
 *
 * `enabled` and `installed` are independent, and collapsing them loses two real
 * states the library exists to show:
 *
 *   enabled true,  installed false — declared in settings, bytes never downloaded
 *   enabled false, installed true  — downloaded, switched off or never declared
 *
 * The second is an offer that costs nothing to accept; the first is a broken
 * install that looks fine in a settings file. A single boolean tells you
 * neither.
 */
export interface InstalledEntry {
  kind: CapabilityKind;
  /** Unique within its kind on that machine: a skill's directory name, a
   *  plugin's `name@marketplace`. */
  name: string;
  /** Set once the entry has been matched to a library capability. Absent means
   *  the machine has something the library does not know about — which is the
   *  normal case on the first scan and must render, not be dropped. */
  slug?: string;
  description?: string;
  scope: ObservedScope;
  enabled: boolean;
  installed: boolean;
  /** Absolute path on that machine. A hint for the human and for diffing; never
   *  an identity, and never matched against across machines. */
  source?: string;
  /** Kind specific extras: a plugin's marketplace and sha, an MCP server's
   *  transport and command line. */
  meta?: Record<string, string>;
}

/**
 * A wish: this capability, at this scope, on or off.
 *
 * `enabled: false` is a real revoke, not an absence. Deleting the row instead
 * would silently re-inherit whatever a wider scope says, which is the opposite
 * of what a person means when they switch something off.
 */
export interface CapabilityBinding {
  /** The Convex `_id`. Opaque here; used only as the last tie break so two
   *  runtimes resolving the same rows cannot disagree. */
  id: string;
  /** The row's owner. For a team binding this is the admin who wrote it, not
   *  the person it will land on. */
  userId: string;
  teamId?: string;
  capabilitySlug: string;
  scopeKind: ScopeKind;
  /** Identifies the scope instance, never a filesystem path. team → team id,
   *  user → user id, device → device id, project → repo identity
   *  (`git:<origin>` or `local:<user>:<path>`), session → conversation id. */
  scopeKey: string;
  enabled: boolean;
  /** Claude Code `userConfig` values. These substitute into MCP configs and
   *  hook commands, so where they came from decides whether they may be used
   *  at all — see the trust gate in the resolver. */
  config?: Record<string, string>;
  /** When present and non-empty, the binding applies only to these clients. */
  clientFilter?: string[];
  updatedAt: number;
  /** Provenance: "user", "migration", "loadout:<short-id>". */
  createdBy?: string;
}

/* --------------------------------------------------------------------------
 * The resolver's output
 * -------------------------------------------------------------------------- */

/**
 * Enough of a binding to answer "why is this active?" without a second lookup.
 * The trace is the product feature, not debug output — it is what a card shows
 * under the toggle, so it carries the scope, the flag and the row id.
 */
export interface BindingTrace {
  bindingId: string;
  scopeKind: ScopeKind;
  scopeKey: string;
  enabled: boolean;
  updatedAt: number;
  teamId?: string;
  createdBy?: string;
}

/**
 * Why a binding was set aside before precedence was even considered.
 *
 * `malformed_binding` is not paranoia: bindings arrive from other machines and
 * other clients, and the resolver must be total. One unparseable row dropping
 * with a reason is correct; one unparseable row throwing would blank an entire
 * machine's capability set.
 */
export const BINDING_IGNORE_REASONS = [
  "scope_not_in_context",
  "client_filtered",
  "malformed_binding",
] as const;

export type BindingIgnoreReason = (typeof BINDING_IGNORE_REASONS)[number];

export interface IgnoredBinding {
  bindingId: string;
  capabilitySlug: string;
  /** Raw, because a malformed row's scope may not be a `ScopeKind` at all. */
  scopeKind: string;
  scopeKey: string;
  reason: BindingIgnoreReason;
  /** One short phrase naming the specific failure. Rendered, so it is written
   *  for a person, not for a log. */
  detail?: string;
}

/**
 * Why an entry that resolved to enabled must still not be materialized here.
 *
 * Only the gate that is decidable from bindings alone lives here. Consent, pin
 * and source availability are gates too, and they hold entries the same way —
 * but they need the capability's manifest hash, the device's consent rows and
 * the local content store, none of which this function is given. They layer on
 * top of this result rather than inside it.
 */
export const CAPABILITY_WITHHOLD_REASONS = ["config_scope_not_trusted"] as const;

export type CapabilityWithholdReason = (typeof CAPABILITY_WITHHOLD_REASONS)[number];

export interface ResolvedCapability {
  slug: string;
  /** The resolved wish. False means a person switched it off somewhere that
   *  outranks wherever it was switched on. */
  enabled: boolean;
  /** Present only when `enabled` is true and materializing is still refused. */
  withheld?: CapabilityWithholdReason;
  /** Carried only when it may be used — see the trust gate in the resolver. */
  config?: Record<string, string>;
  /** The binding that decided it. */
  decidedBy: BindingTrace;
  /** Applicable bindings this one outranked, narrowest first. Empty is the
   *  common case; a non-empty list is exactly what "this team setting is
   *  overridden on your machine" renders from. */
  overrode: BindingTrace[];
}

/** What a machine should end up with, and why. */
export interface DesiredState {
  /** One row per slug any applicable binding mentions, sorted by slug. Includes
   *  rows resolved to `enabled: false`, because "switched off here" is an
   *  answer a UI has to show and a driver has to act on. */
  entries: ResolvedCapability[];
  /** Bindings that never entered the contest, each with why. Powers the other
   *  half of the question: "why is this NOT active?" */
  ignored: IgnoredBinding[];
}
