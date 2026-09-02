// Server side evaluator over PostHog's flags HTTP API. No SDK; `fetch` is
// injected so tests run without network and a Convex action can pass its own.
// POSTs to `${host}/flags/?v=2` and accepts both the v2 response (`flags`
// map) and the older decide shape (`featureFlags` + `featureFlagPayloads`).
import { type FlagsClient, type FlagValue, splitFlagValue } from "./types";

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface ServerFlagsOptions {
  apiKey: string;
  /** "https://us.i.posthog.com" or "https://eu.i.posthog.com". */
  host: string;
  distinctId: string;
  groups?: Record<string, string>;
  personProperties?: Record<string, unknown>;
  fetch: FetchLike;
}

export interface FlagSnapshot {
  values: Record<string, FlagValue>;
  payloads: Record<string, unknown>;
}

/** Turn either response shape into one snapshot. */
export function parseFlagsResponse(body: unknown): FlagSnapshot {
  const out: FlagSnapshot = { values: {}, payloads: {} };
  const b = (body ?? {}) as Record<string, any>;
  if (b.flags && typeof b.flags === "object") {
    for (const [key, f] of Object.entries<any>(b.flags)) {
      out.values[key] = f?.variant ?? (f?.enabled === true);
      const payload = f?.metadata?.payload;
      if (payload !== undefined && payload !== null) out.payloads[key] = parsePayload(payload);
    }
    return out;
  }
  if (b.featureFlags && typeof b.featureFlags === "object") {
    for (const [key, v] of Object.entries<any>(b.featureFlags)) out.values[key] = v as FlagValue;
  }
  if (b.featureFlagPayloads && typeof b.featureFlagPayloads === "object") {
    for (const [key, p] of Object.entries<any>(b.featureFlagPayloads)) out.payloads[key] = parsePayload(p);
  }
  return out;
}

function parsePayload(p: unknown): unknown {
  if (typeof p !== "string") return p;
  try {
    return JSON.parse(p);
  } catch {
    return p;
  }
}

export function flagsEndpoint(host: string): string {
  return `${host.replace(/\/+$/, "")}/flags/?v=2`;
}

/** Fetch one snapshot for the given identity. */
export async function fetchFlags(opts: ServerFlagsOptions): Promise<FlagSnapshot> {
  const res = await opts.fetch(flagsEndpoint(opts.host), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: opts.apiKey,
      distinct_id: opts.distinctId,
      groups: opts.groups,
      person_properties: opts.personProperties,
    }),
  });
  if (!res.ok) throw new Error(`PostHog flags request failed: ${res.status}`);
  return parseFlagsResponse(await res.json());
}

/** A FlagsClient that reads from the last fetched snapshot. Call `reload()`
 *  once before reading; `createServerFlagsClient` does not fetch on its own. */
export function createServerFlagsClient(opts: ServerFlagsOptions): FlagsClient & { snapshot: () => FlagSnapshot } {
  let snap: FlagSnapshot = { values: {}, payloads: {} };
  return {
    getFlag: (key) => splitFlagValue(snap.values[key]).enabled,
    getPayload: <T,>(key: string) => snap.payloads[key] as T | undefined,
    getVariant: (key) => splitFlagValue(snap.values[key]).variant,
    reload: async () => {
      snap = await fetchFlags(opts);
    },
    snapshot: () => snap,
  };
}
