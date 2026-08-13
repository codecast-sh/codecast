// The pure resolver: given every binding a person could have written and a
// description of where you are standing, what should this machine have?
//
// Three runtimes call this and must get the same answer from the same rows —
// the daemon reconciling disk, the browser previewing a change before it
// happens, and Convex telling a device what it should have. That is the whole
// reason it is pure: no filesystem, no fetch, no `Date.now()`, no randomness.
// The browser can therefore compute a dry run diff locally and instantly, and
// it is identical by construction to what the daemon will do — rather than
// being a second implementation that drifts.
//
// It answers exactly ONE question: which binding wins for each capability. The
// other gates in the design — consent, source pinning, source availability,
// whether a client can even express this kind — need the manifest hash, the
// device's consent rows, the local content store and the client registry. None
// of those are inputs here, so they layer on top of this result. Folding them
// in would make this function need a clock and a filesystem, and the identical
// answer property would go with them.

import {
  isScopeKind,
  isWellFormedCapabilitySlug,
  scopePrecedence,
  type BindingTrace,
  type CapabilityBinding,
  type DesiredState,
  type IgnoredBinding,
  type ResolvedCapability,
  type ScopeKind,
} from "./capabilities";

/**
 * Where you are standing. Every field is the identity of a scope instance, and
 * every one of them is stable across machines — no filesystem paths, because a
 * path is a property of one disk and a binding has to mean the same thing on
 * a laptop, a remote Mac and a fresh clone.
 *
 * An axis left undefined means "not in this context", and every binding at that
 * scope is set aside with a reason rather than silently dropped. That matters:
 * resolving for a device you have not identified must not quietly return the
 * user scope answer as if it were the whole truth.
 */
export interface ScopeContext {
  /** The person the machine belongs to. Required — a user scope binding for
   *  somebody else must never apply, however it arrived in the array. */
  userId: string;
  /** Teams this user is in. A team binding applies when its key is one of them. */
  teamIds?: readonly string[];
  deviceId?: string;
  /**
   * Every scope key that names THIS checkout. Usually one `git:<origin>` key,
   * two when the same checkout is also addressable as `local:<user>:<path>`.
   * Turning a path into a repo identity is the caller's job precisely because
   * it touches the filesystem.
   */
  projectKeys?: readonly string[];
  /** The conversation, for session scope. */
  conversationId?: string;
  /**
   * The agent client being resolved for, e.g. "claude". When omitted, a
   * `clientFilter` cannot be evaluated and is not applied — the caller is
   * asking for the union across clients, and filtering on a client nobody named
   * would silently hide bindings from a fleet-wide view.
   */
  client?: string;
}

/** A binding that survived validation, plus what it takes to order it. */
interface Candidate {
  binding: CapabilityBinding;
  scopeKind: ScopeKind;
  scopeKey: string;
  /** Position in the input array. The last tie break, so the comparator is
   *  total and the result never depends on whether the engine's sort is
   *  stable. */
  index: number;
}

function trace(candidate: Candidate): BindingTrace {
  const b = candidate.binding;
  return {
    bindingId: b.id,
    scopeKind: candidate.scopeKind,
    scopeKey: candidate.scopeKey,
    enabled: b.enabled,
    updatedAt: normalizeUpdatedAt(b.updatedAt),
    ...(b.teamId ? { teamId: b.teamId } : {}),
    ...(b.createdBy ? { createdBy: b.createdBy } : {}),
  };
}

/**
 * A non-finite timestamp poisons ordering: every comparison against NaN is
 * false, so the winner would depend on the sort algorithm's internals and two
 * runtimes could disagree. Treat it as the oldest possible value instead.
 */
function normalizeUpdatedAt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Authority order, most authoritative first.
 *
 * 1. Narrowest scope wins. An explicit disable at a narrower scope therefore
 *    beats an enable at a wider one automatically — the flag never enters the
 *    comparison, which is why "off" has to be a row rather than a deletion.
 * 2. Same scope: the more recent write wins.
 * 3. Same instant: the row id, ordered lexically.
 * 4. Same id: input position.
 *
 * TIES ARE IMPOSSIBLE BY CONSTRUCTION. Row ids are unique, so step 3 always
 * separates two distinct rows and steps 1 and 2 never have to be tie-broken by
 * anything a clock or an engine could vary. Step 4 exists only for the case
 * that should not happen — the same row handed in twice — and even then it
 * picks deterministically instead of leaving the answer to sort stability.
 */
function compareAuthority(a: Candidate, b: Candidate): number {
  const byScope = scopePrecedence(b.scopeKind) - scopePrecedence(a.scopeKind);
  if (byScope !== 0) return byScope;

  const byTime = normalizeUpdatedAt(b.binding.updatedAt) - normalizeUpdatedAt(a.binding.updatedAt);
  if (byTime !== 0) return byTime;

  if (a.binding.id !== b.binding.id) return a.binding.id < b.binding.id ? -1 : 1;
  return a.index - b.index;
}

/**
 * Does this binding's scope name somewhere we are?
 *
 * Returns null when it applies, or the phrase explaining why it does not. The
 * phrase is rendered to a person, so it names the missing thing rather than the
 * failed check.
 */
function scopeMismatch(candidate: Candidate, context: ScopeContext): string | null {
  const { scopeKind, scopeKey } = candidate;

  // Team is the one scope where the row's owner is not the person it lands on:
  // an admin writes it for the whole team. Every other scope names something
  // the person owns — their account, their machine, their checkout, their
  // conversation — so a row somebody else wrote must not apply here, whatever
  // key it carries and however it reached this array. Checking only the key
  // would let a stranger's row keyed to MY device tell my daemon to install
  // something.
  if (scopeKind !== "team" && candidate.binding.userId !== context.userId) {
    return "another person's binding";
  }

  switch (scopeKind) {
    case "team":
      if (!context.teamIds || context.teamIds.length === 0) return "not in any team here";
      return context.teamIds.includes(scopeKey) ? null : "another team";
    case "user":
      // Redundant with the owner check above now that the key is the owner for
      // every applicable row, and kept because the two guard different
      // mistakes: that one guards a leaked row, this one guards a row whose two
      // identity fields disagree.
      return scopeKey === context.userId ? null : "another user";
    case "device":
      if (!context.deviceId) return "no device in this context";
      return scopeKey === context.deviceId ? null : "another device";
    case "project":
      if (!context.projectKeys || context.projectKeys.length === 0) return "no project in this context";
      return context.projectKeys.includes(scopeKey) ? null : "another project";
    case "session":
      if (!context.conversationId) return "no session in this context";
      return scopeKey === context.conversationId ? null : "another session";
  }
}

/**
 * `config` holds Claude Code `userConfig` values, and those substitute into MCP
 * server configs and hook commands. Claude Code closed this exact hole in
 * v2.1.207 by reading plugin config only from the user's own settings, because
 * a cloned repository could otherwise inject values into commands that run.
 * Honouring a project, session or teammate's config would make us the
 * laundering service for the input Claude Code now refuses.
 *
 * So a config is usable only when the person who wrote the binding is the
 * person whose machine it lands on, at a scope that person controls directly.
 */
function configIsTrusted(binding: CapabilityBinding, scopeKind: ScopeKind, context: ScopeContext): boolean {
  if (scopeKind !== "user" && scopeKind !== "device") return false;
  return binding.userId === context.userId;
}

/**
 * What a row's `config` field actually holds.
 *
 * Three states rather than two, because "the field is not a config" and "this
 * is a config and one value is unreadable" want opposite answers. The first is
 * a client type error — a whole fleet's rows at once — so it reads as absent;
 * withholding on it would let one bad writer switch off every capability it
 * touched. The second is a person's own values with a hole in them, and
 * shipping half a config is exactly what the withhold exists to stop.
 */
type ConfigShape =
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "values"; values: Record<string, string> };

const NO_CONFIG: ConfigShape = { kind: "none" };

function readConfig(binding: CapabilityBinding): ConfigShape {
  const config: unknown = binding.config;
  // A string would pass a bare `Object.keys` length test and then spread into
  // `{0: "a", 1: "b"}` — a config nobody wrote, reaching a driver.
  if (typeof config !== "object" || config === null || Array.isArray(config)) return NO_CONFIG;
  const pairs = Object.entries(config as Record<string, unknown>);
  if (pairs.length === 0) return NO_CONFIG;
  if (!pairs.every(([, value]) => typeof value === "string")) return { kind: "malformed" };
  return { kind: "values", values: Object.fromEntries(pairs) as Record<string, string> };
}

/**
 * Reject a row we cannot reason about, naming the field. Returning a phrase
 * rather than throwing is deliberate: these rows come from other machines and
 * other client versions, and one bad row must cost one capability, not the
 * whole machine's capability set.
 */
function validationError(binding: CapabilityBinding): string | null {
  if (!binding || typeof binding !== "object") return "not an object";
  if (typeof binding.id !== "string" || binding.id.length === 0) return "no binding id";
  if (typeof binding.capabilitySlug !== "string" || binding.capabilitySlug.trim().length === 0) {
    return "no capability slug";
  }
  // The slug is a denormalized free string on the row, so this is the one gate
  // between a binding and a driver that will turn it into a directory name. The
  // grammar in `capabilities.ts` is what refuses `..`, control characters and
  // confusables; without this call none of it protects the path that matters.
  if (!isWellFormedCapabilitySlug(binding.capabilitySlug.trim())) {
    return `capability slug ${forDisplay(binding.capabilitySlug)} is not a valid reference`;
  }
  if (typeof binding.enabled !== "boolean") return "enabled is not a boolean";
  if (!isScopeKind(binding.scopeKind)) return `unknown scope "${String(binding.scopeKind)}"`;
  if (typeof binding.userId !== "string" || binding.userId.length === 0) return "no owner";
  if (binding.scopeKey !== undefined && typeof binding.scopeKey !== "string") {
    // Never fall through to the blank-key rule below with a non-string: a user
    // scope row keyed `42` would silently become a row for the owner.
    return "scope key is not a string";
  }
  if (effectiveScopeKey(binding).length === 0) return `no scope key for ${binding.scopeKind} scope`;
  // A team row says whose team it is twice, and the two must agree — the design
  // requires `team_id` on every team row and the server validates it there. A
  // row that disagrees with itself is not one to guess about. Absence is left
  // alone so rows written before that rule keep working.
  if (
    binding.scopeKind === "team" &&
    typeof binding.teamId === "string" &&
    binding.teamId.length > 0 &&
    binding.teamId !== effectiveScopeKey(binding)
  ) {
    return "team scope key does not match the row's team";
  }
  return null;
}

/**
 * Make an arbitrary string safe to put inside a phrase a person reads. A
 * rejected slug is attacker shaped by definition — it can carry newlines, a
 * terminal escape, or two hundred characters of noise.
 */
function forDisplay(raw: string): string {
  const printable = raw.replace(/[^\x20-\x7E]/g, "?");
  return `"${printable.length > 60 ? `${printable.slice(0, 59)}…` : printable}"`;
}

/**
 * A user scope row written with an empty key means "the owner of this row" —
 * older writers left it blank because the answer was obvious from `user_id`.
 * Filling it in here keeps those rows working instead of reporting them as
 * malformed, and every other scope still requires a real key.
 */
function effectiveScopeKey(binding: CapabilityBinding): string {
  const key = typeof binding.scopeKey === "string" ? binding.scopeKey.trim() : "";
  if (key.length > 0) return key;
  return binding.scopeKind === "user" ? binding.userId : "";
}

/**
 * Decide the values a capability launches with, from every applicable binding
 * rather than from the one that won the flag.
 *
 * Turning something on and configuring it are separate wishes, and they are
 * routinely written at different scopes: a person holds a token at user scope
 * and switches the capability on in one project. Claude Code models it the same
 * way — `pluginConfigs` is read from user settings no matter where the plugin
 * was enabled. Reading the config off the winning row alone would drop that
 * token the moment a narrower row decided the flag, and launch the server
 * without it.
 *
 * The trusted config wins wherever it sits, so a cloned repository can neither
 * supply values nor displace the ones I already hold. Only when every config on
 * offer is untrusted or unreadable is the entry withheld, and then for the
 * reason the narrowest offer failed.
 *
 * `candidates` is narrowest first, as `compareAuthority` left it.
 */
function applyConfig(
  entry: ResolvedCapability,
  candidates: readonly Candidate[],
  context: ScopeContext,
): void {
  let firstOffer: { candidate: Candidate; shape: ConfigShape } | undefined;

  for (const candidate of candidates) {
    const shape = readConfig(candidate.binding);
    if (shape.kind === "none") continue;
    if (!firstOffer) firstOffer = { candidate, shape };
    if (shape.kind === "values" && configIsTrusted(candidate.binding, candidate.scopeKind, context)) {
      entry.config = { ...shape.values };
      noteConfigSource(entry, candidate);
      return;
    }
  }

  if (!firstOffer) return;
  // Refusing the whole entry rather than stripping the config: a capability
  // whose MCP command interpolates `${user_config.KEY}` launches wrong without
  // it, and a half-configured server that starts is worse than one that does
  // not.
  entry.withheld = firstOffer.shape.kind === "malformed" ? "config_malformed" : "config_scope_not_trusted";
  noteConfigSource(entry, firstOffer.candidate);
}

/** `decidedBy` already names the winner, so only record the config's origin
 *  when it is somewhere else — the case a card cannot otherwise explain. */
function noteConfigSource(entry: ResolvedCapability, candidate: Candidate): void {
  if (candidate.binding.id !== entry.decidedBy.bindingId) entry.configFrom = trace(candidate);
}

/** The client filter is a whitelist. Empty or absent means every client. */
function clientExcluded(binding: CapabilityBinding, context: ScopeContext): boolean {
  const filter = binding.clientFilter;
  if (!Array.isArray(filter) || filter.length === 0) return false;
  if (!context.client) return false;
  return !filter.includes(context.client);
}

/**
 * Resolve every binding into what this machine should have.
 *
 * Total by design: it never throws, and every input row ends up either deciding
 * a capability, listed under the one that outranked it, or in `ignored` with a
 * reason. Nothing disappears silently, because "I turned it on and nothing
 * happened" is the failure this whole surface exists to prevent.
 */
export function resolveCapabilities(
  bindings: readonly CapabilityBinding[],
  context: ScopeContext,
): DesiredState {
  const ignored: IgnoredBinding[] = [];
  const bySlug = new Map<string, Candidate[]>();

  const rows = Array.isArray(bindings) ? bindings : [];

  for (let index = 0; index < rows.length; index++) {
    const binding = rows[index]!;

    const invalid = validationError(binding);
    if (invalid) {
      ignored.push({
        bindingId: typeof binding?.id === "string" ? binding.id : "",
        capabilitySlug: typeof binding?.capabilitySlug === "string" ? binding.capabilitySlug : "",
        scopeKind: String(binding?.scopeKind ?? ""),
        scopeKey: typeof binding?.scopeKey === "string" ? binding.scopeKey : "",
        reason: "malformed_binding",
        detail: invalid,
      });
      continue;
    }

    const candidate: Candidate = {
      binding,
      scopeKind: binding.scopeKind,
      scopeKey: effectiveScopeKey(binding),
      index,
    };

    const mismatch = scopeMismatch(candidate, context);
    if (mismatch) {
      ignored.push({
        bindingId: binding.id,
        capabilitySlug: binding.capabilitySlug,
        scopeKind: candidate.scopeKind,
        scopeKey: candidate.scopeKey,
        reason: "scope_not_in_context",
        detail: mismatch,
      });
      continue;
    }

    if (clientExcluded(binding, context)) {
      ignored.push({
        bindingId: binding.id,
        capabilitySlug: binding.capabilitySlug,
        scopeKind: candidate.scopeKind,
        scopeKey: candidate.scopeKey,
        reason: "client_filtered",
        detail: `bound to ${binding.clientFilter!.join(", ")}`,
      });
      continue;
    }

    const slug = binding.capabilitySlug.trim();
    const list = bySlug.get(slug);
    if (list) list.push(candidate);
    else bySlug.set(slug, [candidate]);
  }

  const entries: ResolvedCapability[] = [];
  for (const [slug, candidates] of bySlug) {
    const ordered = [...candidates].sort(compareAuthority);
    const winner = ordered[0]!;
    const binding = winner.binding;

    const entry: ResolvedCapability = {
      slug,
      enabled: binding.enabled,
      decidedBy: trace(winner),
      overrode: ordered.slice(1).map(trace),
    };

    if (binding.enabled) applyConfig(entry, ordered, context);

    entries.push(entry);
  }

  entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  ignored.sort((a, b) => {
    if (a.capabilitySlug !== b.capabilitySlug) return a.capabilitySlug < b.capabilitySlug ? -1 : 1;
    return a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0;
  });

  return { entries, ignored };
}

/* --------------------------------------------------------------------------
 * Reading the result
 * -------------------------------------------------------------------------- */

/** The capabilities a driver should actually materialize here. */
export function desiredCapabilities(state: DesiredState): ResolvedCapability[] {
  return state.entries.filter((e) => e.enabled && !e.withheld);
}

/** Just the slugs, for a set comparison against what a machine reports. */
export function desiredCapabilitySlugs(state: DesiredState): string[] {
  return desiredCapabilities(state).map((e) => e.slug);
}

/** One capability's full story — the winning binding, and everything it beat. */
export function findResolved(state: DesiredState, slug: string): ResolvedCapability | undefined {
  return state.entries.find((e) => e.slug === slug);
}

/**
 * Everything the resolver knows about one slug, including the bindings that
 * never entered the contest. This is the "why is this active?" view's query:
 * one call, one slug, both halves of the answer.
 */
export function explainCapability(
  state: DesiredState,
  slug: string,
): { resolved?: ResolvedCapability; ignored: IgnoredBinding[] } {
  return {
    resolved: findResolved(state, slug),
    ignored: state.ignored.filter((i) => i.capabilitySlug === slug),
  };
}
