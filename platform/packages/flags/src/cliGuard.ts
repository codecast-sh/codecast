// CLI side of a gate. A command for an off feature stops with the same words
// the server would use, instead of answering with an empty list that reads as
// "nothing happened yet". Writer and exit are injected so the helper is
// testable and mountable in any CLI.
import {
  type FeatureCatalog,
  type FeatureDescriptor,
  type ScopeWording,
  TEAM_WORDING,
  featureOffMessage,
} from "./catalog";

export interface RefusalInput {
  /** The command ran inside a scope of the right kind (a team). When false
   *  the caller is in a personal workspace and must pick one. */
  scoped: boolean;
  /** How to pick a scope, shown when `scoped` is false.
   *  Codecast: "--team <name|id> (cast chat channels --team lists yours)". */
  pickHint?: string;
}

/** The refusal line for an off or unscoped feature. */
export function featureRefusalMessage<K extends string>(
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>,
  key: K,
  input: RefusalInput,
  wording: ScopeWording = TEAM_WORDING,
): string {
  if (input.scoped) return featureOffMessage(catalog, key, wording);
  const pick = input.pickHint ? ` ${input.pickHint}` : "";
  return `${catalog.nameOf(key)} is a ${wording.noun} feature — pick a ${wording.noun} with${pick || ` --${wording.noun} <name|id>`}.`;
}

export interface RequireFeatureCliOptions<K extends string> {
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>;
  /** Is `key` on for the current scope? */
  enabled: (key: K) => boolean | Promise<boolean>;
  /** Whether the caller is inside a scope at all. */
  scoped: () => boolean;
  pickHint?: string;
  wording?: ScopeWording;
  writeError: (line: string) => void;
  exit: (code: number) => never;
}

/** Returns normally when `key` is on; otherwise writes the refusal and exits 1. */
export async function requireFeatureOrExit<K extends string>(
  opts: RequireFeatureCliOptions<K>,
  key: K,
): Promise<void> {
  const scoped = opts.scoped();
  if (scoped && (await opts.enabled(key))) return;
  opts.writeError(
    featureRefusalMessage(opts.catalog, key, { scoped, pickHint: opts.pickHint }, opts.wording),
  );
  opts.exit(1);
}
