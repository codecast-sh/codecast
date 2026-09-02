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

/**
 * How many calls the entry points hold while they wait for initAnalytics.
 *
 * A consumer that never initializes must not grow the buffer without limit, so
 * the count is capped. Fifty is far more than a boot window produces and small
 * enough to hold forever. At the cap the OLDEST call is dropped, never the
 * newest: the latest identify carries the identity that is true now, and the
 * latest events are the ones closest to whatever the app is doing.
 */
export const PRE_INIT_BUFFER_LIMIT = 50;

export interface PreInitBuffer {
  /** Hold a call until init runs. */
  add(call: () => void): void;
  /** Replay every held call in the order it was made, then stop holding. */
  flush(): void;
  /** Forget everything held. Used by the test reset hooks. */
  clear(): void;
}

/**
 * Identify and track calls made before init used to be silent no-ops, so a
 * crash during a slow boot reached Sentry with no user attached. The entry
 * points hold those calls here instead and replay them once init has both SDKs
 * up.
 */
export function createPreInitBuffer(limit: number = PRE_INIT_BUFFER_LIMIT): PreInitBuffer {
  let calls: Array<() => void> = [];
  return {
    add(call) {
      if (calls.length >= limit) calls.shift();
      calls.push(call);
    },
    flush() {
      // Take the queue first: a replayed call runs the real code path now, and
      // that path must not be able to append to the list being walked.
      const queued = calls;
      calls = [];
      for (const call of queued) {
        // One backend refusing a held call must not break the init that
        // replays it, nor stop the calls behind it.
        try {
          call();
        } catch {
          // the SDK rejected this one; the rest still run
        }
      }
    },
    clear() {
      calls = [];
    },
  };
}

/** Super properties registered on every PostHog event. */
export function superProperties(config: ResolvedAnalyticsConfig): Record<string, string> {
  const props: Record<string, string> = { platform: config.platform, environment: config.environment };
  if (config.appName) props.app = config.appName;
  return props;
}
