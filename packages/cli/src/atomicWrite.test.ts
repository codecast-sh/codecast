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
const tmpLeftovers = (d: string): string[] => fs.readdirSync(d).filter((n) => n.endsWith(".tmp"));

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

/** Writers that publish whole files through the helper under test. */
const WRITER = `
import { atomicWriteFile } from "${path.resolve(import.meta.dir, "atomicWrite.ts")}";
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
  it("creates a missing directory tree, at 0700", () => {
    const nested = path.join(dir, "a", "b", "c", "config.json");
    atomicWriteFile(nested, "{}\n");
    expect(fs.readFileSync(nested, "utf8")).toBe("{}\n");
    expect(modeOf(path.join(dir, "a", "b", "c"))).toBe("700");
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
