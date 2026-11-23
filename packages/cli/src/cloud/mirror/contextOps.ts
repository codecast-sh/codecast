// The file and git operations a project-context walk yields (discovery.ts), run
// synchronously or asynchronously; split from discovery.ts, unchanged.
import * as fs from "node:fs";
import { execFile, spawn, spawnSync } from "../../proc.js";

export type ContextOperation = { op: "lstat" | "realpath" | "readlink" | "stat" | "readdir" | "prefix" | "bytes" | "tracked" | "inRepo"; path: string };
export type ContextSteps<T> = Generator<ContextOperation, T, any>;



// `ls-files -s` lines: "<mode> <object> <stage>\t<path>"; 120000 is a symlink.
const indexEntry = (line: string) => ({ path: line.slice(line.indexOf("\t") + 1), link: line.startsWith("120000 ") });

function trackedFiles(stdout: string, stderr: string, code: number | null): Array<{ path: string; link: boolean }> {
  if (code !== 0 && !stderr.includes("not a git repository")) throw new Error(`project context git enumeration failed (exit ${code})`);
  return code === 0 ? stdout.split("\0").filter(Boolean).map(indexEntry) : [];
}

export function executeContextSync(op: ContextOperation): unknown {
  if (op.op === "lstat") return fs.lstatSync(op.path, { throwIfNoEntry: false });
  if (op.op === "realpath") return fs.realpathSync(op.path);
  if (op.op === "readlink") return fs.readlinkSync(op.path);
  if (op.op === "stat") return fs.statSync(op.path);
  if (op.op === "readdir") return fs.readdirSync(op.path);
  if (op.op === "inRepo") return spawnSync("git", ["-C", op.path, "rev-parse", "--git-dir"], { stdio: "ignore", timeout: 30_000 }).status === 0;
  if (op.op === "tracked") {
    // About 90 bytes a tracked file: room for several million.
    const r = spawnSync("git", ["-C", op.path, "ls-files", "-s", "-z"], { encoding: "utf8", timeout: 30_000, maxBuffer: 512 * 1024 * 1024 });
    if (r.error) throw r.error;
    return trackedFiles(r.stdout, r.stderr, r.status);
  }
  const fd = fs.openSync(op.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (op.op === "bytes") return fs.readFileSync(fd);
    const prefix = Buffer.alloc(4);
    fs.readSync(fd, prefix, 0, 4, 0);
    return prefix;
  } finally { fs.closeSync(fd); }
}

export async function executeContextAsync(op: ContextOperation): Promise<unknown> {
  if (op.op === "lstat") return fs.promises.lstat(op.path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; return undefined; });
  if (op.op === "realpath") return fs.promises.realpath(op.path);
  if (op.op === "readlink") return fs.promises.readlink(op.path);
  if (op.op === "stat") return fs.promises.stat(op.path);
  if (op.op === "readdir") return fs.promises.readdir(op.path);
  if (op.op === "inRepo") return new Promise((resolve) => { execFile("git", ["-C", op.path, "rev-parse", "--git-dir"], { timeout: 30_000 }, (err) => resolve(!err)); });
  // Streamed and parsed as it arrives, so no repo is too large to list.
  if (op.op === "tracked") return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", op.path, "ls-files", "-s", "-z"], { stdio: ["ignore", "pipe", "pipe"] });
    const entries: Array<{ path: string; link: boolean }> = [];
    let rest = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\0");
      rest = lines.pop()!;
      for (const line of lines) if (line) entries.push(indexEntry(line));
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stderr.includes("not a git repository")) { reject(new Error("project context git enumeration failed")); return; }
      resolve(code === 0 ? entries : []);
    });
  });
  const fd = await fs.promises.open(op.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (op.op === "bytes") return await fd.readFile();
    const prefix = Buffer.alloc(4);
    await fd.read(prefix, 0, 4, 0);
    return prefix;
  } finally { await fd.close(); }
}
