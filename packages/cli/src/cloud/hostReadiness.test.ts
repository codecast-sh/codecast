import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HostReadinessReporter, readHostReadiness } from "./hostReadiness";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-ready-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const put = (name: string, v: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(v));

test("readiness from the host's own files: mirror, tools, setup outcome, logins", () => {
  put("mirror.json", { complete: false, applied_at: "2026-09-29T10:00:00Z", files: { a: { sha: "1" }, b: { removed: true }, "work/x/MEMORY.md": { host_edited: true } } });
  put("host-tools.json", { ok: [{ tool: "gh" }, { tool: "bun" }], installed: [{ tool: "aws" }], missing: [{ tool: "osascript", referenced_by: "~/.claude/hooks/x.sh" }], at: "t" });
  put("host-setup.json", { hash: "h", at: "2026-09-29T09:00:00Z" });
  put("host-setup-last.json", { ok: false, step: "install bad", error: "E: Unable to locate package bad", at: "2026-09-29T11:00:00Z", packages: ["bad"], services: [], commands: 1 });
  put("agent-auth-origin.json", { files: { "~/.codex/auth.json": "d", "~/.config/gh/hosts.yml": "d", "~/.config/gcloud/credentials.db": "d", "~/.config/gcloud/access_tokens.db": "d" } });
  const r = readHostReadiness(dir, "1.1.160", 5);
  expect(r).toEqual({
    at: 5, cast_version: "1.1.160",
    mirror: { complete: false, files: 2, applied_at: "2026-09-29T10:00:00Z", host_edited: ["work/x/MEMORY.md"] },
    tools: { ok: 2, installed: 1, missing: [{ tool: "osascript", referenced_by: "~/.claude/hooks/x.sh" }], at: "t" },
    setup: { ok: false, applied_at: "2026-09-29T09:00:00Z", step: "install bad", error: "E: Unable to locate package bad", at: "2026-09-29T11:00:00Z", packages: ["bad"], services: [], commands: 1 },
    logins: ["codex", "gcloud", "gh"],
  });
});

test("the heartbeat carries readiness only when it changed, or every half hour", () => {
  put("host-tools.json", { ok: [{ tool: "gh" }], installed: [], missing: [] });
  const rep = new HostReadinessReporter(dir);
  expect(rep.next(1000)).toMatchObject({ tools: { ok: 1 } });
  expect(rep.next(2000)).toBeUndefined();
  put("host-tools.json", { ok: [{ tool: "gh" }, { tool: "aws" }], installed: [], missing: [] });
  fs.utimesSync(path.join(dir, "host-tools.json"), new Date(), new Date(Date.now() + 5000));
  expect(rep.next(3000)).toMatchObject({ tools: { ok: 2 } });
  expect(rep.next(3000 + 31 * 60_000)).toBeDefined();
});
