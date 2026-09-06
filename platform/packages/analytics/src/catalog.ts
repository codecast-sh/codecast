// The track boundary: a typed event catalog, the runtime check that enforces
// it, the per-session burst cap, and the opt-out resolver.
//
// Why a catalog at all. `track(event: string, props: Record<string, unknown>)`
// accepts anything, so a typo mints a new PostHog event nobody queries, a
// renamed property silently splits a funnel, and a stray field can carry user
// text (a prompt, a path, an email) into the analytics store. The catalog names
// every event once; the validator drops anything that does not match it.
//
// No zod. The apps that consume this package do not depend on zod, and the
// shapes here are flat enough that a hand written check is shorter than the
// dependency. `defineCatalog` keeps the literal types, so the same declaration
// gives call sites their compile time signature and the validator its rules.
//
// Fail closed everywhere: an event that fails any check is DROPPED, never sent
// with the bad part removed. A partially valid event is worse than no event —
// it looks like real data.

export type PropSpec =
  | { type: "string"; max?: number; values?: readonly string[]; optional?: boolean }
  | { type: "number"; optional?: boolean }
  | { type: "boolean"; optional?: boolean }
  | { type: "counters"; maxKeys?: number; optional?: boolean };

export type EventSpec = Readonly<Record<string, PropSpec>>;
export type EventCatalog = Readonly<Record<string, EventSpec>>;

/** Cap applied to a free-form string property that declares no `max`. */
export const DEFAULT_STRING_MAX = 200;
/** Key cap applied to a `counters` bag that declares no `maxKeys`. */
export const DEFAULT_COUNTER_KEYS = 32;
/**
 * Events one session may transmit. A runaway effect or a loop that tracks per
 * render can otherwise emit thousands of events per minute: the cost lands on
 * the PostHog ingest bill, and the flood buries the events anyone reads.
 */
export const SESSION_EVENT_CAP = 1000;

type PropValue<S extends PropSpec> = S extends { type: "string"; values: readonly (infer V)[] }
  ? V
  : S extends { type: "string" }
    ? string
    : S extends { type: "number" }
      ? number
      : S extends { type: "boolean" }
        ? boolean
        : S extends { type: "counters" }
          ? Record<string, number>
          : never;

type RequiredKeys<E extends EventSpec> = {
  [K in keyof E]: E[K] extends { optional: true } ? never : K;
}[keyof E];

/** The properties one catalog event accepts, as a compile time object type. */
export type EventProps<E extends EventSpec> = {
  [K in RequiredKeys<E>]: PropValue<E[K]>;
} & {
  [K in Exclude<keyof E, RequiredKeys<E>>]?: PropValue<E[K]>;
};

/** Every event name in a catalog. */
export type EventName<C extends EventCatalog> = keyof C & string;

/**
 * Identity, but with `const` inference so `values: ["a", "b"]` stays the union
 * `"a" | "b"` instead of widening to `string`. Declare a catalog through this
 * and the call sites get the narrow types for free.
 */
export function defineCatalog<const C extends EventCatalog>(catalog: C): C {
  return catalog;
}

export type ValidationResult =
  // `properties` comes back exactly as it went in, undefined included: the
  // check never rewrites a payload, so what a caller sends is what it wrote.
  | { ok: true; properties: Record<string, unknown> | undefined }
  | { ok: false; reason: string };

const hasOwn = (target: object, key: string) => Object.prototype.hasOwnProperty.call(target, key);

function checkProp(key: string, spec: PropSpec, value: unknown): string | null {
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") return `${key}: expected a string`;
      if (spec.values && !spec.values.includes(value)) {
        return `${key}: ${JSON.stringify(value)} is not one of ${spec.values.join(", ")}`;
      }
      const max = spec.max ?? DEFAULT_STRING_MAX;
      if (value.length > max) return `${key}: string longer than ${max}`;
      return null;
    }
    case "number":
      // NaN and Infinity serialize to null in JSON, so a chart built on them
      // reads as missing data rather than as the bug that produced them.
      return typeof value === "number" && Number.isFinite(value) ? null : `${key}: expected a finite number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${key}: expected a boolean`;
    case "counters": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${key}: expected an object of counters`;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      const maxKeys = spec.maxKeys ?? DEFAULT_COUNTER_KEYS;
      if (entries.length > maxKeys) return `${key}: more than ${maxKeys} counter keys`;
      for (const [k, v] of entries) {
        if (typeof v !== "number" || !Number.isFinite(v)) return `${key}.${k}: expected a finite number`;
      }
      return null;
    }
  }
}

/**
 * Check one event against the catalog. Unknown event name, unknown property
 * key, missing required key, wrong type, value outside a declared enum, or a
 * string over its cap all fail.
 */
export function validateEvent(
  catalog: EventCatalog,
  name: string,
  properties?: Record<string, unknown>,
): ValidationResult {
  // An own-property check, not `in`: a caller controlled name must not match
  // "constructor" or "toString" off the prototype chain. hasOwnProperty.call
  // rather than Object.hasOwn, whose lib the Convex tsconfig does not include.
  if (!hasOwn(catalog, name)) return { ok: false, reason: `unknown event: ${name}` };
  const spec = catalog[name]!;
  const props = properties ?? {};
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    return { ok: false, reason: `${name}: properties must be an object` };
  }

  for (const key of Object.keys(props)) {
    if (!hasOwn(spec, key)) return { ok: false, reason: `${name}: unknown property ${key}` };
  }
  for (const [key, propSpec] of Object.entries(spec)) {
    const value = props[key];
    if (value === undefined) {
      if (propSpec.optional) continue;
      return { ok: false, reason: `${name}: missing ${key}` };
    }
    const problem = checkProp(key, propSpec, value);
    if (problem) return { ok: false, reason: `${name}: ${problem}` };
  }
  return { ok: true, properties };
}

export type OptOutReason = "do_not_track" | "ci";

/** Vars whose VALUE is a flag: only "1" or "true" counts as set. */
export const CI_FLAG_VARS = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "TRAVIS", "BUILDKITE"] as const;
/** Vars whose PRESENCE is the signal; their values are URLs and versions. */
export const CI_PRESENCE_VARS = ["JENKINS_URL", "TEAMCITY_VERSION", "GITHUB_WORKFLOW"] as const;

function isFlagSet(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export interface OptOutSignals {
  /** Process environment. Node surfaces pass process.env; browsers pass nothing. */
  env?: Record<string, string | undefined>;
  /** Browser Do Not Track. The caller reads navigator, so this module stays DOM free. */
  doNotTrack?: boolean;
  /** Extra env var names that disable telemetry, for an app specific kill switch. */
  extraVars?: readonly string[];
}

/**
 * Who must not be measured: a user who asked not to be (DO_NOT_TRACK, the
 * community standard kill switch), and a machine running the test suite, whose
 * events are indistinguishable from real usage once they are in the project.
 */
export function resolveOptOut(signals: OptOutSignals = {}): { optedOut: boolean; reason: OptOutReason | null } {
  const env = signals.env ?? {};
  if (signals.doNotTrack || isFlagSet(env.DO_NOT_TRACK)) return { optedOut: true, reason: "do_not_track" };
  for (const name of signals.extraVars ?? []) {
    if (isFlagSet(env[name])) return { optedOut: true, reason: "do_not_track" };
  }
  for (const name of CI_FLAG_VARS) if (isFlagSet(env[name])) return { optedOut: true, reason: "ci" };
  for (const name of CI_PRESENCE_VARS) if (env[name]) return { optedOut: true, reason: "ci" };
  return { optedOut: false, reason: null };
}

export interface TrackGateOptions {
  /** Omit to accept any event name and shape, which is what callers had before. */
  catalog?: EventCatalog;
  /** Per-session ceiling. Defaults to SESSION_EVENT_CAP. */
  sessionCap?: number;
  /** Nothing passes when true. */
  optedOut?: boolean;
  /** Where a drop is reported. Defaults to console.warn. Messages carry their own prefix. */
  warn?: (message: string) => void;
}

export interface TrackGate {
  /** Ok means send it; the properties come back so a caller sends the checked object. */
  check(name: string, properties?: Record<string, unknown>): ValidationResult;
  /** Events allowed so far this session. */
  readonly sent: number;
  /** Start a new session: clears the count and the warn dedupe. */
  reset(): void;
}

const WARN_WINDOW_MS = 60_000;
const WARN_KEYS_MAX = 64;

/**
 * The single point every track call passes through. Order is deliberate:
 *
 *  1. Opt out — one boolean, and nothing after it can matter.
 *  2. Burst cap — O(1), so a runaway loop past the cap costs nothing per call.
 *  3. Catalog check — the only step that walks the payload.
 *
 * A drop warns at most once per reason per minute. A bad caller must not be
 * able to flood stderr, which is a second way to take a process down.
 */
export function createTrackGate(options: TrackGateOptions = {}): TrackGate {
  const cap = options.sessionCap ?? SESSION_EVENT_CAP;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const lastWarnAt = new Map<string, number>();
  let sent = 0;
  let capWarned = false;

  function warnOnce(key: string, message: string) {
    const now = Date.now();
    for (const [k, at] of lastWarnAt) if (now - at >= WARN_WINDOW_MS) lastWarnAt.delete(k);
    if (lastWarnAt.size >= WARN_KEYS_MAX) {
      const oldest = lastWarnAt.keys().next();
      if (!oldest.done) lastWarnAt.delete(oldest.value);
    }
    const previous = lastWarnAt.get(key);
    if (previous !== undefined && now - previous < WARN_WINDOW_MS) return;
    lastWarnAt.set(key, now);
    warn(message);
  }

  return {
    get sent() {
      return sent;
    },
    check(name, properties) {
      if (options.optedOut) return { ok: false, reason: "opted out" };
      if (sent >= cap) {
        if (!capWarned) {
          capWarned = true;
          warn(`[analytics] session event cap (${cap}) reached; dropping the rest of this session`);
        }
        return { ok: false, reason: `session event cap (${cap}) reached` };
      }
      const result = options.catalog
        ? validateEvent(options.catalog, name, properties)
        : ({ ok: true, properties } as ValidationResult);
      if (!result.ok) {
        warnOnce(name, `[analytics] dropped: ${result.reason}`);
        return result;
      }
      sent++;
      return result;
    },
    reset() {
      sent = 0;
      capWarned = false;
      lastWarnAt.clear();
    },
  };
}
