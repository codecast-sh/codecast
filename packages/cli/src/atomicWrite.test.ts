import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { atomicWriteFile } from "./atomicWrite.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomicwrite-"));
  file = path.join(dir, "settings.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const modeOf = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8);
const inodeOf = (p: string): number => fs.statSync(p).ino;
const tmpLeftovers = (d: string): string[] => fs.readdirSync(d).filter((n) => n.endsWith(".tmp"));

/** Backdate a path past the sweep's staleness floor. */
const backdate = (p: string): void => {
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(p, old, old);
};

// ---------------------------------------------------------------------------
// Concurrency: the partial-file property is PROVEN, not asserted.
//
// Real writers and a real reader run in separate processes, because a torn read
// needs true parallelism — a single-process test with synchronous fs calls can
// never observe one. The reader classifies every sample it takes, and a control
// case (a deliberately torn writer) shows the same reader DOES catch tearing,
// so a clean run means the write was atomic and not that the reader was blind.
// ---------------------------------------------------------------------------

const SIZE = 1024 * 1024;

interface ReaderReport {
  reads: number;
  missing: number;
  partial: number;
  distinct: string[];
  sampleLengths: number[];
}

/** A reader that samples the file as fast as it can and classifies each sample. */
const READER = `
import * as fs from "fs";
const [file, sizeArg, msArg] = process.argv.slice(2);
const size = Number(sizeArg);
const deadline = Date.now() + Number(msArg);
const fills = new Map();
const fillFor = (c) => { let f = fills.get(c); if (!f) { f = c.repeat(size); fills.set(c, f); } return f; };
let reads = 0, missing = 0, partial = 0;
const distinct = new Set();
const sampleLengths = [];
while (Date.now() < deadline) {
  let content;
  try { content = fs.readFileSync(file, "utf8"); } catch { missing++; continue; }
  reads++;
  const head = content[0] ?? "";
  distinct.add(head);
  // A whole file is exactly one writer's payload: right length, one fill char.
  if (content.length !== size || content !== fillFor(head)) {
    partial++;
    if (sampleLengths.length < 5) sampleLengths.push(content.length);
  }
}
process.stdout.write(JSON.stringify({ reads, missing, partial, distinct: [...distinct], sampleLengths }));
`;

const HELPER = path.resolve(import.meta.dir, "atomicWrite.ts");

/** Writers that publish whole files through the helper under test. */
const WRITER = `
import { atomicWriteFile } from "${HELPER}";
const [file, char, sizeArg, msArg] = process.argv.slice(2);
const payload = char.repeat(Number(sizeArg));
const deadline = Date.now() + Number(msArg);
while (Date.now() < deadline) atomicWriteFile(file, payload);
`;

/**
 * Control writer: truncate in place, write half, pause, write the rest. This is
 * what an unprotected fs.writeFileSync looks like from a reader's side, and it
 * makes the torn window wide enough that the reader must see it.
 */
const TORN_WRITER = `
import * as fs from "fs";
const [file, char, sizeArg, msArg] = process.argv.slice(2);
const size = Number(sizeArg);
const half = char.repeat(size / 2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const deadline = Date.now() + Number(msArg);
while (Date.now() < deadline) {
  const fd = fs.openSync(file, "w", 0o600);
  fs.writeSync(fd, half);
  sleep(20);
  fs.writeSync(fd, half);
  fs.closeSync(fd);
  sleep(5);
}
`;

/** Writes a large payload forever, so a kill has a wide window to land inside. */
const ENDLESS_WRITER = `
import { atomicWriteFile } from "${HELPER}";
const payload = "x".repeat(32 * 1024 * 1024);
process.stdout.write("ready\\n");
while (true) atomicWriteFile(process.argv[2], payload);
`;

function script(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

function run(scriptPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
  });
}

async function observe(writerScript: string, chars: string[], ms: number): Promise<ReaderReport> {
  const readerPath = script("reader.mjs", READER);
  const writerPath = script("writer.mjs", writerScript);
  // Pre-create the file so an ENOENT read can only mean the publish step
  // unlinked the path — which rename never does.
  fs.writeFileSync(file, chars[0].repeat(SIZE));
  const reader = run(readerPath, [file, String(SIZE), String(ms + 300)]);
  const writers = chars.map((c) => run(writerPath, [file, c, String(SIZE), String(ms)]));
  const [out] = await Promise.all([reader, ...writers]);
  return JSON.parse(out) as ReaderReport;
}

/**
 * SIGKILL a writer until one dies mid write, the way an OOM kill would, and
 * return the temp files it stranded. Retried because where the kill lands is a
 * race: a kill between two write cycles strands nothing and proves nothing.
 */
async function strandTempsByKilling(target: string): Promise<string[]> {
  const writerPath = script("endless.mjs", ENDLESS_WRITER);
  for (let attempt = 0; attempt < 10; attempt++) {
    const child = spawn(process.execPath, [writerPath, target], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    await new Promise((r) => setTimeout(r, 120 + attempt * 40));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const stranded = tmpLeftovers(path.dirname(target));
    if (stranded.length > 0) return stranded;
  }
  throw new Error("could not catch a writer mid write after 10 kills");
}

describe("atomicWriteFile — concurrency", () => {
  it("control: the reader DOES catch a torn write (proves the detector works)", async () => {
    const report = await observe(TORN_WRITER, ["x"], 1000);
    console.log("torn control:", JSON.stringify(report));
    expect(report.reads).toBeGreaterThan(10);
    expect(report.partial).toBeGreaterThan(0);
  }, 20000);

  it("interleaved writers never let a reader observe a partial file", async () => {
    const report = await observe(WRITER, ["a", "b", "c"], 1500);
    console.log("atomic writers:", JSON.stringify({ ...report, sampleLengths: report.sampleLengths }));
    expect(report.partial).toBe(0);
    // The reader has to have sampled during the churn for the zero to mean
    // anything: many reads, and payloads from more than one writer.
    expect(report.reads).toBeGreaterThan(100);
    expect(report.distinct.length).toBeGreaterThan(1);
    // rename() replaces the path in one step, so the file is never absent.
    expect(report.missing).toBe(0);
  }, 20000);
});

describe("atomicWriteFile — publish step", () => {
  // The mode tests below only mean something if the file was really published by
  // rename; a plain fs.writeFileSync preserves an existing mode for free. This
  // pins the mechanism they rely on.
  it("publishes a NEW inode — the bytes are never written into the live file", () => {
    fs.writeFileSync(file, "old");
    const before = inodeOf(file);
    atomicWriteFile(file, "new");
    expect(inodeOf(file)).not.toBe(before);
    expect(fs.readFileSync(file, "utf8")).toBe("new");
  });

  it("names the target, not the temp path, when the target is a directory", () => {
    // Raw node reports the failure against the temp path, which tells the user
    // nothing about the argument they passed. Asserted on the wrapper's own
    // words, not the errno: rename-onto-a-directory is ENOTDIR on macOS and
    // EISDIR on linux.
    const blocked = path.join(dir, "blocked");
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, "child"), "keeps the dir non-empty");
    expect(() => atomicWriteFile(blocked, "payload")).toThrow(
      new RegExp(`cannot publish ${blocked}.*not a directory, and that ${dir} is writable`, "s"),
    );
  });
});

describe("atomicWriteFile — symlinked config files", () => {
  // ~/.claude/settings.json and ~/.codex/config.toml are commonly symlinks into
  // a dotfiles repo. Renaming over the link would strand the repo's real file.
  const dotfilesSetup = (): { real: string; link: string } => {
    const repo = path.join(dir, "dotfiles");
    fs.mkdirSync(repo);
    const real = path.join(repo, "settings.json");
    const link = path.join(dir, "settings.json");
    fs.writeFileSync(real, "old");
    fs.symlinkSync(real, link);
    return { real, link };
  };

  it("writes THROUGH a symlink and leaves the link intact", () => {
    const { real, link } = dotfilesSetup();
    atomicWriteFile(link, "new");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe("new");
    expect(fs.readFileSync(link, "utf8")).toBe("new");
    // The temp file belongs beside the real file, not beside the link.
    expect(tmpLeftovers(path.dirname(real))).toEqual([]);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("keeps writing through the link on the second write", () => {
    const { real, link } = dotfilesSetup();
    atomicWriteFile(link, "first");
    atomicWriteFile(link, "second");
    // The bug this guards: write one replaces the link, so write two lands in a
    // regular file and the repo copy freezes at "first".
    expect(fs.readFileSync(real, "utf8")).toBe("second");
  });

  it("keeps the real file's mode, not the link's", () => {
    const { real, link } = dotfilesSetup();
    fs.chmodSync(real, 0o644);
    atomicWriteFile(link, "new");
    expect(modeOf(real)).toBe("644");
  });

  it("follows a chain of links to the file at the end", () => {
    const { real, link } = dotfilesSetup();
    const outer = path.join(dir, "outer.json");
    fs.symlinkSync(link, outer);
    atomicWriteFile(outer, "new");
    expect(fs.lstatSync(outer).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe("new");
  });

  it("creates the file a dangling link points at, rather than replacing the link", () => {
    const missing = path.join(dir, "nested", "config.json");
    const link = path.join(dir, "config.json");
    fs.symlinkSync(missing, link);
    atomicWriteFile(link, "{}\n");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(missing, "utf8")).toBe("{}\n");
  });

  it("resolves a relative link against the link's own directory", () => {
    const repo = path.join(dir, "dotfiles");
    fs.mkdirSync(repo);
    const real = path.join(repo, "settings.json");
    fs.writeFileSync(real, "old");
    fs.symlinkSync(path.join("dotfiles", "settings.json"), file);
    atomicWriteFile(file, "new");
    expect(fs.readFileSync(real, "utf8")).toBe("new");
  });

  it("refuses a symlink loop and says how to break it", () => {
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "b.json");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(() => atomicWriteFile(a, "x")).toThrow(/symlink loop.*repoint or delete/s);
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("cannot preserve a hardlink — a documented limit of publishing by rename", () => {
    fs.writeFileSync(file, "old");
    const other = path.join(dir, "other.json");
    fs.linkSync(file, other);
    atomicWriteFile(file, "new");
    // rename swaps the directory entry, so the second name keeps the old inode.
    // Pinned so nobody later claims the helper is hardlink-safe.
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(fs.readFileSync(other, "utf8")).toBe("old");
    expect(fs.statSync(file).nlink).toBe(1);
  });
});

describe("atomicWriteFile — permissions", () => {
  it("keeps the mode of an existing 0600 file when overwriting it", () => {
    fs.writeFileSync(file, "old");
    fs.chmodSync(file, 0o600);
    atomicWriteFile(file, "new");
    expect(modeOf(file)).toBe("600");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
  });

  it("keeps a wider existing mode too — a rewrite must not silently narrow settings.json", () => {
    fs.writeFileSync(file, "old");
    fs.chmodSync(file, 0o644);
    atomicWriteFile(file, "new");
    expect(modeOf(file)).toBe("644");
  });

  it("defaults a brand new file to 0600", () => {
    atomicWriteFile(file, "secret");
    expect(modeOf(file)).toBe("600");
  });

  it("applies an explicit mode exactly, defeating the umask", () => {
    const previous = process.umask(0o022);
    try {
      atomicWriteFile(file, "x", { mode: 0o666 });
      // Without the explicit fchmod, umask 022 would land this at 0644.
      expect(modeOf(file)).toBe("666");
    } finally {
      process.umask(previous);
    }
  });

  it("an explicit mode overrides the existing file's mode", () => {
    fs.writeFileSync(file, "old");
    fs.chmodSync(file, 0o644);
    atomicWriteFile(file, "new", { mode: 0o600 });
    expect(modeOf(file)).toBe("600");
  });
});

describe("atomicWriteFile — directories and cleanup", () => {
  it("creates a private directory tree for a private file", () => {
    const nested = path.join(dir, "a", "b", "c", "config.json");
    atomicWriteFile(nested, "{}\n");
    expect(fs.readFileSync(nested, "utf8")).toBe("{}\n");
    expect(modeOf(path.join(dir, "a", "b", "c"))).toBe("700");
  });

  it("widens the directory with the file — a 0644 file needs a traversable directory", () => {
    // A 0700 directory would make a 0644 config unreadable by anyone but the
    // owner, which silently defeats the mode the caller asked for.
    const nested = path.join(dir, "proj", ".mcp.json");
    atomicWriteFile(nested, "{}\n", { mode: 0o644 });
    expect(modeOf(nested)).toBe("644");
    expect(modeOf(path.join(dir, "proj"))).toBe("755");
  });

  it("leaves no .tmp behind when the write throws", () => {
    // A directory at the target path makes the publishing rename fail, which is
    // the failure that happens after the temp file already exists on disk.
    const blocked = path.join(dir, "blocked");
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, "child"), "keeps the dir non-empty");
    expect(() => atomicWriteFile(blocked, "payload")).toThrow();
    expect(tmpLeftovers(dir)).toEqual([]);
  });

  it("leaves no .tmp behind when the content itself is unwritable", () => {
    expect(() => atomicWriteFile(file, { not: "bytes" } as unknown as string)).toThrow();
    expect(tmpLeftovers(dir)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves no .tmp behind after a successful write", () => {
    atomicWriteFile(file, "ok");
    expect(tmpLeftovers(dir)).toEqual([]);
  });
});

describe("atomicWriteFile — sweeping temps stranded by a kill", () => {
  it("clears the corpse a SIGKILLed writer left, but only once it is stale", async () => {
    const corpses = await strandTempsByKilling(file);
    console.log("corpses left by SIGKILL:", corpses);

    // Fresh corpses are untouchable: at this age the file is indistinguishable
    // from a live concurrent writer's temp, and deleting that would be the bug.
    atomicWriteFile(file, "ok");
    expect(tmpLeftovers(dir)).toEqual(corpses);

    corpses.forEach((n) => backdate(path.join(dir, n)));
    atomicWriteFile(file, "ok again");
    expect(tmpLeftovers(dir)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("ok again");
  }, 30000);

  it("sweeps only its own temp shape, never a lookalike the user owns", () => {
    // Real corpse names carry pid.uuid; these do not, so they are somebody
    // else's files and deleting them would be data loss.
    const keep = [
      ".settings.json.tmp", // the shape ccAccounts/vaultRegistry write today
      ".settings.json.1234.tmp",
      ".settings.json.notapid.6d1f0c0a-0000-4000-8000-000000000000.tmp",
      "settings.json.99.6d1f0c0a-0000-4000-8000-000000000000.tmp", // no leading dot
      ".other.json.99.6d1f0c0a-0000-4000-8000-000000000000.tmp", // another file's temp
    ];
    for (const n of keep) {
      fs.writeFileSync(path.join(dir, n), "not ours");
      backdate(path.join(dir, n));
    }
    const ours = path.join(dir, ".settings.json.99.6d1f0c0a-0000-4000-8000-000000000000.tmp");
    fs.writeFileSync(ours, "ours");
    backdate(ours);

    atomicWriteFile(file, "ok");

    expect(fs.existsSync(ours)).toBe(false);
    expect(tmpLeftovers(dir).sort()).toEqual([...keep].sort());
  });

  it("sweeps in the directory of the real file when the target is a symlink", () => {
    const repo = path.join(dir, "dotfiles");
    fs.mkdirSync(repo);
    const real = path.join(repo, "settings.json");
    fs.writeFileSync(real, "old");
    fs.symlinkSync(real, file);
    const corpse = path.join(repo, ".settings.json.99.6d1f0c0a-0000-4000-8000-000000000000.tmp");
    fs.writeFileSync(corpse, "stranded");
    backdate(corpse);

    atomicWriteFile(file, "new");
    expect(fs.existsSync(corpse)).toBe(false);
  });

  // Root ignores permission bits, so the unreadable directory below would not
  // actually break the sweep and the test would prove nothing.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(asRoot)("a sweep failure never costs a write that already succeeded", () => {
    // The published bytes are the contract; a directory the sweep cannot read is
    // not a reason to fail the caller.
    atomicWriteFile(file, "first");
    fs.chmodSync(dir, 0o300); // write+execute, but not readable: readdir fails
    try {
      expect(() => atomicWriteFile(file, "second")).not.toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe("second");
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe("atomicWriteFile — payloads", () => {
  it("round-trips text and bytes", () => {
    atomicWriteFile(file, "héllo\n");
    expect(fs.readFileSync(file, "utf8")).toBe("héllo\n");
    atomicWriteFile(file, new Uint8Array([0, 1, 2, 255]));
    expect([...fs.readFileSync(file)]).toEqual([0, 1, 2, 255]);
  });

  it("writes bytes verbatim — no trailing newline of its own", () => {
    // providerKeyStore dedupes a device push by exact content, so the helper
    // must never add or trim a byte the caller did not write.
    const exact = '{"a":1}';
    atomicWriteFile(file, exact);
    expect(fs.readFileSync(file, "utf8")).toBe(exact);
  });
});
