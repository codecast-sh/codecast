// Server enforced feature gates. A gate is a named switch stored per scope
// (a team, a workspace, an account). The stored bag holds only the flags that
// were ever set; an absent flag reads as the catalog default, which is off
// unless the descriptor says otherwise.
//
// One catalog, so the settings toggle, the server guard, the client gate and
// any fan out (codecast's agent snippets) can never disagree about which gates
// exist. Pure data and pure functions: no Node, no DOM, no network.

export interface FeatureDescriptor<K extends string = string> {
  key: K;
  /** Human label on the settings toggle. */
  name: string;
  /** One line under the toggle: what turning it on gives the scope. */
  desc: string;
  /** Value when the scope never set the flag. Default false. */
  defaultOn?: boolean;
}

/** The stored shape on a scope row: only flags that were ever set. */
export type StoredFlags<K extends string = string> = Partial<Record<K, boolean>>;

/** Anything that carries a flags bag, or nothing at all. */
export type FlagHolder<K extends string = string> =
  | { features?: StoredFlags<K> | null }
  | null
  | undefined;

export interface FeatureCatalog<K extends string, D extends FeatureDescriptor<K>> {
  features: readonly D[];
  keys: readonly K[];
  byKey: (key: K) => D | undefined;
  /** Human name for `key`, or the key itself when unknown. */
  nameOf: (key: K) => string;
  isKey: (value: unknown) => value is K;
}

/** Build a catalog. Duplicate keys throw at definition time. Extra fields on
 *  a descriptor (codecast's `snippets`) are kept and typed. */
export function defineFeatures<const D extends FeatureDescriptor<string>>(
  features: readonly D[],
): FeatureCatalog<D["key"], D> {
  type K = D["key"];
  const keys = features.map((f) => f.key) as K[];
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) throw new Error(`Duplicate feature key: ${k}`);
    seen.add(k);
  }
  const map = new Map<string, D>(features.map((f) => [f.key, f]));
  return {
    features,
    keys,
    byKey: (key) => map.get(key),
    nameOf: (key) => map.get(key)?.name ?? key,
    isKey: (value): value is K => typeof value === "string" && map.has(value),
  };
}

/** Is `key` on in this stored bag? Absent flag: catalog default. Absent bag:
 *  catalog default. Unknown key: off. */
export function isEnabled<K extends string>(
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>,
  stored: StoredFlags<K> | null | undefined,
  key: K,
): boolean {
  const desc = catalog.byKey(key);
  if (!desc) return false;
  const value = stored?.[key];
  if (typeof value === "boolean") return value;
  return desc.defaultOn === true;
}

/** Same as `isEnabled`, for a row that carries a `features` bag. */
export function holderHasFeature<K extends string>(
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>,
  holder: FlagHolder<K>,
  key: K,
): boolean {
  return isEnabled(catalog, holder?.features, key);
}

/** Is `key` on for at least one of `holders`? */
export function anyHolderHasFeature<K extends string>(
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>,
  holders: ReadonlyArray<FlagHolder<K>>,
  key: K,
): boolean {
  return holders.some((h) => holderHasFeature(catalog, h, key));
}

/** A new bag with `key` set. Never mutates the input. */
export function withFlag<K extends string>(
  stored: StoredFlags<K> | null | undefined,
  key: K,
  enabled: boolean,
): StoredFlags<K> {
  return { ...(stored ?? {}), [key]: enabled } as StoredFlags<K>;
}

/**
 * Fan out: for every item some feature attaches (codecast's agent snippets),
 * whether at least one holder has that feature on. Items no feature attaches
 * are not listed. `attached` picks the item list off a descriptor.
 */
export function attachedAvailability<K extends string, D extends FeatureDescriptor<K>>(
  catalog: FeatureCatalog<K, D>,
  holders: ReadonlyArray<FlagHolder<K>>,
  attached: (feature: D) => readonly string[] | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const feature of catalog.features) {
    const on = anyHolderHasFeature(catalog, holders, feature.key);
    for (const item of attached(feature) ?? []) out[item] = (out[item] ?? false) || on;
  }
  return out;
}

/** Every feature that attaches `item`. */
export function featuresAttaching<K extends string, D extends FeatureDescriptor<K>>(
  catalog: FeatureCatalog<K, D>,
  item: string,
  attached: (feature: D) => readonly string[] | undefined,
): D[] {
  return catalog.features.filter((f) => (attached(f) ?? []).includes(item));
}

/** Is `item` gated, and if so does some holder unlock it? Ungated: always. */
export function attachedItemAvailable<K extends string, D extends FeatureDescriptor<K>>(
  catalog: FeatureCatalog<K, D>,
  item: string,
  holders: ReadonlyArray<FlagHolder<K>>,
  attached: (feature: D) => readonly string[] | undefined,
): boolean {
  const gates = featuresAttaching(catalog, item, attached);
  if (gates.length === 0) return true;
  return gates.some((f) => anyHolderHasFeature(catalog, holders, f.key));
}

// ── wording ──────────────────────────────────────────────────────────────────

/** What the scope is called in messages. Codecast: team, Settings → Team. */
export interface ScopeWording {
  /** Noun for the scope: "team", "workspace". */
  noun: string;
  /** Where the toggle lives: "Settings → Team". */
  settingsPath: string;
}

export const TEAM_WORDING: ScopeWording = { noun: "team", settingsPath: "Settings → Team" };

/** The message a caller sees when a feature is off. The same words on the
 *  CLI, the web and mobile, and it says who can fix it. */
export function featureOffMessage<K extends string>(
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>,
  key: K,
  wording: ScopeWording = TEAM_WORDING,
): string {
  return `${catalog.nameOf(key)} is not enabled for this ${wording.noun}. A ${wording.noun} admin can turn it on under ${wording.settingsPath}.`;
}

/** Copy for the honest landing page of an off feature. Headless; the app
 *  renders it (codecast's TeamFeatureOff). */
export function featureOffCopy<K extends string>(
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>,
  key: K,
  isAdmin: boolean,
  wording: ScopeWording = TEAM_WORDING,
): { title: string; desc: string; hint: string; canToggle: boolean } {
  const desc = catalog.byKey(key);
  return {
    title: `${catalog.nameOf(key)} is off for this ${wording.noun}.`,
    desc: desc?.desc ?? "",
    hint: isAdmin
      ? `Turn it on in ${wording.noun} settings`
      : `A ${wording.noun} admin can turn it on under ${wording.settingsPath}.`,
    canToggle: isAdmin,
  };
}
