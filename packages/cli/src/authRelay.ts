// Relay half of `cast auth`: polls the backend for a token the web page
// deposited because it couldn't reach our localhost listener (CLI on a remote
// machine — see convex/cliAuth.ts). Runs alongside AuthServer.waitForCallback;
// whichever path delivers first wins.
//
// Before the browser opens, the CLI registers its request with the server
// (registerAuthRequest): the nonce the URL carries plus the hash of a
// verifier that stays on this machine. The server then hands a relayed token
// only to a claim carrying that verifier, so whoever sees the URL cannot
// collect it.
//
// The poll loop lives in @platform/auth/cli; what stays here is the cast CLI's
// own fetch, which carries the timeout and retry policy every other CLI call
// uses, and adds the verifier to each claim.
import { createHash, randomBytes } from "crypto";
import { startRelayPoller as startPackageRelayPoller } from "@platform/auth/cli";
import type { RelayPoller } from "@platform/auth/cli";
import { cliFetch } from "./cliHttp.js";

export type { RelayPoller };

/** A fresh verifier and the hash the server stores for it. */
export function makeVerifier(): { verifier: string; verifierHash: string } {
  const verifier = randomBytes(32).toString("hex");
  return { verifier, verifierHash: createHash("sha256").update(verifier).digest("hex") };
}

/**
 * Register this sign-in with the server. False when the server refused or
 * could not be reached (a backend older than registration): the sign-in then
 * still completes on the legacy path, so a failure here is never fatal.
 */
export async function registerAuthRequest(
  convexSiteUrl: string,
  req: { nonce: string; verifierHash: string; deviceName: string; deviceId?: string },
  fetchImpl: typeof cliFetch = cliFetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `${convexSiteUrl}/cli/auth-request`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nonce: req.nonce,
          verifier_hash: req.verifierHash,
          device_name: req.deviceName,
          ...(req.deviceId ? { device_id: req.deviceId } : {}),
        }),
      },
      { timeoutMs: 10_000 },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function startRelayPoller(
  convexSiteUrl: string,
  nonce: string,
  opts: { intervalMs?: number; fetchImpl?: typeof cliFetch; verifier?: string } = {}
): RelayPoller {
  const baseFetch = opts.fetchImpl ?? cliFetch;
  const verifier = opts.verifier;
  const fetchImpl: typeof cliFetch = verifier
    ? (url, init, o) =>
        baseFetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(String(init?.body ?? "{}")), verifier }) }, o)
    : baseFetch;
  return startPackageRelayPoller(convexSiteUrl, nonce, {
    intervalMs: opts.intervalMs,
    fetchImpl,
  });
}
