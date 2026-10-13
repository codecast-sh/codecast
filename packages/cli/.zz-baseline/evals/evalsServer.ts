// The /evals/* routes on the daemon's loopback bridge (docs/architecture/
// evals-ui.md, 3.5). Same envelope as /memory/* and /vault/*: the origin
// allowlist and the daemon's per-boot bearer. The daemon answers nothing
// itself; each request goes to the eval tool's api child (evalsBridge.ts),
// which reads EVALS_HOME and git on this machine. Private freezes, runs and
// replies pass through here to the page and nowhere else.
//
// A path the contract does not list is refused here, so a stray request never
// starts the child.

import * as http from "http";
import { matchEvalsRoute, type EvalsBridgeRequest, type EvalsErrorBody } from "@codecast/shared/contracts/evalsApi";
import { authorizeLocalRequest, corsHeaders, type TerminalServerOptions } from "../terminal/terminalServer.js";
import { readBody, sendJson } from "../vault/vaultServer.js";
import { createEvalsBridge, type EvalsBridge } from "./evalsBridge.js";

const PREFIX = "/evals";
const MAX_BODY_BYTES = 1024 * 1024;

let daemonBridge: EvalsBridge | null = null;

/** The daemon's one bridge, made on the first /evals request. */
function bridgeFor(opts: TerminalServerOptions): EvalsBridge {
  daemonBridge ??= createEvalsBridge({ log: opts.log });
  return daemonBridge;
}

/** End the api child, if one runs. Called on daemon shutdown. */
export function stopEvalsBridge(): void {
  daemonBridge?.stop();
}

const fail = (res: http.ServerResponse, status: number, headers: Record<string, string>, body: EvalsErrorBody) => sendJson(res, status, headers, body);

/**
 * HTTP endpoints for the Evals pages. Returns true when the request was
 * handled, the same contract as handleMemoryHttp. The work runs after it
 * returns; nothing here waits on the child.
 */
export function handleEvalsHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: TerminalServerOptions,
  bridge?: EvalsBridge,
): boolean {
  const url = req.url ?? "";
  if (!url.startsWith(`${PREFIX}/`)) return false;
  const headers = corsHeaders(req.headers.origin, opts);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Content-Type": "application/json", ...headers });
    res.end();
    return true;
  }
  if (!authorizeLocalRequest(req, opts)) {
    fail(res, 403, headers, { error: "forbidden", reason: "forbidden" });
    return true;
  }

  const parsed = new URL(url, "http://localhost");
  const method = req.method === "POST" ? "POST" : req.method === "GET" ? "GET" : null;
  const path = parsed.pathname.slice(PREFIX.length);
  if (!method || !matchEvalsRoute(method, path)) {
    fail(res, 404, headers, { error: "not found", reason: "not-found" });
    return true;
  }
  const query = Object.fromEntries(parsed.searchParams);

  const dispatch = async (): Promise<void> => {
    let body: unknown;
    if (method === "POST") {
      const raw = await readBody(req, MAX_BODY_BYTES);
      if (!raw) return fail(res, 413, headers, { error: "too large", reason: "bad-request" });
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          return fail(res, 400, headers, { error: "bad json", reason: "bad-request" });
        }
      }
    }
    const request: Omit<EvalsBridgeRequest, "id"> = { method, path, query, ...(body === undefined ? {} : { body }) };
    const reply = await (bridge ?? bridgeFor(opts)).request(request);
    sendJson(res, reply.status, headers, reply.body);
  };
  dispatch().catch((err: unknown) => {
    if (res.headersSent) return;
    opts.log(`[EVALS] ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    fail(res, 500, headers, { error: "internal error" });
  });
  return true;
}
