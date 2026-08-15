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

/** Inverted rather than written out, so the two directions cannot drift apart
 *  when a source is added. */
const PREFIX_TO_SOURCE: Record<string, CapabilitySource> = Object.fromEntries(
  CAPABILITY_SOURCES.map((source) => [CAPABILITY_SOURCE_PREFIX[source], source]),
);

/**
 * Prefixes the slug grammar reserves that name no bytes at all.
 *
 * A loadout is a named set of capabilities and a connector is a hosted account,
 * so neither has a source and neither is a `CapabilityRef`. Both are still
 * written into a binding's `capability_slug` (design §1.6), so the grammar has
 * to accept them: a resolver that validated slugs against the sources alone
 * would drop every loadout row as malformed the day loadouts ship, which is the
 * silent per-machine failure this whole contract exists to prevent.
 *
 * Reserving them now also makes them unclaimable the way `builtin/` is — a
 * marketplace cannot register a plugin that renders as `connector/slack`.
 */
export const RESERVED_SLUG_PREFIXES = ["connector", "loadout"] as const;

export type ReservedSlugPrefix = (typeof RESERVED_SLUG_PREFIXES)[number];

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
 * Assemble and validate a slug. The one writer, so no caller ever builds a slug
 * by concatenation and produces something the parser will later refuse — the
 * silent "I wrote a row and it never landed" failure.
 *
 * `allowPin` is false for every prefix but `git`, which is the only one whose
 * identity includes which bytes it resolved to.
 */
function buildSlug(
  prefix: string,
  segments: readonly string[],
  allowPin: boolean,
  pin?: string,
  subpath?: string,
): string | null {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  if (!segments.every(isValidSegment)) return null;
  if (!allowPin && (pin !== undefined || subpath !== undefined)) return null;
  if (pin !== undefined && !isValidSegment(pin)) return null;
  if (subpath !== undefined && !subpath.split("/").every(isValidSegment)) return null;

  let slug = `${prefix}/${segments.join("/")}`;
  if (pin !== undefined) slug += `@${pin}`;
  if (subpath !== undefined) slug += `#${subpath}`;
  return slug.length <= MAX_CAPABILITY_SLUG_LENGTH ? slug : null;
}

/**
 * Build the canonical slug for a capability. Returns null when any part is
 * unusable, so a caller has to decide what to do rather than persisting a
 * broken identity.
 */
export function formatCapabilitySlug(ref: Omit<CapabilityRef, "slug">): string | null {
  // Parse rejects an unpinned git slug (a moving ref names no fixed bytes), so
  // building one would mint an identity nothing can read back.
  if (ref.source === "git" && ref.pin === undefined) return null;
  if (!isCapabilitySource(ref.source)) return null;
  return buildSlug(
    CAPABILITY_SOURCE_PREFIX[ref.source],
    ref.segments,
    ref.source === "git",
    ref.pin,
    ref.subpath,
  );
}

/**
 * Build a slug in one of the reserved namespaces — `loadout/<short-id>` and
 * `connector/<vendor>`. Same grammar, same rejection, so a loadout id carrying
 * a slash or a confusable is caught where it is written rather than dropped by
 * the resolver on somebody's laptop.
 */
export function formatReservedSlug(prefix: ReservedSlugPrefix, segments: readonly string[]): string | null {
  if (!(RESERVED_SLUG_PREFIXES as readonly string[]).includes(prefix)) return null;
  return buildSlug(prefix, segments, false);
}

/**
 * Any slug in the namespace, including the two reserved prefixes that name no
 * bytes. `CapabilityRef` is the narrower view over this one, for the slugs that
 * do.
 */
export interface ParsedCapabilitySlug {
  slug: string;
  /** The part before the first `/`. */
  prefix: string;
  /** The source whose bytes this names, or null for `connector/` and
   *  `loadout/`, which have none. */
  source: CapabilitySource | null;
  segments: string[];
  pin?: string;
  subpath?: string;
}

/**
 * Parse any slug in the namespace. Returns null for anything malformed —
 * following `sanitizeSshHost`'s convention (`devices.ts:938`), a rejected
 * input is null rather than a throw, because this runs over rows written by
 * other machines and one bad row must not break a whole render.
 */
export function parseAnyCapabilitySlug(slug: unknown): ParsedCapabilitySlug | null {
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
  const source = PREFIX_TO_SOURCE[prefix] ?? null;
  const reserved = (RESERVED_SLUG_PREFIXES as readonly string[]).includes(prefix);
  if (source === null && !reserved) return null;
  if (parts.length === 0 || !parts.every(isValidSegment)) return null;

  if (source !== "git" && (pin !== undefined || subpath !== undefined)) return null;
  // A git slug without a pin is a moving ref: the bytes it names today are not
  // the bytes it names tomorrow, and consent granted against it means nothing.
  // The trust model pins every git source to a commit, so the grammar does too.
  if (source === "git" && pin === undefined) return null;
  if (pin !== undefined && !isValidSegment(pin)) return null;
  if (subpath !== undefined && !subpath.split("/").every(isValidSegment)) return null;

  return {
    slug,
    prefix,
    source,
    segments: parts,
    ...(pin ? { pin } : {}),
    ...(subpath ? { subpath } : {}),
  };
}

/**
 * Parse a slug that names a capability's bytes. Reserved prefixes are rejected
 * here on purpose: a `loadout/` slug is a well formed row but it has no source,
 * no manifest and nothing to materialize, so a caller reaching for a
 * `CapabilityRef` must not be handed one.
 */
export function parseCapabilitySlug(slug: unknown): CapabilityRef | null {
  const parsed = parseAnyCapabilitySlug(slug);
  if (!parsed || parsed.source === null) return null;
  const { prefix: _prefix, source, ...rest } = parsed;
  return { ...rest, source };
}

/**
 * Whether a slug is grammatically valid in some namespace we reserve — the
 * check to run over a binding row, whose `capability_slug` is a denormalized
 * free string written by clients at mixed versions (design §1.3). Wider than
 * `parseCapabilitySlug` because a binding may legitimately name a loadout.
 */
export function isWellFormedCapabilitySlug(slug: unknown): boolean {
  return parseAnyCapabilitySlug(slug) !== null;
}

/** The source a slug claims, or null when it is malformed or names no bytes. */
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
  /** Switched on for this machine. OPTIONAL because the wire does not always
   *  carry it, and only an explicit `false` denies — a missing field means the
   *  reader had nothing to say, not that the capability is off. Read it as
   *  `enabled !== false`. */
  enabled?: boolean;
  /** Downloaded to disk, independent of whether it is switched on. OPTIONAL for
   *  a sharper reason: the daemon's reader fills it ONLY for plugins, because
   *  only plugins have a download step distinct from being declared. A skill or
   *  an MCP server simply is or is not there. It was typed as required anyway,
   *  and all three readers grew a workaround plus a comment admitting the
   *  contract was wrong — the type is what changed, not the readers. */
  installed?: boolean;
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
  /** Minimum client version this capability needs (a hook event added in a
   *  later CLI, an MCP shape an old client cannot read). Dotted integers. */
  minClientVersion?: string;
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
  // The client being resolved for cannot express this capability kind at all
  // (capabilitySupport === "unsupported"). Named rather than silently degraded:
  // a codex machine that cannot run plugins must SAY so, or the fleet view
  // reads the hole as drift.
  "client_cannot_express",
  // The binding names a loadout, and loadout expansion has not shipped. Its own
  // reason so the rows are findable the day expansion lands — and so they never
  // read as malformed, which they are not.
  "loadout_not_expanded",
  // A git source with no pin. The grammar already refuses these; the resolver
  // names them rather than lumping them into malformed, because the fix is
  // specific ("pin it to a commit") and a person can act on it.
  "unpinned_source",
  // The binding demands a newer client than the one being resolved for. A real
  // producer, not an ornamental union member: compared only when BOTH sides
  // state a version, because guessing either way hides bindings or breaks them.
  "client_too_old",
  "malformed_binding",
] as const;

export type BindingIgnoreReason = (typeof BINDING_IGNORE_REASONS)[number];

export interface IgnoredBinding {
  bindingId: string;
  /** Raw, so a caller can match it against the slug it asked about. A row
   *  dropped for a bad slug carries that bad slug here; the human readable
   *  phrase in `detail` is the sanitized one. */
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
export const CAPABILITY_WITHHOLD_REASONS = ["config_scope_not_trusted", "config_malformed"] as const;

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
  /** Where the `config` came from, when that is a different row than the one
   *  that decided the flag. Enabling and configuring are separate wishes — a
   *  person can hold a token at user scope and switch the capability on in one
   *  project — so a card that named only `decidedBy` could not explain which
   *  values landed, or which row caused a `withheld`. */
  configFrom?: BindingTrace;
  /** Applicable bindings this one outranked, narrowest first. Empty is the
   *  common case; a non-empty list is exactly what "this team setting is
   *  overridden on your machine" renders from. */
  overrode: BindingTrace[];
  /**
   * Whether the capability's bytes are reachable right now. A THIRD state
   * beside desired/not-desired, never folded into `enabled`: an entry that is
   * desired but unavailable KEEPS its on-disk copy — it is never rewritten and
   * never planned for removal, because "the registry was down" must not delete
   * a working install. Absent means nothing probed availability (a pure
   * resolve without a content store), which planners treat as available —
   * refusing to act on an unprobed fleet would freeze every offline resolve.
   */
  availability?: "available" | "unavailable";
  /** Set by the consent gate: the capability has a newer version waiting, and
   *  materialization stays at THIS pin until a human approves the new hash. */
  heldAtPin?: string;
  /** With `availability: "unavailable"`: when the source last answered, so the
   *  UI can say "unreachable since Tuesday" instead of a bare warning. */
  lastOk?: number;
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

// ---------------------------------------------------------------- the manifest

/**
 * What a scanner actually observed inside a capability.
 *
 * Every field is what is THERE, never what the publisher says is there. The
 * distinction matters because consent is granted against this object: if a
 * publisher could edit it, consent would be granted against their claim rather
 * than against the code that will run.
 */
export interface CapabilityManifest {
  /** Components the capability ships, by kind — the same inventory
   *  `claude plugin details` prints. */
  components?: Partial<Record<CapabilityKind, string[]>>;
  /** Executables under `bin/`. A non-empty list is code, whatever the docs say. */
  bin?: string[];
  /** Scripts shipped alongside, e.g. under `scripts/`. */
  scripts?: string[];
  /** Lifecycle hooks the capability registers. */
  hooks?: string[];
  /** MCP servers it configures. A `command` is a local process; a `url` is a
   *  remote endpoint. Both are surfaces, and they are different ones. */
  mcp?: Array<{ name?: string; command?: string; url?: string }>;
  /** Tool grants declared in frontmatter (`allowed-tools`). */
  allowedTools?: string[];
  /** NAMES ONLY of environment variables it wants. Never values — this object is
   *  hashed, stored and rendered, and a secret in it would leak through all three. */
  envKeys?: string[];
  /** The artifact identity: a plugin install's gitCommitSha, a skill tree's
   *  folder hash. IN the manifest — and therefore in `manifestHash` — on
   *  purpose: consent names bytes, so a moved ref or a new commit behind an
   *  unchanged tag must move the hash and re-open the consent question. A
   *  version STRING never goes here; it can be re-tagged without the bytes
   *  changing, which is exactly the lie the hash exists to catch. */
  artifactPin?: string;
}

/**
 * A stable fingerprint of everything consent is granted against.
 *
 * Stable under key reordering because it walks a sorted, canonical form: two
 * scanners that observe the same capability must agree, and JSON key order is
 * not something either controls. Any change to a surface, a command, a hook or
 * an env key changes the hash, which is what makes "the manifest changed since
 * you approved it" answerable at all.
 *
 * FNV-1a rather than `node:crypto` because this module runs in the Convex V8
 * runtime, the Node daemon, the browser and Hermes at once, and only one of
 * those has `crypto.createHash`. It is not a security hash and must never be
 * used as one: it detects change, it does not resist an adversary choosing a
 * collision. Integrity against a hostile publisher is the pin's job (a git sha),
 * not this.
 */
export function manifestHash(manifest: CapabilityManifest | undefined): string {
  const canonical = canonicalize(manifest ?? {});
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    // The FNV prime, as shifts: `hash * 16777619` overflows 32 bits in JS.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * JSON with object keys sorted at every depth, so key order cannot change the
 * hash. Arrays keep their order: `["a","b"]` and `["b","a"]` are different
 * manifests — the order of a command's arguments is meaningful.
 *
 * A property that says nothing is dropped, so `undefined`, `null`, `[]` and `{}`
 * all mean what omitting the key means. Scanners disagree about which of those
 * they emit, and `deriveExecutionSurfaces` already reads them alike (it asks
 * `?.length`). A hash that split them would report two values for one unchanged
 * capability, and since consent is granted against the hash, the human would be
 * asked to approve a capability that did not change.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  // Elements are never dropped, only properties: an `mcp: [{}]` entry is a server
  // we observed and learned nothing about, and dropping it would shorten a list
  // whose length is meaningful.
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => [k, canonicalize(v)] as const)
    // Filtering the CANONICAL form rather than the raw value is what makes the
    // rule recursive: `components: { skill: [] }` collapses to `{}` here, then
    // vanishes with its parent. Emptiness cannot survive one level down.
    .filter(([, canonical]) => canonical !== "{}" && canonical !== "[]" && canonical !== "null")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, canonical]) => `${JSON.stringify(k)}:${canonical}`).join(",")}}`;
}

/**
 * The surfaces a capability really has, read off its structure.
 *
 * Derived, not accepted. A `declared` list from the publisher is folded in as an
 * ADDITIVE hint: it can add a surface we failed to observe, and it can never
 * remove one we did observe. That asymmetry is the whole point — a publisher who
 * omits `ships_bin` does not get a quieter badge, while one who volunteers a
 * surface we missed still helps.
 *
 * A manifest with nothing in it yields `[]`, which `requiresExplicitConsent`
 * treats as dangerous rather than benign. Nothing observed means nothing looked,
 * not nothing there.
 */
export function deriveExecutionSurfaces(
  manifest: CapabilityManifest | undefined,
  declared?: readonly ExecutionSurface[],
): ExecutionSurface[] {
  const found = new Set<ExecutionSurface>();
  if (manifest) {
    if (manifest.bin?.length) found.add("ships_bin");
    if (manifest.scripts?.length) found.add("ships_scripts");
    if (manifest.hooks?.length) found.add("declares_hooks");
    if (manifest.allowedTools?.length) found.add("declares_allowed_tools");
    for (const server of manifest.mcp ?? []) {
      if (server.command) found.add("mcp_stdio_command");
      if (server.url) found.add("mcp_remote_url");
    }
  }
  for (const surface of declared ?? []) {
    if (isExecutionSurface(surface)) found.add(surface);
  }
  // Emit in the canonical order so two equal sets are also equal arrays, which
  // keeps `manifestHash` and any equality check stable.
  return EXECUTION_SURFACES.filter((s) => found.has(s));
}
