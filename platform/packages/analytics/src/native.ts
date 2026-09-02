// React Native analytics: PostHog (posthog-react-native) plus Sentry
// (@sentry/react-native). Lifted from codecast packages/mobile/lib/analytics.ts.
//
// Sentry and PostHog are NATIVE modules. An OTA ships JS only and can land on a
// binary built before these deps were added, where a static `import` resolves
// the native module at module eval and throws "Cannot find native module". That
// crashes the app on every launch before expo-updates can mark it launched, so
// it auto rolls back. So require them lazily and degrade to no-ops when the
// native module is absent; telemetry resumes once users get a build that
// bundles them.

import { resolveConfig, superProperties, type AnalyticsConfig, type ResolvedAnalyticsConfig } from "./index";

let Sentry: typeof import("@sentry/react-native") | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Sentry = require("@sentry/react-native");
} catch {
  Sentry = null;
}

type PostHogCtorT = typeof import("posthog-react-native").default;
let PostHogCtor: PostHogCtorT | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const m = require("posthog-react-native");
  PostHogCtor = (m && (m.default ?? m)) || null;
} catch {
  PostHogCtor = null;
}

let config: ResolvedAnalyticsConfig | null = null;

export let posthog: InstanceType<PostHogCtorT> | null = null;

export interface NativeAnalyticsConfig extends AnalyticsConfig {
  /**
   * Session replay needs the posthog-react-native-session-replay NATIVE module,
   * so it only takes effect on binaries built with it. The SDK guards its own
   * require, so an OTA landing on an older binary degrades to no replay.
   * Defaults to true (codecast's setting).
   */
  enableSessionReplay?: boolean;
}

/** Call after first mount, never at module eval (see header comment). */
export function initAnalytics(input: NativeAnalyticsConfig) {
  config = resolveConfig(input);
  const isDev = config.environment === "development";
  const enableSessionReplay = input.enableSessionReplay ?? true;

  if (config.sentryDsn && Sentry) {
    try {
      Sentry.init({
        dsn: config.sentryDsn,
        environment: config.environment,
        enabled: !isDev,
        tracesSampleRate: isDev ? 1.0 : 0.2,
        initialScope: {
          tags: { platform: config.platform, ...(config.appName ? { app: config.appName } : {}) },
        },
      });
    } catch {
      // native module absent or init failed: analytics stay off this launch
    }
  }

  if (config.posthogKey && PostHogCtor) {
    try {
      posthog = new PostHogCtor(config.posthogKey, {
        host: config.posthogHost,
        disabled: isDev,
        // Application Opened / Backgrounded / Updated events.
        captureAppLifecycleEvents: true,
        enableSessionReplay,
        sessionReplayConfig: {
          // Text inputs can hold prompts and pasted secrets; images are often
          // the content itself, so masking them would blank replays.
          maskAllTextInputs: true,
          maskAllImages: false,
          captureLog: true,
          captureNetworkTelemetry: true,
        },
      });
      posthog.register(superProperties(config));
    } catch {
      posthog = null;
    }
  }
}

/** distinct_id convention: pass the app's own user id (codecast: Convex users._id). */
export function identifyUser(userId: string, traits?: Record<string, string | number | boolean | null>) {
  if (config?.sentryDsn && Sentry) {
    Sentry.setUser({ id: userId, ...traits });
  }
  posthog?.identify(userId, traits ?? undefined);
}

export function resetUser() {
  if (config?.sentryDsn && Sentry) {
    Sentry.setUser(null);
  }
  posthog?.reset();
}

export function track(event: string, properties?: Record<string, string | number | boolean>) {
  posthog?.capture(event, properties);
}

// Screen views. posthog-react-native has no router integration of its own, so
// the root layout feeds it every expo-router pathname change.
export function trackScreen(name: string, properties?: Record<string, string | number | boolean>) {
  posthog?.screen(name, properties);
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  if (config?.sentryDsn && Sentry) {
    Sentry.captureException(error, { extra: context });
  }
}

// Wrap the root component with Sentry's error boundary and instrumentation
// when the native module is present; otherwise return it unchanged so an OTA
// cannot crash a binary that lacks Sentry.
export function wrapRoot<T>(Component: T): T {
  try {
    return Sentry && typeof Sentry.wrap === "function" ? (Sentry.wrap(Component as any) as T) : Component;
  } catch {
    return Component;
  }
}

export { Sentry };
