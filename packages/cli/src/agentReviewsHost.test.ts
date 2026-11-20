import { expect, test } from "bun:test";
import { rankAccounts, REVIEWS_DEFAULTS } from "./agentReviewsHost";

const NOW = Date.UTC(2026, 9, 21, 8, 41);
const HOUR = 3_600_000;
const cfg = { ...REVIEWS_DEFAULTS, slots: 18 };
const none = new Map<string, number>();

// Probed at 08:39, before the 5-hour window rolled at 08:40: that window is now unmeasured.
const rolled = (week: number) => ({
  fetched_at: NOW - 2 * 60_000,
  session: { percent: 40, resets_at: NOW - 60_000 },
  weekly: { percent: week, resets_at: NOW + 70 * HOUR },
});

test("a 5-hour window that rolled since the last probe does not hide a week at its stop", () => {
  expect(rankAccounts([{ name: "claude2", usage: rolled(85) }], cfg, none, none, NOW)).toEqual([]);
});

test("the same rollover on a week with room leaves the account open", () => {
  expect(rankAccounts([{ name: "fresh", usage: rolled(30) }], cfg, none, none, NOW)).toEqual(["fresh"]);
});

test("the profile this machine's sessions run on is never picked, even when the config names it", () => {
  expect(rankAccounts([{ name: "claude", active: true, usage: rolled(10) }], { ...cfg, accounts: ["claude"] }, none, none, NOW)).toEqual([]);
});

const windows = (session: number, week: number) => ({ fetched_at: NOW, session: { percent: session, resets_at: NOW + HOUR }, weekly: { percent: week, resets_at: NOW + 70 * HOUR } });

test("the week stops an account at 85%", () => {
  expect(rankAccounts([{ name: "a", usage: windows(10, 84) }, { name: "b", usage: windows(10, 85) }], cfg, none, none, NOW)).toEqual(["a"]);
});

test("the 5-hour window stops an account at 95%, not at the week's 85%", () => {
  expect(rankAccounts([{ name: "a", usage: windows(90, 20) }, { name: "b", usage: windows(95, 20) }], cfg, none, none, NOW)).toEqual(["a"]);
});

// The harness keeps only an allowlist of a session's env (prompt-dry-run.ts keepEnv). The judge's gateway variables
// must pass by name, or `./xrun` falls through to production, which the sandbox refuses (1 cause confirmed in 51, Nov 20).
test("a review session's env names the gateway's variables for the harness to pass, beside any already named", async () => {
  const { runEnv } = await import("./agentReviewsHost");
  const gateway = { XRUN_API_URL: "http://127.0.0.1:4100", XRUN_INTERNAL_KEY: "gateway" };
  const env = runEnv(gateway, "/opt/cast", { PATH: "/usr/bin", DRY_RUN_PASS_ENV: "STUB_URL" });
  expect(env.XRUN_API_URL).toBe("http://127.0.0.1:4100");
  expect(env.XRUN_INTERNAL_KEY).toBe("gateway");
  expect(env.DRY_RUN_PASS_ENV.split(",").sort()).toEqual(["STUB_URL", "XRUN_API_URL", "XRUN_INTERNAL_KEY"]);
  expect(env.PATH.startsWith("/opt/cast")).toBe(true);
  expect(runEnv({}, "/opt/cast", { PATH: "/usr/bin" }).DRY_RUN_PASS_ENV).toBeUndefined();
});

// The closed sandbox refuses every loopback port but the harness's own, so the gateway's port is passed as --allow-port
// (curl exit 7 from the judge's `./xrun`, Nov 20).
test("a review session may reach the gateway's loopback port, and only loopback ports", async () => {
  const { gatewayPorts } = await import("./agentReviewsHost");
  expect(gatewayPorts({ XRUN_API_URL: "http://127.0.0.1:4100", XRUN_INTERNAL_KEY: "gateway" })).toEqual([4100]);
  expect(gatewayPorts({ A: "http://localhost:5200/x", B: "http://127.0.0.1:5200" })).toEqual([5200]);
  expect(gatewayPorts({ XRUN_API_URL: "https://outreach-api.fly.dev", OTHER: "http://10.0.0.5:4100", K: "secret" })).toEqual([]);
});
