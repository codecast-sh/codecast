// Adapter for posthog-js (web). Structural type so posthog-js stays an
// optional peer: pass the initialized `posthog` object.
import { type FlagsClient, splitFlagValue } from "./types";

export interface PostHogJsLike {
  getFeatureFlag: (key: string) => boolean | string | undefined;
  getFeatureFlagPayload: (key: string) => unknown;
  reloadFeatureFlags: () => void;
  onFeatureFlags?: (cb: () => void) => unknown;
}

export function fromPostHogJs(posthog: PostHogJsLike): FlagsClient {
  return {
    getFlag: (key) => splitFlagValue(posthog.getFeatureFlag(key)).enabled,
    getPayload: <T,>(key: string) => posthog.getFeatureFlagPayload(key) as T | undefined,
    getVariant: (key) => splitFlagValue(posthog.getFeatureFlag(key)).variant,
    reload: () =>
      new Promise<void>((resolve) => {
        if (posthog.onFeatureFlags) {
          let done = false;
          const unsub = posthog.onFeatureFlags(() => {
            if (done) return;
            done = true;
            if (typeof unsub === "function") unsub();
            resolve();
          });
          posthog.reloadFeatureFlags();
        } else {
          posthog.reloadFeatureFlags();
          resolve();
        }
      }),
  };
}
