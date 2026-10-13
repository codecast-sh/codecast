// The /memory/* routes on the daemon's loopback bridge: the Memory page reads
// and edits Claude Code memories (~/.claude/projects/<project>/memory) through
// them. Same envelope as /vault/* and /term/* (origin allowlist + the
// daemon's loopback bearer), and the same writers as the vault: a memory saved
// here is written temp-then-rename and a delete goes to the trash, never an
// unlink.
//
// A project is named by its directory under ~/.claude/projects and a memory
// by its bare file name; neither may carry a path separator, so nothing a
// request sends can point outside a memory folder.

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as http from "http";
import * as path from "path";
import {
  MEMORY_FILE_RE,
  MEMORY_INDEX_FILE,
  memoryIndexBudget,
  removeIndexLinesFor,
  type MemoryFile,
  type MemoryProject,
  type MemoryProjectSummary,
} from "@codecast/shared/memory";
import { authorizeLocalRequest, corsHeaders, type TerminalServerOptions } from "../terminal/terminalServer.js";
import { moveToTrash, writeVaultFile } from "../vault/vaultFs.js";
import { readBody, sendJson } from "../vault/vaultServer.js";
import { claudeProjectsDir } from "../syncScope.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface MemoryServerDeps {
  projectsDir: () => string;
}

const defaultDeps: MemoryServerDeps = { projectsDir: claudeProjectsDir };

class MemoryHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function memoryDir(deps: MemoryServerDeps, id: string | null): string {
  if (!id || id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw new MemoryHttpError(400, "bad project");
  }
  return path.join(deps.projectsDir(), id, "memory");
}

function memoryPath(deps: MemoryServerDeps, id: string | null, file: string | null): string {
  if (!file || !MEMORY_FILE_RE.test(file) || file.startsWith(".")) throw new MemoryHttpError(400, "bad file name");
  return path.join(memoryDir(deps, id), file);
}

/** The cwd a project's newest transcript recorded. The directory name is a
 *  lossy slug of it (every "/" and "." became "-"), so it is only the fallback. */
async function projectPath(projectDir: string, id: string): Promise<string> {
  try {
    const transcripts = (await fsp.readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
    const stats = await Promise.all(transcripts.map(async (f) => ({ f, m: (await fsp.stat(path.join(projectDir, f))).mtimeMs })));
    for (const { f } of stats.sort((a, b) => b.m - a.m).slice(0, 3)) {
      const handle = await fsp.open(path.join(projectDir, f));
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
        const cwd = buffer.subarray(0, bytesRead).toString("utf8").match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (cwd) return JSON.parse(`"${cwd[1]}"`);
      } finally {
        await handle.close();
      }
    }
  } catch {}
  return id.replace(/-/g, "/");
}

async function readMemoryFiles(dir: string): Promise<MemoryFile[]> {
  const names = (await fsp.readdir(dir)).filter((f) => MEMORY_FILE_RE.test(f) && !f.startsWith("."));
  const files = await Promise.all(
    names.map(async (file) => {
      const abs = path.join(dir, file);
      const [raw, stat] = await Promise.all([fsp.readFile(abs, "utf8"), fsp.stat(abs)]);
      return { file, raw, mtime: Math.round(stat.mtimeMs), bytes: stat.size };
    }),
  );
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export async function listMemoryProjects(deps: MemoryServerDeps = defaultDeps): Promise<MemoryProjectSummary[]> {
  const root = deps.projectsDir();
  const ids = await fsp.readdir(root).catch(() => [] as string[]);
  const rows = await Promise.all(
    ids.map(async (id): Promise<MemoryProjectSummary | null> => {
      const dir = path.join(root, id, "memory");
      const files = await readMemoryFiles(dir).catch(() => null);
      if (!files?.length) return null;
      const index = files.find((f) => f.file === MEMORY_INDEX_FILE);
      return {
        id,
        path: await projectPath(path.join(root, id), id),
        count: files.filter((f) => f.file !== MEMORY_INDEX_FILE).length,
        index: memoryIndexBudget(index?.raw ?? ""),
        updated: Math.max(...files.map((f) => f.mtime)),
      };
    }),
  );
  return rows.filter((r): r is MemoryProjectSummary => r !== null).sort((a, b) => b.count - a.count);
}

export async function readMemoryProject(id: string | null, deps: MemoryServerDeps = defaultDeps): Promise<MemoryProject> {
  const dir = memoryDir(deps, id);
  if (!fs.existsSync(dir)) throw new MemoryHttpError(404, "no such project");
  const all = await readMemoryFiles(dir);
  const index = all.find((f) => f.file === MEMORY_INDEX_FILE);
  return {
    id: id!,
    path: await projectPath(path.dirname(dir), id!),
    dir,
    files: all.filter((f) => f.file !== MEMORY_INDEX_FILE),
    index: { raw: index?.raw ?? "", mtime: index?.mtime ?? null },
  };
}

/**
 * Write one memory. `baseMtime` is the version the editor opened: a file that
 * changed since answers 409 with what is on disk now, so a stale tab never
 * overwrites a memory another session just wrote. `null` means create, and
 * refuses a name that already exists.
 */
export async function writeMemory(
  id: string | null,
  file: string | null,
  raw: string,
  baseMtime: number | null,
  deps: MemoryServerDeps = defaultDeps,
): Promise<{ file: string; mtime: number }> {
  const abs = memoryPath(deps, id, file);
  const current = await fsp.stat(abs).catch(() => null);
  if (baseMtime === null) {
    if (current) throw new MemoryHttpError(409, "a memory with that file name already exists");
    if (file !== MEMORY_INDEX_FILE && !fs.existsSync(path.dirname(path.dirname(abs)))) throw new MemoryHttpError(404, "no such project");
  } else if (!current) {
    throw new MemoryHttpError(409, "the file was deleted since it was opened", { current: null, mtime: null });
  } else if (Math.round(current.mtimeMs) !== Math.round(baseMtime)) {
    throw new MemoryHttpError(409, "the file changed on disk since it was opened", {
      current: await fsp.readFile(abs, "utf8"),
      mtime: Math.round(current.mtimeMs),
    });
  }
  const stat = await writeVaultFile(abs, raw);
  return { file: file!, mtime: Math.round(stat.mtimeMs) };
}

/** Move a memory to the trash, and optionally drop the index lines that point at it alone. */
export async function trashMemory(
  id: string | null,
  file: string | null,
  unindex: boolean,
  deps: MemoryServerDeps = defaultDeps,
): Promise<{ trashed: string; removedLines: number }> {
  if (file === MEMORY_INDEX_FILE) throw new MemoryHttpError(400, "refusing to delete the index");
  const abs = memoryPath(deps, id, file);
  if (!fs.existsSync(abs)) throw new MemoryHttpError(404, "not found");
  const trashed = moveToTrash(path.dirname(abs), abs);
  let removedLines = 0;
  const indexAbs = path.join(path.dirname(abs), MEMORY_INDEX_FILE);
  if (unindex && fs.existsSync(indexAbs)) {
    const next = removeIndexLinesFor(await fsp.readFile(indexAbs, "utf8"), file!);
    removedLines = next.removed;
    if (removedLines) await writeVaultFile(indexAbs, next.raw);
  }
  return { trashed, removedLines };
}

function parseJson(buf: Buffer | null): Record<string, unknown> {
  if (!buf) throw new MemoryHttpError(413, "too large");
  try {
    const parsed = JSON.parse(buf.toString("utf8"));
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {}
  throw new MemoryHttpError(400, "bad json");
}

/**
 * HTTP endpoints for the Memory page. Returns true when the request was
 * handled, the same contract as handleVaultHttp.
 */
export function handleMemoryHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: TerminalServerOptions,
  deps: MemoryServerDeps = defaultDeps,
): boolean {
  const url = req.url ?? "";
  if (!url.startsWith("/memory/")) return false;
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
  const q = (k: string) => parsed.searchParams.get(k);
  const route = `${req.method} ${parsed.pathname}`;
  const dispatch = async (): Promise<void> => {
    if (route === "GET /memory/projects") return sendJson(res, 200, headers, { projects: await listMemoryProjects(deps) });
    if (route === "GET /memory/project") return sendJson(res, 200, headers, await readMemoryProject(q("project"), deps));
    if (route === "PUT /memory/file") {
      const body = parseJson(await readBody(req, MAX_BODY_BYTES));
      if (typeof body.raw !== "string") throw new MemoryHttpError(400, "raw must be a string");
      const base = typeof body.baseMtime === "number" ? body.baseMtime : null;
      return sendJson(res, 200, headers, await writeMemory(q("project"), q("file"), body.raw, base, deps));
    }
    if (route === "POST /memory/op") {
      const body = parseJson(await readBody(req, MAX_BODY_BYTES));
      if (body.op !== "delete") throw new MemoryHttpError(400, "unknown op");
      const result = await trashMemory(String(body.project ?? ""), String(body.file ?? ""), body.unindex === true, deps);
      opts.log(`[MEMORY] trashed ${body.project}/${body.file} -> ${result.trashed}`);
      return sendJson(res, 200, headers, result);
    }
    sendJson(res, 404, headers, { error: "not found" });
  };
  dispatch().catch((err: unknown) => {
    if (res.headersSent) return;
    if (err instanceof MemoryHttpError) return sendJson(res, err.status, headers, { error: err.message, ...err.extra });
    opts.log(`[MEMORY] ${route} failed: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, headers, { error: "internal error" });
  });
  return true;
}
