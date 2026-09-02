// Adapter for posthog-react-native. Structural type so the SDK stays an
// optional peer: pass the PostHog client instance.
import { type FlagsClient, splitFlagValue } from "./types";

export interface PostHogReactNativeLike {
  getFeatureFlag: (key: string) => boolean | string | undefined;
  getFeatureFlagPayload: (key: string) => unknown;
  reloadFeatureFlagsAsync: () => Promise<unknown>;
}

export function fromPostHogReactNative(client: PostHogReactNativeLike): FlagsClient {
  return {
    getFlag: (key) => splitFlagValue(client.getFeatureFlag(key)).enabled,
    getPayload: <T,>(key: string) => client.getFeatureFlagPayload(key) as T | undefined,
    getVariant: (key) => splitFlagValue(client.getFeatureFlag(key)).variant,
    reload: async () => {
      await client.reloadFeatureFlagsAsync();
    },
  };
}
