// The /code/* routes on the daemon's loopback bridge: project search, git
// status and baselines, session blame and the vim config, for the editor in
// the Files surface. Same envelope as /vault/* (vaultServer.ts): the allowed
// origin plus the loopback bearer on every request, a vault named by id, and
// every path resolved through vaultScope.resolveVaultPath.
// Design: docs/architecture/code-editor.md.

import * as http from "node:http";
import * as os from "node:os";
import { CODE_VIMRC_MAX_BYTES, type CodeSearchEvent, type VaultInfo } from "@codecast/shared/contracts";
import { authorizeLocalRequest, corsHeaders } from "../terminal/terminalServer.js";
import { findVault } from "../vault/vaultRegistry.js";
import { normalizeVaultPath, resolveVaultPath } from "../vault/vaultScope.js";
import { readBody, sendJson, type VaultServerOptions } from "../vault/vaultServer.js";
import { blameVaultFile, type BlameAuth } from "./codeBlame.js";
import { gitBase, isSafeRef, statusResponse, vaultGitStatus } from "./codeGit.js";
import { parseSearchParams, searchVault, type SearchEngines } from "./codeSearch.js";
import { readVimrc, writeVimrcOverlay } from "./vimrcSources.js";

export interface CodeServerOptions extends VaultServerOptions {
  /** The signed-in config blame attribution asks the server with; null offline. */
  blameAuth?: () => BlameAuth | null;
  /** Where vimrc files are read from. Defaults to the OS home; tests inject one. */
  homeDir?: string;
  /** Search engine override, for tests of the fallbacks. */
  searchEngines?: SearchEngines;
}

type Headers = Record<string, string>;

/** A vault-relative read path, resolved. Reads admit repo-ignored paths, as
 *  GET /vault/file does: the tree can list them. */
function readTarget(vault: VaultInfo, raw: string | null): { rel: string; abs: string } | null {
  const rel = normalizeVaultPath(raw ?? "");
  if (!rel) return null;
  const abs = resolveVaultPath(vault.root, rel, { allowIgnored: true });
  return abs ? { rel, abs } : null;
}

function handleSearch(req: http.IncomingMessage, res: http.ServerResponse, headers: Headers, vault: VaultInfo, params: URLSearchParams, opts: CodeServerOptions): Promise<void> | void {
  const search = parseSearchParams(params);
  if (!search) return sendJson(res, 400, headers, { error: "missing q" });
  res.writeHead(200, {
    ...headers,
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    // Proxies and the dev server must not hold lines back for a bigger chunk.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  // A client that goes away kills the search. Bun's server reports that on the
  // socket only (the response never emits "close"); Node reports it on both.
  const abort = new AbortController();
  const onGone = () => {
    if (!res.writableFinished) abort.abort();
  };
  res.on("close", onGone);
  req.socket.on("close", onGone);
  const emit = (event: CodeSearchEvent) => {
    if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  return searchVault(vault.root, search, emit, abort.signal, { configDir: opts.configDir, engines: opts.searchEngines }).finally(() => {
    req.socket.off("close", onGone);
    res.end();
  });
}

async function handleBlame(res: http.ServerResponse, headers: Headers, vault: VaultInfo, raw: string | null, opts: CodeServerOptions): Promise<void> {
  const target = readTarget(vault, raw);
  if (!target) return sendJson(res, 400, headers, { error: "bad path" });
  const result = await blameVaultFile(vault, target.rel, target.abs, opts.blameAuth?.() ?? null);
  if ("error" in result) return sendJson(res, result.error === "too large" ? 413 : 404, headers, result);
  sendJson(res, 200, headers, result);
}

async function handleBase(res: http.ServerResponse, headers: Headers, vault: VaultInfo, params: URLSearchParams): Promise<void> {
  const target = readTarget(vault, params.get("path"));
  if (!target) return sendJson(res, 400, headers, { error: "bad path" });
  const ref = params.get("ref") || "HEAD";
  if (!isSafeRef(ref)) return sendJson(res, 400, headers, { error: "bad ref" });
  const result = await gitBase(vault, target.rel, ref);
  if ("error" in result) return sendJson(res, result.error === "too large" ? 413 : 404, headers, result);
  sendJson(res, 200, headers, result);
}

/**
 * HTTP endpoints for the code editor. Returns true when the request was
 * handled, the same contract as handleVaultHttp.
 */
export function handleCodeHttp(req: http.IncomingMessage, res: http.ServerResponse, opts: CodeServerOptions): boolean {
  const url = req.url ?? "";
  if (!url.startsWith("/code/")) return false;
  const headers = corsHeaders(req.headers.origin, opts);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Content-Type": "application/json", ...headers });
    res.end();
    return true;
  }
  if (!authorizeLocalRequest(req, opts)) {
    sendJson(res, 403, headers, { error: "forbidden" });
    return true;
  }

  const parsed = new URL(url, "http://localhost");
  const params = parsed.searchParams;
  const route = `${req.method} ${parsed.pathname}`;

  const dispatch = async (): Promise<void> => {
    // The vim config belongs to the person, not to a vault.
    const dirs = { home: opts.homeDir ?? os.homedir(), configDir: opts.configDir };
    if (route === "GET /code/vimrc") return sendJson(res, 200, headers, await readVimrc(dirs));
    if (route === "PUT /code/vimrc/overlay") {
      const body = await readBody(req, CODE_VIMRC_MAX_BYTES);
      if (!body) return sendJson(res, 413, headers, { error: "too large" });
      return sendJson(res, 200, headers, await writeVimrcOverlay(dirs.configDir, body));
    }

    const vault = findVault(opts.configDir, params.get("vault") ?? "");
    if (!vault) return sendJson(res, 404, headers, { error: "unknown vault" });

    switch (route) {
      case "GET /code/search":
        return handleSearch(req, res, headers, vault, params, opts);
      case "GET /code/git/status":
        return sendJson(res, 200, headers, statusResponse(await vaultGitStatus(vault, { fresh: params.get("fresh") === "1" })));
      case "GET /code/git/base":
        return handleBase(res, headers, vault, params);
      case "GET /code/blame":
        return handleBlame(res, headers, vault, params.get("path"), opts);
    }
    sendJson(res, 404, headers, { error: "not found" });
  };

  void dispatch().catch((err) => {
    opts.log(`[CODE] ${route} failed: ${(err as Error)?.message ?? err}`);
    if (!res.headersSent) sendJson(res, 500, headers, { error: "server error" });
    else res.end();
  });
  return true;
}
