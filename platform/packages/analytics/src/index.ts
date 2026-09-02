// Shared types and config validation for @platform/analytics.
//
// The entry points (web, native, server) each take a config object instead of
// reading env vars or hardcoded keys. Apps read their own env (VITE_*,
// EXPO_PUBLIC_*, process.env) and pass the values in.
//
// Identity convention: distinct_id is the app's own user id. Codecast passes
// the Convex users._id string on every surface (web identify, mobile identify,
// server capture), so browser, mobile and server events merge into one PostHog
// person. Keep that convention in any app that adopts this package.

export type Environment = "development" | "production";

export interface AnalyticsConfig {
  /** PostHog project key (phc_...). Omit to disable PostHog. */
  posthogKey?: string;
  /** PostHog ingest host. Defaults to the US cloud. */
  posthogHost?: string;
  /** Sentry DSN. Omit to disable Sentry. */
  sentryDsn?: string;
  /** "development" disables Sentry and registers an environment super property. */
  environment: Environment;
  /** Platform label sent as a Sentry tag and a PostHog super property: "web", "desktop", "mobile". */
  platform: string;
  /** App name. Sent as a PostHog super property so apps sharing one project stay filterable. */
  appName?: string;
}

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export type ResolvedAnalyticsConfig = AnalyticsConfig & { posthogHost: string };

export class AnalyticsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsConfigError";
  }
}

/** Fill defaults and reject values that would silently break reporting. */
export function resolveConfig(config: AnalyticsConfig): ResolvedAnalyticsConfig {
  if (!config || typeof config !== "object") {
    throw new AnalyticsConfigError("config is required");
  }
  if (config.environment !== "development" && config.environment !== "production") {
    throw new AnalyticsConfigError(`environment must be "development" or "production", got ${JSON.stringify(config.environment)}`);
  }
  if (typeof config.platform !== "string" || !config.platform) {
    throw new AnalyticsConfigError("platform is required (for example \"web\", \"desktop\", \"mobile\")");
  }
  if (config.posthogKey !== undefined && typeof config.posthogKey !== "string") {
    throw new AnalyticsConfigError("posthogKey must be a string");
  }
  if (config.sentryDsn !== undefined && typeof config.sentryDsn !== "string") {
    throw new AnalyticsConfigError("sentryDsn must be a string");
  }
  const host = config.posthogHost || DEFAULT_POSTHOG_HOST;
  if (!/^https?:\/\//.test(host)) {
    throw new AnalyticsConfigError(`posthogHost must be an http(s) URL, got ${JSON.stringify(host)}`);
  }
  return { ...config, posthogHost: host.replace(/\/+$/, ""), posthogKey: config.posthogKey || undefined, sentryDsn: config.sentryDsn || undefined };
}

/** Super properties registered on every PostHog event. */
export function superProperties(config: ResolvedAnalyticsConfig): Record<string, string> {
  const props: Record<string, string> = { platform: config.platform, environment: config.environment };
  if (config.appName) props.app = config.appName;
  return props;
}
