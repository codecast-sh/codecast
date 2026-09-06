// Server side PostHog capture over plain fetch. No React, no browser, no
// Convex imports. Lifted from codecast packages/convex/convex/analytics.ts
// (identified events) and packages/web/server/index.ts (personless events).
//
// Fire and forget: wrap capture in something that cannot fail the caller
// (a Convex internalAction scheduled with runAfter(0, ...), or a bare call
// with the promise ignored). A PostHog outage must never slow or fail a
// product flow.

import { DEFAULT_POSTHOG_HOST, AnalyticsConfigError } from "./index";
import { createTrackGate, resolveOptOut, type EventCatalog } from "./catalog";

export interface ServerAnalyticsConfig {
  /** PostHog project key (phc_...). Publishable; the web bundle ships the same key. */
  posthogKey: string;
  /** PostHog ingest host. Defaults to the US cloud. */
  posthogHost?: string;
  /** Value of the "source" property on every event, for example "convex" or "web_server". */
  source: string;
  /** fetch implementation. Defaults to globalThis.fetch. Inject a mock in tests. */
  fetch?: typeof fetch;
  /** UUID generator for personless events. Defaults to crypto.randomUUID. */
  randomUUID?: () => string;
  /**
   * Typed event catalog. Present: capture drops any event it does not describe.
   * Absent: any name and shape goes through.
   */
  catalog?: EventCatalog;
  /** Per-process ceiling on transmitted events. Defaults to SESSION_EVENT_CAP. */
  sessionEventCap?: number;
  /**
   * Environment read for the DO_NOT_TRACK and CI opt out. Pass `process.env` to
   * turn it on. Omitted means no environment is consulted: a library that reads
   * ambient env decides for its caller, and the first thing that breaks is the
   * caller's own test suite, which runs with CI set.
   */
  env?: Record<string, string | undefined>;
  /**
   * Extra variable names that turn telemetry off, for an app's own kill switch.
   * A server has no user agent to carry Do Not Track, so this is how an
   * operator running the app themselves says no.
   */
  optOutVars?: readonly string[];
}

export interface CapturePayload {
  api_key: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

export interface ServerAnalytics {
  /** POST endpoint the payloads go to. */
  endpoint: string;
  /**
   * Identified event. distinct_id must be the app's user id (codecast: the
   * Convex users._id string) so server and client events merge into one
   * PostHog person.
   */
  capture(event: string, distinctId: string, properties?: Record<string, unknown>): Promise<void>;
  /**
   * Personless event for requests with no identity to merge (install script
   * fetches, download redirects). Uses a random distinct_id and sets
   * $process_person_profile false so no person is created per request.
   */
  capturePersonless(event: string, properties?: Record<string, unknown>): Promise<void>;
  /** Build the body without sending it. */
  buildPayload(event: string, distinctId: string, properties?: Record<string, unknown>): CapturePayload;
  /** Events transmitted so far; the burst cap counts these. */
  readonly sent: number;
  /** True when DO_NOT_TRACK or a CI variable turned telemetry off. */
  readonly optedOut: boolean;
}

export function createServerAnalytics(config: ServerAnalyticsConfig): ServerAnalytics {
  if (!config || typeof config.posthogKey !== "string" || !config.posthogKey) {
    throw new AnalyticsConfigError("posthogKey is required");
  }
  if (typeof config.source !== "string" || !config.source) {
    throw new AnalyticsConfigError("source is required");
  }
  const host = (config.posthogHost || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(host)) {
    throw new AnalyticsConfigError(`posthogHost must be an http(s) URL, got ${JSON.stringify(host)}`);
  }
  const endpoint = `${host}/i/v0/e/`;
  const doFetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const randomUUID = config.randomUUID ?? (() => globalThis.crypto.randomUUID());

  const buildPayload = (event: string, distinctId: string, properties?: Record<string, unknown>): CapturePayload => ({
    api_key: config.posthogKey,
    event,
    distinct_id: distinctId,
    properties: { source: config.source, ...properties },
  });

  const send = async (payload: CapturePayload) => {
    try {
      await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Analytics must never surface errors to product flows.
    }
  };

  // A CI run's events are indistinguishable from real usage once they land in
  // the project, and DO_NOT_TRACK is the standard kill switch. Resolved once,
  // here, so no call site carries its own env check.
  const { optedOut } = resolveOptOut({ env: config.env, extraVars: config.optOutVars });
  const gate = createTrackGate({ catalog: config.catalog, sessionCap: config.sessionEventCap, optedOut });

  const gated = async (event: string, distinctId: string, properties?: Record<string, unknown>) => {
    const allowed = gate.check(event, properties);
    if (!allowed.ok) return;
    await send(buildPayload(event, distinctId, allowed.properties));
  };

  return {
    endpoint,
    buildPayload,
    get sent() {
      return gate.sent;
    },
    optedOut,
    capture: (event, distinctId, properties) => gated(event, distinctId, properties),
    // The personless marker is transport, not payload: the catalog describes
    // what the caller passed, so it is added after the check rather than
    // failing it as an unknown key.
    capturePersonless: async (event, properties) => {
      const allowed = gate.check(event, properties);
      if (!allowed.ok) return;
      await send(
        buildPayload(event, randomUUID(), { $process_person_profile: false, ...allowed.properties }),
      );
    },
  };
}
