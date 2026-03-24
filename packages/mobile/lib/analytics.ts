import * as Sentry from "@sentry/react-native";
import PostHog from "posthog-react-native";

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
const POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";
const IS_DEV = __DEV__;

export let posthog: PostHog | null = null;

export function initAnalytics() {
  if (SENTRY_DSN) {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: IS_DEV ? "development" : "production",
      enabled: !IS_DEV,
      tracesSampleRate: IS_DEV ? 1.0 : 0.2,
      initialScope: {
        tags: { platform: "mobile" },
      },
    });
  }

  if (POSTHOG_KEY) {
    posthog = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      disabled: IS_DEV,
    });
    posthog.register({ platform: "mobile" });
  }
}

export function identifyUser(userId: string, traits?: Record<string, string | number | boolean | null>) {
  if (SENTRY_DSN) {
    Sentry.setUser({ id: userId, ...traits });
  }
  posthog?.identify(userId, traits ?? undefined);
}

export function resetUser() {
  if (SENTRY_DSN) {
    Sentry.setUser(null);
  }
  posthog?.reset();
}

export function track(event: string, properties?: Record<string, string | number | boolean>) {
  posthog?.capture(event, properties);
}

export function captureError(error: Error, context?: Record<string, unknown>) {
  if (SENTRY_DSN) {
    Sentry.captureException(error, { extra: context });
  }
}

export { Sentry };
