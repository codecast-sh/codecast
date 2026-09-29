import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeProjectDirName } from "../../projectPathResolver";
import { mergeMemoryIndex, pullHostMemory, type HostMemoryFile } from "./memoryBack";
import type { MirrorStamp } from "./apply";

let dir: string;
let laptop: string;
const hostHome = "/home/ubuntu";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memory-back-"))); laptop = path.join(dir, "laptop"); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const project = () => ({ host: "ubuntu@h", sourceRoot: `${laptop}/src/app`, targetRoot: `${hostHome}/work/app`, hostId: "i-1" });
const laptopMem = (name: string) => path.join(laptop, ".claude/projects", claudeProjectDirName(`${laptop}/src/app`), "memory", name);
const hostRel = (name: string) => `.claude/projects/${claudeProjectDirName(`${hostHome}/work/app`)}/memory/${name}`;
function writeLaptop(name: string, text: string, mtime?: number) {
  fs.mkdirSync(path.dirname(laptopMem(name)), { recursive: true });
  fs.writeFileSync(laptopMem(name), text);
  if (mtime) fs.utimesSync(laptopMem(name), mtime, mtime);
}
function reader(host: Record<string, { text: string; mtime?: number }>) {
  return async (dirs: string[], withContent: string[]): Promise<HostMemoryFile[]> =>
    Object.entries(host).filter(([rel]) => dirs.includes(path.posix.dirname(rel))).map(([rel, f]) => ({ rel, sha: sha(f.text), mtime: f.mtime ?? 1, ...(withContent.includes(rel) ? { content: f.text } : {}) }));
}
const stampOf = (files: Record<string, string>): MirrorStamp => ({ version: 1, hash: "h", source_device_id: "d", source_user_id: "u", applied_at: "", managed_roots: [], files: Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, { sha: sha(text), written: sha(text), mode: "0600" as const }])) });

test("a memory the host wrote comes home, its host paths rewritten; an unchanged one is left alone", async () => {
  writeLaptop("MEMORY.md", "- [A](a.md)\n");
  const n = await pullHostMemory({
    laptopHome: laptop, hostHome, projects: [project()], stamp: stampOf({ [hostRel("MEMORY.md")]: "- [A](a.md)\n" }),
    read: reader({ [hostRel("MEMORY.md")]: { text: "- [A](a.md)\n" }, [hostRel("b.md")]: { text: `Lives in ${hostHome}/work/app/src/b.ts\n` } }),
  });
  expect(n.written).toBe(1);
  expect(n.reconciled.map((r) => r.path)).toEqual([hostRel("b.md")]);
  expect(fs.readFileSync(laptopMem("b.md"), "utf-8")).toBe(`Lives in ${laptop}/src/app/src/b.ts\n`);
});

test("an edit only the host made replaces the laptop copy; when both edited, MEMORY.md keeps every line and other files keep the newer", async () => {
  const pushed = "- [A](a.md)\n";
  writeLaptop("MEMORY.md", "- [A](a.md)\n- [L](l.md)\n");
  writeLaptop("h.md", "h\n");
  writeLaptop("a.md", "pushed a\n");
  writeLaptop("c.md", "laptop c, newer\n", 2_000_000_000);
  const n = await pullHostMemory({
    laptopHome: laptop, hostHome, projects: [project()],
    stamp: stampOf({ [hostRel("MEMORY.md")]: pushed, [hostRel("a.md")]: "pushed a\n", [hostRel("c.md")]: "pushed c\n" }),
    read: reader({
      [hostRel("MEMORY.md")]: { text: "- [A](a.md)\n- [H](h.md)\n" },
      [hostRel("a.md")]: { text: "host a\n" },
      [hostRel("c.md")]: { text: "host c, older\n", mtime: 1_000_000_000 },
    }),
  });
  expect(n.written).toBe(2);
  expect(n.reconciled).toHaveLength(3);
  expect(fs.readFileSync(laptopMem("MEMORY.md"), "utf-8")).toBe("- [A](a.md)\n- [L](l.md)\n- [H](h.md)\n");
  expect(fs.readFileSync(laptopMem("a.md"), "utf-8")).toBe("host a\n");
  expect(fs.readFileSync(laptopMem("c.md"), "utf-8")).toBe("laptop c, newer\n");
});

test("the index takes only entries for memories the laptop's index does not link yet, never the host's old wording of one it does", () => {
  const laptopIndex = "- [Pipeline, rewritten here](pipeline.md)\n- [Kept](kept.md)\n";
  const hostIndex = "- [Pipeline, old wording](pipeline.md)\n- [Kept](kept.md)\n- [Deleted here](gone.md)\n- [New on host](new.md)\n- no link\n";
  expect(mergeMemoryIndex(laptopIndex, hostIndex, (f) => f !== "gone.md")).toBe(`${laptopIndex}- [New on host](new.md)\n`);
  expect(mergeMemoryIndex(laptopIndex, laptopIndex)).toBe(laptopIndex);
});
