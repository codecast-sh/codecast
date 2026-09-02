// Server side PostHog capture over plain fetch. No React, no browser, no
// Convex imports. Lifted from codecast packages/convex/convex/analytics.ts
// (identified events) and packages/web/server/index.ts (personless events).
//
// Fire and forget: wrap capture in something that cannot fail the caller
// (a Convex internalAction scheduled with runAfter(0, ...), or a bare call
// with the promise ignored). A PostHog outage must never slow or fail a
// product flow.

import { DEFAULT_POSTHOG_HOST, AnalyticsConfigError } from "./index";

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

  return {
    endpoint,
    buildPayload,
    capture: (event, distinctId, properties) => send(buildPayload(event, distinctId, properties)),
    capturePersonless: (event, properties) =>
      send(buildPayload(event, randomUUID(), { $process_person_profile: false, ...properties })),
  };
}
