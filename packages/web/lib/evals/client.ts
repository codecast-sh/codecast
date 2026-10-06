// Loopback transport for the daemon's /evals routes (cli/src/evals/evalsServer.ts),
// which forwards each request to the eval tool's api child. The evals live on
// the laptop that ran them, so they are read straight off its disk through the
// same bridge, token and endpoint discovery as Files and Memory.
//
// Requests, calls and the error they throw are @platform/evals/client's, typed
// by codecast's route table (store/evalsStore.ts); this file adds only how a
// request reaches this machine.

import { evalsFetchInit, evalsResponseOf, evalsUrlPath, type EvalsTransport } from "@platform/evals/client";
import { loopbackFetch, type VaultEndpoint } from "../vault/client";

/** Where the daemon serves the evals on its loopback bridge. */
const DAEMON_EVALS_PREFIX = "/evals";

export function loopbackTransport(ep: VaultEndpoint): EvalsTransport {
  return {
    kind: "loopback",
    send: async (req) => evalsResponseOf(await loopbackFetch(ep, evalsUrlPath(req, DAEMON_EVALS_PREFIX), evalsFetchInit(req))),
  };
}
