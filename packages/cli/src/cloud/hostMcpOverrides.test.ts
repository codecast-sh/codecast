import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptyOverrides, hostMcpOverridesPath, maskPins, normalizeCommand, readHostMcpOverrides, reconcilePins, writeHostMcpOverrides } from "./hostMcpOverrides";

const homes: string[] = [];
const home = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-overrides-")); homes.push(dir); return dir; };
afterEach(() => { for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test("override ledger is atomic, private, and absent or malformed manifests mean no pins", () => {
  const root = home();
  expect(readHostMcpOverrides(root)).toEqual(emptyOverrides());
  const pins = reconcilePins(emptyOverrides(), "codex", [{ name: "computer", command: "/missing/app", args: ["--mcp"], status: "unsupported", reason: "macOS only" }], "now");
  writeHostMcpOverrides(root, pins);
  expect(readHostMcpOverrides(root)).toEqual(pins);
  expect(fs.statSync(hostMcpOverridesPath(root)).mode & 0o777).toBe(0o600);
  fs.writeFileSync(hostMcpOverridesPath(root), '{"version":1,"codex":{"bad":{"enabled":true}},"claude":{}}');
  expect(readHostMcpOverrides(root)).toEqual(emptyOverrides());
});

test("matching command pins survive; changed or absent commands drop only that harness's pins", () => {
  const codex = reconcilePins(emptyOverrides(), "codex", [{ name: "same", command: "tool", args: ["arg"], status: "unsupported" }, { name: "changed", command: "old", status: "unsupported" }, { name: "absent", command: "gone", status: "unsupported" }], "then");
  const both = reconcilePins(codex, "claude", [{ name: "claude", command: "claude-tool", status: "unsupported" }], "then");
  const masked = maskPins(both, "codex", { same: { command: "tool", args: ["arg"] }, changed: { command: "new" } });
  expect(masked.pinned).toEqual(["same"]);
  expect(masked.dropped).toEqual(["changed", "absent"]);
  expect(masked.next.claude).toEqual(both.claude);
  expect(Object.keys(both.codex)).toEqual(["same", "changed", "absent"]);
  expect(normalizeCommand({ command: "~/tool", args: ["$HOME/arg", "a   b"] })).toBe(`${process.env.HOME || os.homedir()}/tool ${process.env.HOME || os.homedir()}/arg a b`);
});

test("readiness removes recovered, missing-portable and absent pins without touching another harness", () => {
  const before = reconcilePins(emptyOverrides(), "codex", [{ name: "recovered", command: "ok", status: "unsupported" }, { name: "portable", command: "install", status: "unsupported" }, { name: "absent", command: "gone", status: "unsupported" }], "then");
  const after = reconcilePins(before, "codex", [{ name: "recovered", command: "ok", status: "ok" }, { name: "portable", command: "install", status: "missing_portable" }], "now");
  expect(after).toEqual(emptyOverrides());
});
