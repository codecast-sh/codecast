/**
 * Loopback routes that let the web's project picker see the local disk:
 *
 *   GET  /fs/dirs?path=<dir>   → the directories directly inside <dir>
 *   POST /fs/mkdir {path}      → create a project folder (and `git init` it)
 *
 * Mounted on the daemon's hook server next to the terminal, vault and browser
 * routes, behind the same envelope of an allowed origin plus the daemon's
 * persisted loopback token (authorizeLocalRequest). The web reaches this
 * server through get_terminal_endpoint discovery, which only ever resolves to
 * the daemon on the machine the browser is physically on — so "autocomplete
 * from the file system" is by construction the file system the session will
 * actually start in.
 *
 * `~` and `~/…` resolve against the daemon's home. Dot directories are only
 * listed when asked for by name (`showHidden`), the same rule a shell's tab
 * completion follows. Every entry also says whether it is a git repository
 * (a `.git` inside), which is what the picker uses to rank projects above
 * plain folders.
 */

import type http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "../proc.js";
import { authorizeLocalRequest, corsHeaders, type TerminalServerOptions } from "../terminal/terminalServer.js";

export interface DirEntry {
  name: string;
  path: string;
  /** A `.git` lives directly inside — the folder is a repository root. */
  repo: boolean;
}

export interface DirListing {
  home: string;
  /** The absolute directory that was listed. */
  path: string;
  /** False when `path` is not a directory; `dirs` is then empty. */
  exists: boolean;
  dirs: DirEntry[];
}

// A listing is one readdir plus one stat per child; a directory with thousands
// of children (node_modules, a photo library) must not turn one keystroke into
// thousands of stats. The picker shows a dozen at most anyway.
const MAX_ENTRIES = 200;
const MAX_BODY_BYTES = 4 * 1024;

export interface BrowseDeps {
  home: () => string;
  readdir: (dir: string) => Promise<fs.Dirent[]>;
  isDir: (p: string) => Promise<boolean>;
  mkdir: (p: string) => Promise<void>;
  gitInit: (p: string) => Promise<void>;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export const defaultBrowseDeps: BrowseDeps = {
  home: () => os.homedir(),
  readdir: (dir) => fs.promises.readdir(dir, { withFileTypes: true }),
  isDir: isDirectory,
  mkdir: async (p) => {
    await fs.promises.mkdir(p, { recursive: true });
  },
  // Best effort: a machine without git still gets its folder.
  gitInit: (p) =>
    new Promise((resolve) => {
      execFile("git", ["init", "-q"], { cwd: p, timeout: 10_000 }, () => resolve());
    }),
};

/** Expand `~` and make the path absolute. Returns null for anything that is
 *  not an absolute or home-relative path — a bare name has no meaning here. */
export function resolveBrowsePath(raw: string, home: string): string | null {
  const s = raw.trim();
  let abs: string;
  if (s === "~" || s.startsWith("~/")) abs = home + s.slice(1);
  else if (s.startsWith("/")) abs = s;
  else return null;
  abs = path.posix.normalize(abs);
  if (abs.length > 1) abs = abs.replace(/\/$/, "");
  return abs;
}

export async function listDirectories(
  rawPath: string,
  showHidden: boolean,
  deps: BrowseDeps = defaultBrowseDeps,
): Promise<DirListing | null> {
  const home = deps.home();
  const dir = resolveBrowsePath(rawPath, home);
  if (!dir) return null;
  if (!(await deps.isDir(dir))) return { home, path: dir, exists: false, dirs: [] };

  let entries: fs.Dirent[];
  try {
    entries = await deps.readdir(dir);
  } catch {
    return { home, path: dir, exists: false, dirs: [] };
  }
  const names = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && (showHidden || !e.name.startsWith(".")))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_ENTRIES);

  const dirs = await Promise.all(
    names.map(async (name) => {
      const full = path.join(dir, name);
      // A symlink is listed only when it points at a directory.
      if (!(await deps.isDir(full))) return null;
      return { name, path: full, repo: await deps.isDir(path.join(full, ".git")) };
    }),
  );
  return { home, path: dir, exists: true, dirs: dirs.filter((d): d is DirEntry => d !== null) };
}

export async function createProjectDir(
  rawPath: string,
  deps: BrowseDeps = defaultBrowseDeps,
): Promise<{ path: string; created: boolean } | null> {
  const home = deps.home();
  const dir = resolveBrowsePath(rawPath, home);
  if (!dir || dir === "/" || dir === home) return null;
  const existed = await deps.isDir(dir);
  if (!existed) {
    await deps.mkdir(dir);
    await deps.gitInit(dir);
  }
  return { path: dir, created: !existed };
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * HTTP endpoints for disk browsing, mounted on the daemon's loopback hook
 * server. Returns true when the request was handled.
 */
export function handleFsBrowseHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: TerminalServerOptions,
  deps: BrowseDeps = defaultBrowseDeps,
): boolean {
  const url = req.url ?? "";
  if (!url.startsWith("/fs/")) return false;
  const headers = { "Content-Type": "application/json", ...corsHeaders(req.headers.origin, opts) };
  const send = (status: number, body: unknown) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return true;
  }
  if (!authorizeLocalRequest(req, opts)) {
    send(403, { error: "forbidden" });
    return true;
  }

  const parsed = new URL(url, "http://localhost");
  const dispatch = async (): Promise<void> => {
    if (req.method === "GET" && parsed.pathname === "/fs/dirs") {
      const listing = await listDirectories(
        parsed.searchParams.get("path") ?? "~",
        parsed.searchParams.get("hidden") === "1",
        deps,
      );
      return listing ? send(200, listing) : send(400, { error: "path must be absolute or ~-relative" });
    }
    if (req.method === "POST" && parsed.pathname === "/fs/mkdir") {
      const body = await readJsonBody(req);
      const target = typeof body?.path === "string" ? body.path : "";
      const made = await createProjectDir(target, deps);
      if (!made) return send(400, { error: "path must be absolute or ~-relative" });
      if (made.created) opts.log(`[FS] Created project folder ${made.path}`);
      return send(200, made);
    }
    send(404, { error: "not found" });
  };

  void dispatch().catch((err) => {
    opts.log(`[FS] ${req.method} ${url} failed: ${(err as Error)?.message ?? err}`);
    if (!res.headersSent) send(500, { error: "server error" });
    else res.end();
  });
  return true;
}
