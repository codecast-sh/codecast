/**
 * The daily canary (tr-1254's precheck): each outcome's exit code, read
 * through the Codex adapter's own read path over recorded payloads, and the
 * script's own wiring. The precheck skips only CANARY_EXIT.clean and
 * CANARY_EXIT.quiet, so a canary that crashes runs the trigger.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { json, type FakeCloudCall } from "../test-helpers/cloudFetch.js";
import { tmp } from "../test-helpers/cloudAgentFakes.js";
import { CODEX_NOW, codexAuthJson, codexFixture, whamFetch } from "../test-helpers/codexCloudFixtures.js";
import { CANARY_EXIT, runCanary, UNCHECKED_ALERT_MS } from "./canary.js";
import { CodexCloudAdapter } from "./codex.js";

const LIST = codexFixture<{ items: Array<{ id: string }> }>("list.json");
const ASK = codexFixture("turns.ask.json");
const VALID = codexAuthJson(CODEX_NOW / 1000 + 7 * 86400);
const SCRIPT = path.join(import.meta.dir, "..", "..", "scripts", "cloud-agent-canary.ts");

function codex(routes: Record<string, (c: FakeCloudCall) => Response>, readAuth: () => string | null = () => VALID) {
  return new CodexCloudAdapter({ readAuth, fetchImpl: whamFetch(routes).fetchImpl, now: () => CODEX_NOW });
}
const healthy = () => ({ "GET /tasks/list": json(LIST), [`GET /tasks/${LIST.items[0].id}/turns`]: json(ASK) });
const run = (adapter: CodexCloudAdapter, dir: string, now = CODEX_NOW) => runCanary([adapter], "codex", dir, now);

describe("cloud agent canary", () => {
  test("a clean read skips the run", async () => {
    const out = await run(codex(healthy()), tmp("canary-"));
    expect(out).toEqual({ code: CANARY_EXIT.clean, line: "Codex Cloud: list and one agent read cleanly" });
  });

  test("a mistyped list field and an unexpected 422 are the API changing: the run starts", async () => {
    const shape = await run(codex({ ...healthy(), "GET /tasks/list": json({ tasks: LIST.items }) }), tmp("canary-"));
    expect(shape.code).toBe(CANARY_EXIT.changed);
    expect(shape.line).toBe("Codex Cloud list: CHANGED: GET /tasks/list: items should be an array, got nothing");
    const unexpected = await run(codex({ ...healthy(), "GET /tasks/list": () => new Response(JSON.stringify({ detail: "Unprocessable" }), { status: 422 }) }), tmp("canary-"));
    expect(unexpected).toEqual({ code: CANARY_EXIT.changed, line: "Codex Cloud list: CHANGED: Unprocessable" });
  });

  test("a failure it does not recognize (a throw, no sign-in, an outage) is quiet, then runs the trigger once three days have passed, once per span", async () => {
    const dir = tmp("canary-");
    const throwing = codex(healthy(), () => { throw new Error("auth.json unreadable"); });
    const first = await run(throwing, dir);
    expect(first).toEqual({ code: CANARY_EXIT.quiet, line: "Codex Cloud sign-in: could not check: auth.json unreadable" });
    const signedOut = codex(healthy(), () => null);
    expect((await run(signedOut, dir, CODEX_NOW + UNCHECKED_ALERT_MS - 1)).code).toBe(CANARY_EXIT.quiet);
    const alert = await run(signedOut, dir, CODEX_NOW + UNCHECKED_ALERT_MS);
    expect(alert.code).toBe(CANARY_EXIT.changed);
    expect(alert.line).toEndWith("(no check got through for 3 days)");
    // Said once per span: the next day is quiet again.
    expect((await run(signedOut, dir, CODEX_NOW + UNCHECKED_ALERT_MS + 86_400_000)).code).toBe(CANARY_EXIT.quiet);
    const outage = codex({ ...healthy(), "GET /tasks/list": () => new Response("bad gateway", { status: 502 }) });
    expect((await run(outage, dir, CODEX_NOW + 2 * UNCHECKED_ALERT_MS)).code).toBe(CANARY_EXIT.changed);
    // A check that gets through ends the stretch.
    expect((await run(codex(healthy()), dir, CODEX_NOW + 2 * UNCHECKED_ALERT_MS + 1)).code).toBe(CANARY_EXIT.clean);
    expect(fs.existsSync(path.join(dir, "cloud-agent-canary", "codex.json"))).toBe(false);
  });

  test("the script exits with the canary's code, and the precheck runs the trigger on any other (a crash)", async () => {
    const dir = tmp("canary-script-");
    const proc = Bun.spawnSync(["bun", SCRIPT, "no-such-provider"], { env: { ...process.env, CODECAST_DIR: dir } });
    expect(proc.exitCode).toBe(CANARY_EXIT.quiet);
    expect(proc.stdout.toString()).toContain('no cloud agent provider "no-such-provider"');
    const gate = (code: number) => Bun.spawnSync(["sh", "-c", `(exit ${code}); case $? in 10|11) exit 1;; esac`]).exitCode;
    expect([CANARY_EXIT.changed, 1, CANARY_EXIT.clean, CANARY_EXIT.quiet].map(gate)).toEqual([0, 0, 1, 1]);
  }, 30_000);
});
