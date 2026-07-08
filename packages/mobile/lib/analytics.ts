// Sentry and PostHog are NATIVE modules. An OTA ships JS only and can land on a
// binary built before these deps were added (the 1.0.2 App Store build predates
// them — they were added 2026-03), where a static `import` resolves the native
// module at module-eval and throws "Cannot find native module" — crashing the app
// on every launch before expo-updates can mark it launched, so it auto-rolls back.
// So require them lazily and degrade to no-ops when the native module is absent;
// telemetry resumes once users get a build that bundles them. Mirrors the guarded
// expo-sqlite / expo-clipboard requires elsewhere in the app.

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

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
const POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";
const IS_DEV = __DEV__;

export let posthog: InstanceType<PostHogCtorT> | null = null;

export function initAnalytics() {
  if (SENTRY_DSN && Sentry) {
    try {
      Sentry.init({
        dsn: SENTRY_DSN,
        environment: IS_DEV ? "development" : "production",
        enabled: !IS_DEV,
        tracesSampleRate: IS_DEV ? 1.0 : 0.2,
        initialScope: {
          tags: { platform: "mobile" },
        },
      });
    } catch {
      // native module absent or init failed — analytics stay off this launch
    }
  }

  if (POSTHOG_KEY && PostHogCtor) {
    try {
      posthog = new PostHogCtor(POSTHOG_KEY, {
        host: POSTHOG_HOST,
        disabled: IS_DEV,
      });
      posthog.register({ platform: "mobile" });
    } catch {
      posthog = null;
    }
  }
}

export function identifyUser(userId: string, traits?: Record<string, string | number | boolean | null>) {
  if (SENTRY_DSN && Sentry) {
    Sentry.setUser({ id: userId, ...traits });
  }
  posthog?.identify(userId, traits ?? undefined);
}

export function resetUser() {
  if (SENTRY_DSN && Sentry) {
    Sentry.setUser(null);
  }
  posthog?.reset();
}

export function track(event: string, properties?: Record<string, string | number | boolean>) {
  posthog?.capture(event, properties);
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  if (SENTRY_DSN && Sentry) {
    Sentry.captureException(error, { extra: context });
  }
}

// Wrap the root component with Sentry's error boundary / instrumentation when the
// native module is present; otherwise return it unchanged so an OTA can't crash a
// binary that lacks Sentry. Replaces a bare `Sentry.wrap(RootLayout)` at module
// eval — which was the launch crash on the pre-Sentry 1.0.2 store binary.
export function wrapRoot<T>(Component: T): T {
  try {
    return Sentry && typeof Sentry.wrap === "function" ? (Sentry.wrap(Component as any) as T) : Component;
  } catch {
    return Component;
  }
}

export { Sentry };
