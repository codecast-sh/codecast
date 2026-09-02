// The load mode's spawner: the doctor stub under the messaging harness's
// command override. Real tmux, no daemon, no Convex, so it runs in CI.
import { describe, expect, test, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { hasTmux, tmuxRun } from "../tmux.js";
import { STUB_SOURCE, resolveStubRuntime } from "../doctor.js";
import { spawnHarness, sweepStaleSessions, waitFor, readJsonlMessages, type Harness } from "../test-helpers/messagingHarness.js";

const runtime = resolveStubRuntime();
const prefix = `cc-claude-test-benchload-${randomBytes(3).toString("hex")}`;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

describe.skipIf(!hasTmux() || !runtime)("bench load spawner", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bench-load-"));
  const stubPath = path.join(cwd, "stub.cjs");
  fs.writeFileSync(stubPath, STUB_SOURCE);
  const harnesses: Harness[] = [];
  const registryPaths: string[] = [];

  afterAll(() => {
    for (const h of harnesses) { try { h.tearDown(); } catch {} }
    sweepStaleSessions(prefix);
    for (const p of registryPaths) { try { fs.rmSync(p, { force: true }); } catch {} }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("two stub panes register, bootstrap their transcripts, and tear down clean", async () => {
    for (let i = 0; i < 2; i++) {
      const sessionId = randomUUID();
      const jsonlPath = path.join(cwd, "transcripts", `${sessionId}.jsonl`);
      const registryPath = path.join(cwd, "registry", `${sessionId}.json`);
      registryPaths.push(registryPath);
      const command = `DOCTOR_BOOT_TOKEN='boot-${i}' exec ${q(runtime!)} ${q(stubPath)} ${q(sessionId)} ${q(jsonlPath)} ${q(registryPath)}`;
      harnesses.push(spawnHarness({ cwd, sessionId, jsonlPath, tmuxPrefix: prefix, command }));
    }
    expect(harnesses.every((h) => h.shimPath === "")).toBe(true);

    for (const [i, h] of harnesses.entries()) {
      const registryPath = registryPaths[i];
      await waitFor(() => fs.existsSync(registryPath) && fs.existsSync(h.jsonlPath), { timeoutMs: 15_000, label: "registry and transcript" });
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      expect(registry.term).toBe("tmux");
      expect(typeof registry.pid).toBe("number");
      const messages = readJsonlMessages(h.jsonlPath);
      expect(messages[0]?.type).toBe("user");
      expect(messages[0]?.text).toContain(`boot-${i}`);
      await waitFor(() => h.paneHasPrompt(), { timeoutMs: 15_000, label: "prompt glyph" });
    }

    for (const h of harnesses) h.tearDown();
    sweepStaleSessions(prefix);
    const left = tmuxRun(["list-sessions", "-F", "#{session_name}"]).stdout.split("\n").filter((n) => n.startsWith(prefix));
    expect(left).toEqual([]);
    expect(harnesses.some((h) => fs.existsSync(h.jsonlPath))).toBe(false);
  }, 60_000);
});
