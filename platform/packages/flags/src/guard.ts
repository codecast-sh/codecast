// The server half: a guard every feature chokepoint calls, and the admin
// toggle. The app supplies how a scope's flags are loaded and stored; this
// module supplies the rule and the wording.
import {
  type FeatureCatalog,
  type FeatureDescriptor,
  type ScopeWording,
  type StoredFlags,
  TEAM_WORDING,
  featureOffMessage,
  isEnabled,
  withFlag,
} from "./catalog";

export type Fail = (message: string) => never;
const throwError: Fail = (m) => {
  throw new Error(m);
};

export interface FeatureGuardOptions<K extends string, Scope> {
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>;
  /** Load the stored flags of one scope. Missing scope: null. */
  loadFlags: (scope: Scope) => Promise<StoredFlags<K> | null | undefined>;
  wording?: ScopeWording;
}

export interface FeatureGuard<K extends string, Scope> {
  /** Is `key` on for `scope`? Missing scope: off. */
  has: (scope: Scope | null | undefined, key: K) => Promise<boolean>;
  /** Throws with the shared message unless `key` is on for `scope`. `fail`
   *  lets a module raise its own error class while keeping one wording. */
  require: (scope: Scope | null | undefined, key: K, fail?: Fail) => Promise<void>;
  offMessage: (key: K) => string;
}

export function createFeatureGuard<K extends string, Scope>(
  opts: FeatureGuardOptions<K, Scope>,
): FeatureGuard<K, Scope> {
  const wording = opts.wording ?? TEAM_WORDING;
  const has: FeatureGuard<K, Scope>["has"] = async (scope, key) => {
    if (scope === null || scope === undefined) return false;
    return isEnabled(opts.catalog, await opts.loadFlags(scope), key);
  };
  return {
    has,
    require: async (scope, key, fail = throwError) => {
      if (!(await has(scope, key))) fail(featureOffMessage(opts.catalog, key, wording));
    },
    offMessage: (key) => featureOffMessage(opts.catalog, key, wording),
  };
}

export interface SetFeatureInput<K extends string> {
  /** The caller is an admin of the scope. */
  isAdmin: boolean;
  /** Current stored bag; null when the scope row is missing. */
  current: StoredFlags<K> | null | undefined;
  /** False when the scope row does not exist. Default true. */
  scopeExists?: boolean;
  key: unknown;
  enabled: boolean;
}

/**
 * The admin toggle, as a pure decision. Returns the new bag to persist or
 * throws with codecast's wording. The app wraps it in its mutation: resolve
 * the caller's role, load the row, call this, patch the row.
 */
export function applyFeatureChange<K extends string>(
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>,
  input: SetFeatureInput<K>,
  wording: ScopeWording = TEAM_WORDING,
  fail: Fail = throwError,
): StoredFlags<K> {
  if (!input.isAdmin) fail(`Only admins can change ${wording.noun} features`);
  if (input.scopeExists === false) fail(`${capitalize(wording.noun)} not found`);
  if (!catalog.isKey(input.key)) fail(`Unknown feature: ${String(input.key)}`);
  return withFlag(input.current, input.key as K, input.enabled);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
