// React hooks for the catalog half. The app injects one hook that returns the
// current flag source (the active scope's bag and every scope's bag), and
// gets back the three hooks codecast's web and mobile use. No React import is
// needed: the injected source is the hook, these are selectors over it.
import {
  type FeatureCatalog,
  type FeatureDescriptor,
  type FlagHolder,
  anyHolderHasFeature,
  holderHasFeature,
} from "./catalog";

export interface FeatureSource<K extends string> {
  /** The active scope (team), or null in a personal workspace. */
  active: FlagHolder<K>;
  /** Every scope the viewer belongs to. */
  all: ReadonlyArray<FlagHolder<K>>;
}

export interface FeatureHooks<K extends string> {
  /** Is `key` on for the active scope? Personal workspace, or still loading: off. */
  useFeature: (key: K) => boolean;
  /** Is `key` on for any scope? For surfaces that span scopes. */
  useAnyFeature: (key: K) => boolean;
  /** true/false once loaded; undefined while the source is unknown. */
  useFeatureState: (key: K) => boolean | undefined;
}

export function createFeatureHooks<K extends string>(
  catalog: FeatureCatalog<K, FeatureDescriptor<K>>,
  useSource: () => FeatureSource<K> | undefined,
): FeatureHooks<K> {
  return {
    useFeature: (key) => {
      const src = useSource();
      return src ? holderHasFeature(catalog, src.active, key) : false;
    },
    useAnyFeature: (key) => {
      const src = useSource();
      return src ? anyHolderHasFeature(catalog, src.all, key) : false;
    },
    useFeatureState: (key) => {
      const src = useSource();
      return src ? holderHasFeature(catalog, src.active, key) : undefined;
    },
  };
}
