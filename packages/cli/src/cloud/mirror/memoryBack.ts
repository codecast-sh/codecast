/**
 * Agent memory is the one part of the home mirror that is written on both
 * sides: a cloud session saves what it learned into its project's memory
 * directory on the host, and the laptop's sessions keep writing theirs. The
 * mirror is laptop to host, so without this the host's memories stayed there
 * and every push reported the host's MEMORY.md as a conflict.
 *
 * Before a push, this brings the host's memory home: for every registered
 * project (the main checkout and each cloud worktree), a memory file the host
 * created, or edited since the last push, is written into the laptop
 * project's memory directory with its host paths rewritten to the laptop's.
 * The push that follows then finds the host in step. When both sides changed
 * a file, MEMORY.md (an index of one line per memory) keeps every line from
 * both; any other file keeps the newer copy.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeProjectDirName } from "../../projectPathResolver.js";
import { sshBase, type RemoteHost } from "../../remote/session-move.js";
import { execFile } from "../../proc.js";
import { promisify } from "node:util";
import type { MirrorStamp } from "./apply.js";
import { projectPathMappings, type ProjectRegistration } from "./projectRefresh.js";
import { remapContextPaths } from "./transform.js";

const execFileAsync = promisify(execFile);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export interface HostMemoryFile { rel: string; sha: string; mtime: number; content?: string }

/** The host side: every memory *.md under the given home-relative dirs, with content when asked. */
export function hostMemoryScript(dirs: string[], withContent: string[] = []): string {
  return `python3 - <<'PY'
import hashlib, json, os, base64
home = os.path.expanduser("~")
want = set(${JSON.stringify(withContent)})
out = []
for d in ${JSON.stringify(dirs)}:
    full = os.path.join(home, d)
    try: names = sorted(os.listdir(full))
    except OSError: continue
    for n in names:
        p = os.path.join(full, n)
        if not n.endswith(".md") or os.path.islink(p) or not os.path.isfile(p): continue
        b = open(p, "rb").read()
        rel = d + "/" + n
        item = {"rel": rel, "sha": hashlib.sha256(b).hexdigest(), "mtime": os.stat(p).st_mtime}
        if rel in want: item["content"] = base64.b64encode(b).decode()
        out.append(item)
print(json.dumps(out))
PY`;
}

export type HostMemoryReader = (dirs: string[], withContent: string[]) => Promise<HostMemoryFile[]>;

export function sshMemoryReader(host: RemoteHost): HostMemoryReader {
  return async (dirs, withContent) => {
    const { stdout } = await execFileAsync("ssh", [...sshBase(host), `${host.user}@${host.address}`, hostMemoryScript(dirs, withContent)], { encoding: "utf-8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    const line = stdout.trim().split("\n").pop() ?? "[]";
    return (JSON.parse(line) as HostMemoryFile[]).map((f) => ({ ...f, ...(f.content !== undefined ? { content: Buffer.from(f.content, "base64").toString("utf-8") } : {}) }));
  };
}

/** The memory files a MEMORY.md line links to. */
function linkedFiles(line: string): string[] {
  return [...line.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => m[1]!);
}

/**
 * MEMORY.md from both sides. The host's copy is the laptop's index as it was
 * at the last push plus whatever its sessions added, so a line-by-line union
 * would bring back the old wording of every entry the laptop has since
 * rewritten. A host line joins only when it links to memories the laptop's
 * index does not link yet and that are here now (`present`): the entries a
 * cloud session wrote.
 */
export function mergeMemoryIndex(laptop: string, host: string, present: (file: string) => boolean = () => true): string {
  const linked = new Set(laptop.split("\n").flatMap(linkedFiles));
  const have = new Set(laptop.split("\n").map((l) => l.trimEnd()));
  const added = host.split("\n").map((l) => l.trimEnd()).filter((l) => {
    if (!l || have.has(l)) return false;
    const files = linkedFiles(l);
    return files.length > 0 && files.every((f) => !linked.has(f) && present(f));
  });
  if (!added.length) return laptop;
  return `${laptop.replace(/\n*$/, "\n")}${added.join("\n")}\n`;
}

export interface PullMemoryOptions {
  laptopHome: string;
  hostHome: string;
  projects: readonly ProjectRegistration[];
  stamp: MirrorStamp | null;
  read: HostMemoryReader;
  log?: (m: string) => void;
}

export interface PulledMemory {
  /** Laptop files written. */
  written: number;
  /** Host files the laptop has taken into account, at the version it saw: the next push may replace exactly those. */
  reconciled: Array<{ path: string; sha: string }>;
}

/** Bring the host's new and edited memories home. */
export async function pullHostMemory(opts: PullMemoryOptions): Promise<PulledMemory> {
  const live = opts.projects.filter((p) => !p.retired);
  if (!live.length) return { written: 0, reconciled: [] };
  const targets = new Map<string, ProjectRegistration>();
  for (const p of live) targets.set(`.claude/projects/${claudeProjectDirName(p.targetRoot)}/memory`, p);
  const listed = await opts.read([...targets.keys()], []);
  const changed = listed.filter((f) => {
    const entry = opts.stamp?.files[f.rel];
    return !entry || (entry.written !== f.sha && entry.sha !== f.sha);
  });
  if (!changed.length) return { written: 0, reconciled: [] };
  const bodies = await opts.read([...new Set(changed.map((f) => path.posix.dirname(f.rel)))], changed.map((f) => f.rel));
  let written = 0;
  const reconciled: PulledMemory["reconciled"] = [];
  // The index last, so the memories it links to are already here.
  bodies.sort((a, b) => Number(path.posix.basename(a.rel) === "MEMORY.md") - Number(path.posix.basename(b.rel) === "MEMORY.md"));
  for (const f of bodies) {
    if (f.content === undefined) continue;
    const project = targets.get(path.posix.dirname(f.rel))!;
    const toHost = { fromHome: opts.laptopHome, toHome: opts.hostHome, pathMappings: projectPathMappings(project, opts.laptopHome, opts.hostHome) };
    const toLaptop = { fromHome: opts.hostHome, toHome: opts.laptopHome, pathMappings: toHost.pathMappings.map((m) => ({ from: m.to, to: m.from })) };
    const name = path.posix.basename(f.rel);
    const dest = path.join(opts.laptopHome, ".claude", "projects", claudeProjectDirName(project.sourceRoot), "memory", name);
    const hostText = remapContextPaths(f.content, toLaptop);
    reconciled.push({ path: f.rel, sha: f.sha });
    let next = hostText;
    if (fs.existsSync(dest)) {
      const laptopText = fs.readFileSync(dest, "utf-8");
      if (laptopText === hostText) continue;
      const entry = opts.stamp?.files[f.rel];
      const laptopUnchanged = entry !== undefined && sha256(remapContextPaths(laptopText, toHost)) === entry.sha;
      if (!laptopUnchanged) {
        if (name === "MEMORY.md") next = mergeMemoryIndex(laptopText, hostText, (file) => fs.existsSync(path.join(path.dirname(dest), file)));
        else if (fs.statSync(dest).mtimeMs >= f.mtime * 1000) continue;
      }
      if (next === laptopText) continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.cast-memory-${process.pid}`;
    fs.writeFileSync(tmp, next, { mode: 0o644 });
    fs.renameSync(tmp, dest);
    written++;
    opts.log?.(`memory from the host: ${path.relative(opts.laptopHome, dest)}`);
  }
  return { written, reconciled };
}
