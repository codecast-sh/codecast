// The /vault/* routes on the daemon's loopback bridge — the channel the browser
// reads and writes a local markdown vault through. Mounted beside /term/* on the
// same server and behind the same envelope (the daemon's persisted loopback
// bearer token, origin allowlist, CORS + Private Network Access headers),
// because a route here can read and write the user's disk: it must never
// authenticate differently from the one that spawns shells.
//
// Every path the browser sends goes through vaultScope.resolveVaultPath. Nothing
// in this file may construct a filesystem path any other way.

import { spawn } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as http from "http";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import {
  authorizeLocalRequest,
  corsHeaders,
  onWsUpgrade,
  originAllowed,
  tokenMatches,
  type TerminalServerOptions,
} from "../terminal/terminalServer.js";
import { isVaultMarkdownPath, VAULT_MAX_SERVE_BYTES } from "@codecast/shared/contracts";
import type {
  VaultFileEntry,
  VaultInfo,
  VaultOpRequest,
  VaultScanResponse,
  VaultWriteResponse,
  VaultWsEvent,
  VaultWsHello,
} from "@codecast/shared/contracts";
import { moveToTrash, writeVaultFile } from "./vaultFs.js";
import { findVault, listVaults, setVaultNoteCount } from "./vaultRegistry.js";
import {
  isVaultDocumentPath,
  normalizeVaultPath,
  resolveVaultPath,
  revealCommand,
  scanVault,
  vaultContentHash,
  vaultContentType,
} from "./vaultScope.js";
import { VaultWatchHub, type VaultWatchHubOptions } from "./vaultWatcher.js";

const VAULT_WS_PATH = "/vault/ws";
/** A note is text and an attachment is a picture, not a disk image. */
const MAX_WRITE_BYTES = 25 * 1024 * 1024;
const MAX_OP_BYTES = 256 * 1024;

export interface VaultServerOptions extends TerminalServerOptions {
  /** ~/.codecast — where the vault registry lives inside config.json. */
  configDir: string;
  /** Watch/reconcile intervals, for tests that can't wait a minute. */
  watch?: VaultWatchHubOptions;
}

// One hub per process, owned by attachVaultServer. HTTP scans keep a vault warm
// through it when it exists; the routes work without it (a bare HTTP harness in
// tests, or before the WS endpoint is attached).
let hub: VaultWatchHub | null = null;

function sendJson(res: http.ServerResponse, status: number, headers: Record<string, string>, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Resolve a request's vault + path together: both must check out before any
 *  filesystem call happens. Reads take any in-scope path; `writableOnly` is the
 *  narrower markdown+attachment set that PUT and the create op insist on. */
function scoped(
  vault: VaultInfo,
  rawPath: string | null,
  opts: { writableOnly?: boolean } = {},
): { rel: string; abs: string } | null {
  const rel = normalizeVaultPath(rawPath ?? "");
  if (rel === null || rel === "") return null;
  if (opts.writableOnly && !isVaultDocumentPath(rel)) return null;
  const abs = resolveVaultPath(vault.root, rel);
  if (!abs) return null;
  return { rel, abs };
}

function entryFor(rel: string, stat: fs.Stats): VaultFileEntry {
  return stat.isDirectory()
    ? { path: rel, mtime: Math.round(stat.mtimeMs), size: 0, dir: true }
    : { path: rel, mtime: Math.round(stat.mtimeMs), size: stat.size };
}

async function handleScan(
  res: http.ServerResponse,
  headers: Record<string, string>,
  vault: VaultInfo,
  configDir: string,
): Promise<void> {
  const files = await scanVault(vault.root);
  // Markdown only. The scan lists code and attachments too now, and "312 notes"
  // next to a vault has to mean notes — counting every file in a repo would
  // turn the picker's one number into noise.
  const noteCount = files.filter((f) => !f.dir && isVaultMarkdownPath(f.path)).length;
  try {
    setVaultNoteCount(configDir, vault.id, noteCount);
  } catch {}
  hub?.touch(vault);
  const body: VaultScanResponse = {
    vault: { ...vault, note_count: noteCount },
    files,
    scanned_at: Date.now(),
  };
  sendJson(res, 200, headers, body);
}

async function handleGetFile(
  res: http.ServerResponse,
  headers: Record<string, string>,
  vault: VaultInfo,
  rawPath: string | null,
): Promise<void> {
  const target = scoped(vault, rawPath);
  if (!target) return sendJson(res, 400, headers, { error: "bad path" });
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(target.abs);
  } catch {
    return sendJson(res, 404, headers, { error: "not found" });
  }
  if (!stat.isFile()) return sendJson(res, 404, headers, { error: "not found" });
  // Every non-ignored file is readable now, so a repo can point this at a
  // multi-gigabyte database or a core dump. readFile on one would take the
  // daemon down; the cap sits well above any real attachment.
  if (stat.size > VAULT_MAX_SERVE_BYTES) {
    return sendJson(res, 413, headers, { error: "too large", size: stat.size });
  }
  const data = await fsp.readFile(target.abs);
  res.writeHead(200, {
    ...headers,
    "Content-Type": vaultContentType(target.rel),
    "Content-Length": String(data.length),
    "Cache-Control": "no-cache",
    ETag: vaultContentHash(data),
    "X-Vault-Mtime": String(Math.round(stat.mtimeMs)),
    "X-Vault-Size": String(stat.size),
  });
  res.end(data);
}

async function handlePutFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  headers: Record<string, string>,
  vault: VaultInfo,
  rawPath: string | null,
): Promise<void> {
  const target = scoped(vault, rawPath, { writableOnly: true });
  if (!target) return sendJson(res, 400, headers, { error: "bad path" });
  const body = await readBody(req, MAX_WRITE_BYTES);
  if (!body) return sendJson(res, 413, headers, { error: "too large" });

  const ifMatch = (req.headers["if-match"] as string | undefined)?.replace(/"/g, "").trim();
  const baseMtimeRaw = req.headers["x-vault-base-mtime"] as string | undefined;
  const baseMtime = baseMtimeRaw ? Number(baseMtimeRaw) : NaN;
  const hasGuard = !!ifMatch || Number.isFinite(baseMtime);

  let current: { data: Buffer; stat: fs.Stats } | null = null;
  try {
    const stat = await fsp.stat(target.abs);
    if (stat.isFile()) current = { data: await fsp.readFile(target.abs), stat };
  } catch {}

  if (hasGuard) {
    // The guard is what stops a stale editor tab from silently overwriting a
    // change made on disk (or by another tab) since it last read the file.
    const currentEtag = current ? vaultContentHash(current.data) : null;
    const currentMtime = current ? Math.round(current.stat.mtimeMs) : null;
    const mismatch = ifMatch
      ? ifMatch !== currentEtag
      : currentMtime === null || currentMtime !== Math.round(baseMtime);
    if (mismatch) {
      res.writeHead(409, {
        ...headers,
        "Content-Type": current ? vaultContentType(target.rel) : "application/json",
        ETag: currentEtag ?? "",
        "X-Vault-Mtime": String(currentMtime ?? 0),
        "X-Vault-Size": String(current?.stat.size ?? 0),
      });
      res.end(current ? current.data : JSON.stringify({ error: "conflict" }));
      return;
    }
  }

  const stat = await writeVaultFile(target.abs, body);
  const written: VaultWriteResponse = {
    path: target.rel,
    mtime: Math.round(stat.mtimeMs),
    size: stat.size,
    etag: vaultContentHash(body),
  };
  sendJson(res, 200, headers, written);
}

async function handleOp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  headers: Record<string, string>,
  vault: VaultInfo,
): Promise<void> {
  const raw = await readBody(req, MAX_OP_BYTES);
  if (!raw) return sendJson(res, 413, headers, { error: "too large" });
  let op: VaultOpRequest;
  try {
    op = JSON.parse(raw.toString("utf8"));
  } catch {
    return sendJson(res, 400, headers, { error: "bad request" });
  }

  const target = scoped(vault, op?.path ?? null);
  if (!target) return sendJson(res, 400, headers, { error: "bad path" });

  // One stat answers "does it exist" and "what is it"; null when it is absent.
  const statOrNull = (p: string) => fsp.stat(p).catch(() => null);
  const targetStat = await statOrNull(target.abs);

  // Code files are READ-ONLY, and a rename or a trash is a write. They became
  // visible so the tree tells the truth about the folder; nothing here may
  // move or destroy them. Directories are exempt: a folder is not a code file,
  // and reorganising folders is an ordinary vault operation whatever they hold.
  if (op.op === "rename" || op.op === "delete") {
    if (targetStat?.isFile() && !isVaultDocumentPath(target.rel)) {
      return sendJson(res, 400, headers, { error: "read-only" });
    }
  }

  if (op.op === "reveal") {
    // Hand the path to the platform's file manager (or its default app). The
    // path is already confined to the vault by scoped(); argv is passed as an
    // ARRAY with no shell, so a filename can never be read as a command.
    if (!targetStat) return sendJson(res, 404, headers, { error: "not found" });
    const { cmd, args } = revealCommand(process.platform, target.abs, op.mode ?? "reveal");
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.unref();
      child.on("error", () => {});
    } catch {
      return sendJson(res, 500, headers, { error: "could not open" });
    }
    return sendJson(res, 200, headers, { ok: true });
  }

  if (op.op === "mkdir") {
    await fsp.mkdir(target.abs, { recursive: true });
    return sendJson(res, 200, headers, { ok: true });
  }

  if (op.op === "create") {
    if (!isVaultDocumentPath(target.rel)) return sendJson(res, 400, headers, { error: "bad path" });
    if (targetStat) return sendJson(res, 409, headers, { error: "exists" });
    await fsp.mkdir(path.dirname(target.abs), { recursive: true });
    await fsp.writeFile(target.abs, op.content ?? "");
    const stat = await fsp.stat(target.abs);
    return sendJson(res, 200, headers, { ok: true, file: entryFor(target.rel, stat) });
  }

  if (op.op === "rename") {
    const dest = scoped(vault, op.to ?? null);
    if (!dest) return sendJson(res, 400, headers, { error: "bad path" });
    if (!targetStat) return sendJson(res, 404, headers, { error: "not found" });
    // "exists" must not block a case-only rename ("notes" → "Notes"): on the
    // case-insensitive filesystems macOS ships, the destination exists
    // because dest IS the source. Same-inode means same entry — let it through.
    const destStat = await statOrNull(dest.abs);
    if (destStat) {
      const same = targetStat.ino === destStat.ino && target.abs.toLowerCase() === dest.abs.toLowerCase();
      if (!same) return sendJson(res, 409, headers, { error: "exists" });
    }
    await fsp.mkdir(path.dirname(dest.abs), { recursive: true });
    await fsp.rename(target.abs, dest.abs);
    const stat = await fsp.stat(dest.abs);
    return sendJson(res, 200, headers, { ok: true, file: entryFor(dest.rel, stat) });
  }

  if (op.op === "delete") {
    if (!targetStat) return sendJson(res, 404, headers, { error: "not found" });
    try {
      moveToTrash(vault.root, target.abs);
    } catch {
      return sendJson(res, 500, headers, { error: "could not move to trash" });
    }
    return sendJson(res, 200, headers, { ok: true });
  }

  sendJson(res, 400, headers, { error: "unknown op" });
}

/**
 * HTTP endpoints for the vault feature. Returns true when the request was
 * handled — the same contract as handleTerminalHttp, so the daemon's request
 * handler grows by one line.
 */
export function handleVaultHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: VaultServerOptions,
): boolean {
  const url = req.url ?? "";
  if (!url.startsWith("/vault/")) return false;
  const headers = corsHeaders(req.headers.origin, opts);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Content-Type": "application/json", ...headers });
    res.end();
    return true;
  }

  const parsed = new URL(url, "http://localhost");
  const params = parsed.searchParams;

  // Attachments are loaded straight into <img>/<video> tags, which can set
  // neither an Authorization header nor an Origin — so a file READ may instead
  // present the same loopback token as a query param, and stands on that token
  // alone. Reads only: a write or an op that arrived without the full header
  // envelope is refused, so a URL that leaks (history, a referrer) can never be
  // more than a read of a vault the leaker already had the token for.
  const tokenInUrl =
    req.method === "GET" &&
    parsed.pathname === "/vault/file" &&
    tokenMatches(params.get("token"), opts);

  if (!tokenInUrl && !authorizeLocalRequest(req, opts)) {
    sendJson(res, 403, headers, { error: "forbidden" });
    return true;
  }

  const dispatch = async (): Promise<void> => {
    if (req.method === "GET" && parsed.pathname === "/vault/roots") {
      return sendJson(res, 200, headers, { vaults: listVaults(opts.configDir) });
    }

    const vault = findVault(opts.configDir, params.get("vault") ?? "");
    if (!vault) return sendJson(res, 404, headers, { error: "unknown vault" });

    if (req.method === "GET" && parsed.pathname === "/vault/scan") {
      return handleScan(res, headers, vault, opts.configDir);
    }
    if (req.method === "GET" && parsed.pathname === "/vault/file") {
      return handleGetFile(res, headers, vault, params.get("path"));
    }
    if (req.method === "PUT" && parsed.pathname === "/vault/file") {
      return handlePutFile(req, res, headers, vault, params.get("path"));
    }
    if (req.method === "POST" && parsed.pathname === "/vault/op") {
      return handleOp(req, res, headers, vault);
    }
    sendJson(res, 404, headers, { error: "not found" });
  };

  void dispatch().catch((err) => {
    opts.log(`[VAULT] ${req.method} ${url} failed: ${(err as Error)?.message ?? err}`);
    if (!res.headersSent) sendJson(res, 500, headers, { error: "server error" });
    else res.end();
  });
  return true;
}

/** The process's watch hub, once attachVaultServer has created it. The mirror
 *  pusher subscribes through this so a mirrored vault reuses the SAME watcher
 *  the browser does — a second RecursiveWatcher on the same tree would double
 *  the fs pressure and could see a different file set than the routes serve. */
export function vaultWatchHub(): VaultWatchHub | null {
  return hub;
}

/** Wire WS /vault/ws onto the shared loopback server and own the watch hub. */
export function attachVaultServer(server: http.Server, opts: VaultServerOptions): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  hub = new VaultWatchHub({ log: opts.log, ...opts.watch });

  const detach = onWsUpgrade(server, VAULT_WS_PATH, (req, socket, head) => {
    if (!originAllowed(req.headers.origin, opts)) {
      opts.log(`[VAULT] Rejected WS from origin ${req.headers.origin ?? "(none)"}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleVaultSocket(ws, opts));
  });

  return {
    close() {
      detach();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      hub?.stop();
      hub = null;
    },
  };
}

function handleVaultSocket(ws: WebSocket, opts: VaultServerOptions): void {
  let unsubscribe: (() => void) | null = null;
  const send = (obj: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  const fail = (message: string) => {
    send({ type: "error", message });
    ws.close(4000, message.slice(0, 100));
  };
  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = null;
  };

  // Nothing is watched until the token in the hello checks out — same shape as
  // the terminal channel, including the timeout on a client that never speaks.
  const helloTimeout = setTimeout(() => fail("hello timeout"), 10_000);
  helloTimeout.unref?.();

  ws.once("message", (raw, isBinary) => {
    clearTimeout(helloTimeout);
    if (isBinary) return fail("expected hello");
    let hello: VaultWsHello;
    try {
      hello = JSON.parse(raw.toString("utf8"));
    } catch {
      return fail("bad hello");
    }
    if (hello.type !== "hello") return fail("bad hello");
    if (!tokenMatches(hello.token, opts)) return fail("forbidden");
    const vault = findVault(opts.configDir, hello.vault ?? "");
    if (!vault) return fail("unknown vault");
    if (!hub) return fail("watcher unavailable");

    unsubscribe = hub.subscribe(vault, (event: VaultWsEvent) => send(event));
    // The client's first move after connecting is to reconcile its file table
    // against a fresh scan; "reset" is exactly that instruction.
    send({ type: "reset", vault: vault.id } satisfies VaultWsEvent);
    opts.log(`[VAULT] watching ${vault.root}`);
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);
}
