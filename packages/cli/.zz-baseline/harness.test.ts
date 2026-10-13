import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  editHarnessJson,
  markHarnessChangesSent,
  readHarnessChanges,
  removeHarnessFile,
  unsentHarnessChanges,
  withHarnessCause,
  writeHarnessFile,
} from "./harness.js";

let dir: string;
let prevLedger: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ledger-"));
  prevLedger = process.env.CODECAST_HARNESS_LEDGER;
  process.env.CODECAST_HARNESS_LEDGER = path.join(dir, "changes.jsonl");
});

afterEach(() => {
  process.env.CODECAST_HARNESS_LEDGER = prevLedger;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeHarnessFile", () => {
  test("records a real change and skips identical bytes", () => {
    const file = path.join(dir, "CLAUDE.md");
    expect(writeHarnessFile(file, "a\n", "section:memory")).toBe(true);
    expect(writeHarnessFile(file, "a\n", "section:memory")).toBe(false);
    expect(writeHarnessFile(file, "b\n", "section:memory")).toBe(true);
    expect(readHarnessChanges().map((c) => c.action)).toEqual(["modified", "created"]);
  });

  test("keeps the mode the user gave an existing file", () => {
    const file = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    writeHarnessFile(file, "new", "section:memory", { mode: 0o600 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  test("attributes a write to the scoped cause", () => {
    const file = path.join(dir, "x");
    withHarnessCause({ why: "a team turned chat on", automatic: true }, () => writeHarnessFile(file, "1", "section:chat"));
    const [c] = readHarnessChanges();
    expect(c.why).toBe("a team turned chat on");
    expect(c.automatic).toBe(true);
  });
});

describe("editHarnessJson", () => {
  test("keeps the file's indent, and a no-op edit writes nothing", () => {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ model: "opus" }, null, 4));
    expect(editHarnessJson(file, "model", (s) => { s.model = "opus"; })).toBe(false);
    expect(editHarnessJson(file, "model", (s) => { s.model = "sonnet"; })).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe('{\n    "model": "sonnet"\n}\n');
  });

  test("never overwrites a file it cannot parse", () => {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{ not json");
    expect(editHarnessJson(file, "hooks", (s) => { s.hooks = {}; })).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("{ not json");
  });
});

describe("unsent changes", () => {
  test("oldest first, and gone once the server took them", () => {
    writeHarnessFile(path.join(dir, "a"), "1", "hooks");
    removeHarnessFile(path.join(dir, "a"), "hooks");
    const unsent = unsentHarnessChanges();
    expect(unsent.map((c) => c.action)).toEqual(["created", "removed"]);
    markHarnessChangesSent(unsent);
    expect(unsentHarnessChanges()).toEqual([]);
  });
});
