import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { cliFetch } from "./cliHttp.js";
import type { Config } from "./config/types.js";

export const STATUS_NETWORK_TIMEOUT_MS = 3_000;
export const STATUS_STATE_STALE_MS = 2 * 60_000;

export type NetworkCheck = {
  status: "ok" | "slow" | "error" | "skipped";
  detail: string;
  elapsedMs?: number;
  httpStatus?: number;
};

export type NetworkStatus = {
  endpoint: string | null;
  interfaces: Array<{ name: string; addresses: string[] }>;
  dns: NetworkCheck;
  api: NetworkCheck;
  auth: "verified" | "rejected" | "unverified" | "missing";
};

const skipped = (detail: string): NetworkCheck => ({ status: "skipped", detail });

function failureDetail(error: unknown): string {
  const err = error as { code?: string; name?: string; message?: string; cause?: { code?: string } } | null;
  const code = err?.cause?.code ?? err?.code;
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || err?.message?.includes("timed out") || code === "ETIMEDOUT") return "timed out";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `DNS lookup failed (${code})`;
  if (code === "ECONNREFUSED" || code === "ConnectionRefused") return "connection refused";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") return "network unreachable";
  if (code === "ECONNRESET" || code === "ConnectionClosed") return "connection reset";
  if (code && /CERT|TLS|SSL/.test(code)) return "TLS certificate or handshake failed";
  return "connection failed";
}

async function measure(
  run: () => Promise<Omit<NetworkCheck, "elapsedMs">>,
  timeoutMs: number,
): Promise<NetworkCheck> {
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DOMException("timed out", "TimeoutError")), timeoutMs);
  });
  const [result] = await Promise.allSettled([Promise.race([Promise.resolve().then(run), deadline])]);
  clearTimeout(timer!);
  const elapsedMs = Math.round(performance.now() - start);
  if (result.status === "rejected") return { status: "error", detail: failureDetail(result.reason), elapsedMs };
  return { ...result.value, elapsedMs };
}

export async function collectNetworkStatus(
  config: Pick<Config, "convex_url" | "auth_token"> | null,
  enabled = true,
  deps = { lookup, networkInterfaces, fetch: cliFetch, timeoutMs: STATUS_NETWORK_TIMEOUT_MS },
): Promise<NetworkStatus> {
  const interfaces = Object.entries(deps.networkInterfaces()).flatMap(([name, entries]) => {
    const addresses = [...new Set((entries ?? []).filter(entry => !entry.internal && !/^fe80:/i.test(entry.address)).map(entry => entry.address))];
    return addresses.length ? [{ name, addresses }] : [];
  });
  const rawUrl = config?.convex_url;
  const url = rawUrl && URL.canParse(rawUrl) ? new URL(rawUrl) : null;
  const valid = url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  if (valid) {
    url.hostname = url.hostname.replace(/\.cloud$/, ".site");
    url.search = "";
    url.hash = "";
  }
  const endpoint = valid ? url.href.replace(/\/$/, "") : null;
  const auth = config?.auth_token ? "unverified" : "missing";
  const reason = !enabled ? "disabled (--no-network)" : rawUrl ? "invalid backend URL" : "backend not configured";
  if (!enabled || !endpoint || !url) {
    const check = enabled && rawUrl ? { status: "error" as const, detail: reason } : skipped(reason);
    return { endpoint, interfaces, auth, dns: check, api: check };
  }

  let verifiedAuth: NetworkStatus["auth"] = auth;
  const [dns, api] = await Promise.all([
    measure(async () => {
      const addresses = await deps.lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
      return { status: "ok", detail: [...new Set(addresses.map(entry => entry.address))].join(", ") };
    }, deps.timeoutMs),
    measure(async () => {
      const response = await deps.fetch(`${endpoint}/cli/sync-settings`, {
        method: config?.auth_token ? "POST" : "OPTIONS",
        headers: { "Content-Type": "application/json" },
        body: config?.auth_token ? JSON.stringify({ api_token: config.auth_token }) : undefined,
        redirect: "error",
      }, { timeoutMs: deps.timeoutMs, retries: 0 });
      const httpStatus = response.status;
      if (httpStatus === 401 || httpStatus === 403) {
        if (config?.auth_token) verifiedAuth = "rejected";
        await response.body?.cancel();
        return { status: "error", detail: "reachable; authentication rejected — run cast auth", httpStatus };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { status: "error", detail: httpStatus === 429 ? "reachable; rate limited" : "reachable; server request failed", httpStatus };
      }
      if (!config?.auth_token) {
        await response.body?.cancel();
        return { status: "ok", detail: "reachable; sign in to check authenticated requests", httpStatus };
      }
      const [payload] = await Promise.allSettled([response.json()]);
      if (payload.status === "rejected" || !["all", "selected"].includes(payload.value?.sync_mode) || !Array.isArray(payload.value?.sync_projects)) {
        return { status: "error", detail: "unexpected response from backend", httpStatus };
      }
      verifiedAuth = "verified";
      return { status: "ok", detail: "reachable; authenticated request succeeded", httpStatus };
    }, deps.timeoutMs),
  ]);
  if (api.status === "ok" && (api.elapsedMs ?? 0) >= 1_000) api.status = "slow";
  return { endpoint, interfaces, dns, api, auth: verifiedAuth };
}

export function daemonConnectionStatus(
  running: boolean,
  state: { connected?: boolean; timestamp?: number; lastHeartbeatTick?: number; lastWatchdogCheck?: number } | null,
  now = Date.now(),
) {
  if (!running) return { status: "stopped", detail: "not connected (daemon stopped)" };
  const tick = state?.lastHeartbeatTick || state?.lastWatchdogCheck;
  const stamp = state?.timestamp;
  if (!stamp || now - stamp > STATUS_STATE_STALE_MS || (tick && now - tick > STATUS_STATE_STALE_MS)) {
    return { status: "unknown", detail: "unknown (daemon state stale or missing) — run cast restart" };
  }
  if (state?.connected === undefined) return { status: "unknown", detail: "unknown (no WebSocket state yet)" };
  return state.connected
    ? { status: "connected", detail: "connected (daemon WebSocket)" }
    : { status: "disconnected", detail: "disconnected (daemon WebSocket)" };
}

export function networkStatusRows(network: NetworkStatus): Array<[string, string, NetworkCheck["status"]]> {
  const timing = (check: NetworkCheck) => check.elapsedMs === undefined ? "" : ` · ${check.elapsedMs} ms`;
  const http = network.api.httpStatus ? ` · HTTP ${network.api.httpStatus}` : "";
  return [
    ["Backend", network.endpoint ?? "not configured", "skipped"],
    ["Interfaces", network.interfaces.length
      ? network.interfaces.map(entry => `${entry.name} (${entry.addresses.join(", ")})`).join("; ")
      : "no external interface address", "skipped"],
    ["DNS", `${network.dns.detail}${timing(network.dns)}`, network.dns.status],
    ["API", `${network.api.detail}${http}`, network.api.status],
    ["Latency", network.api.elapsedMs === undefined
      ? "not measured"
      : `${network.api.elapsedMs} ms ${network.api.status === "ok" || network.api.status === "slow" ? `round-trip${network.api.status === "slow" ? " (slow)" : ""}` : "until failure"}`, network.api.status],
  ];
}
