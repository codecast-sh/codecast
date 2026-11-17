import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HostReadinessReporter, readHostReadiness, runLimitHold } from "./hostReadiness";

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

describe("the run limit a host publishes", () => {
  const BOOT = Date.parse("2026-11-17T10:00:00Z");
  const files = (max: string | null, uptimeSec: number) => {
    const f = { max: path.join(dir, "max-run"), uptime: path.join(dir, "uptime") };
    if (max !== null) fs.writeFileSync(f.max, `${max}\n`);
    else fs.rmSync(f.max, { force: true });
    fs.writeFileSync(f.uptime, `${uptimeSec.toFixed(2)} 12345.67\n`);
    return f;
  };

  test("run_ends_at is the boot plus the limit, the same on every read within one boot", () => {
    const f = files("240", 600.37);
    const first = readHostReadiness(dir, undefined, BOOT + 600_370, f).run_ends_at;
    expect(first).toBe(BOOT + 240 * 60_000);
    fs.writeFileSync(f.uptime, "1800.91 1\n");
    expect(readHostReadiness(dir, undefined, BOOT + 1_800_910, f).run_ends_at).toBe(first);
  });

  test("no limit file, an empty one or a non-integer one publishes no field", () => {
    expect(readHostReadiness(dir, undefined, BOOT, files(null, 5))).not.toHaveProperty("run_ends_at");
    for (const bad of ["", "4h", "0", "-3", "1.5"]) expect(readHostReadiness(dir, undefined, BOOT, files(bad, 5))).not.toHaveProperty("run_ends_at");
  });

  test("a message is held under 10 minutes left, naming the limit, rechecked every minute", () => {
    const hold = (max: string | null, minutesIn: number) => runLimitHold(BOOT + minutesIn * 60_000 + 30_000, files(max, minutesIn * 60 + 30));
    expect(hold("240", 229)).toBeNull();
    expect(hold("240", 230)!.holdReason).toContain("in 9 min");
    const held = hold("240", 233)!;
    expect(held.holdReason).toBe("this host reaches its 4h run limit in 6 min; held until it restarts");
    expect(held.recheckMs).toBe(60_000);
    expect(hold("240", 239)!.holdReason).toContain("in 0 min");
    expect(hold(null, 233)).toBeNull();
  });

  test("a host still up at or past its declared limit gets its messages, and the daemon log hears of it once", () => {
    const logged: string[] = [];
    const at = (minutesIn: number) => runLimitHold(BOOT + minutesIn * 60_000, files("240", minutesIn * 60), (m) => logged.push(m));
    expect(at(239)).not.toBeNull();
    expect(at(240)).toBeNull();
    expect(at(245)).toBeNull();
    expect(at(300)).toBeNull();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("past its declared 240 min run limit");
  });

  test("the boot instant is taken once, so run_ends_at cannot move between two reads of one boot", () => {
    const f = files("240", 600.4);
    const first = readHostReadiness(dir, undefined, BOOT + 600_400, f).run_ends_at;
    fs.writeFileSync(f.uptime, "600.4 1\n");
    expect(readHostReadiness(dir, undefined, BOOT + 600_400 + 29_000, f).run_ends_at).toBe(first);
    expect(readHostReadiness(dir, undefined, BOOT + 600_400 + 31_000, f).run_ends_at).toBe(first);
  });
});
