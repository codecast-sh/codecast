// Relay half of `cast auth`: polls the backend for a token the web page
// deposited because it couldn't reach our localhost listener (CLI on a remote
// machine — see convex/cliAuth.ts). Runs alongside AuthServer.waitForCallback;
// whichever path delivers first wins.
//
// The poll loop lives in @platform/auth/cli; what stays here is the cast CLI's
// own fetch, which carries the timeout and retry policy every other CLI call
// uses.
import { startRelayPoller as startPackageRelayPoller } from "@platform/auth/cli";
import type { RelayPoller } from "@platform/auth/cli";
import { cliFetch } from "./cliHttp.js";

export type { RelayPoller };

export function startRelayPoller(
  convexSiteUrl: string,
  nonce: string,
  opts: { intervalMs?: number; fetchImpl?: typeof cliFetch } = {}
): RelayPoller {
  return startPackageRelayPoller(convexSiteUrl, nonce, {
    intervalMs: opts.intervalMs,
    fetchImpl: opts.fetchImpl ?? cliFetch,
  });
}
