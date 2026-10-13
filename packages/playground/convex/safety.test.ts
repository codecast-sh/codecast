// Safety and limits (SPEC "Safety and limits") under convex-test: reports,
// the rate rules that bound what a free-to-mint visitor can do, the kill
// switch and budgets reaching triage, the counter prune, and a guard that
// every public function proves who is calling.
import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { mintVisitor } from "../src/lib/mint";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { APP_DAILY_BUDGET_USD, BUILD_CEILING_USD, GLOBAL_DAILY_BUDGET_USD, HERE_MAX, RATE, RATE_WINDOW_MAX_MS, REPORT_REASON_MAX, TRIAGE_CEILING_USD, VISITOR_DAILY_BUDGET_USD } from "./lib/limits";
import { PRESENCE } from "./lib/presence";
import { PROOF_BITS, PROOF_BITS_FLOOD, proofHolds, solveProof } from "./lib/proof";
import { newSecret, sha256Hex } from "./lib/identity";
import { TALLY, dayKey } from "./tallies";
import { chargeSpend } from "./builder/queue";
import { CROWD_FACES, insertPresence } from "./presence";

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./apps.ts": () => import("./apps"),
  "./builds.ts": () => import("./builds"),
  "./tallies.ts": () => import("./tallies"),
  "./http.ts": () => import("./http"),
  "./limits.ts": () => import("./limits"),
  "./messages.ts": () => import("./messages"),
  "./presence.ts": () => import("./presence"),
  "./reports.ts": () => import("./reports"),
  "./runtime.ts": () => import("./runtime"),
  "./versions.ts": () => import("./versions"),
  "./visitors.ts": () => import("./visitors"),
  "./builder/queue.ts": () => import("./builder/queue"),
  "./builder/run.ts": () => import("./builder/run"),
  "./builder/triage.ts": () => import("./builder/triage"),
};

async function setup() {
  const t = convexTest(schema, modules);
  const register = (args: { secret: string; nonce: number }) => t.mutation(api.visitors.register, args);
  const A = await mintVisitor(register);
  const B = await mintVisitor(register);
  const made = await t.mutation(api.apps.create, { ...A, name: "Tea Tally" });
  const app_id = made.app_id as Id<"apps">;
  const room = async () => (await t.query(api.messages.list, { ...A, app_id, paginationOpts: { numItems: 50, cursor: null } })).page;
  return { t, A, B, app_id, room };
}

/** Run `call` until it is rate limited; how many calls got through. */
async function allowedBefore(call: () => Promise<unknown>, cap: number): Promise<number> {
  for (let n = 0; n < cap; n++) {
    try {
      await call();
    } catch (e) {
      expect(String(e)).toMatch(/rate_limited/);
      return n;
    }
  }
  return cap;
}

describe("reporting an app", () => {
  test("stores one report per visitor, with the version on screen and a one-line reason", async () => {
    const s = await setup();
    const reason = `  phishing\n for   passwords ${"x".repeat(REPORT_REASON_MAX)}`;
    expect(await s.t.query(api.reports.reported, { ...s.B, app_id: s.app_id })).toBe(false);
    expect(await s.t.mutation(api.reports.report, { ...s.B, app_id: s.app_id, reason })).toEqual({ fresh: true });
    expect(await s.t.mutation(api.reports.report, { ...s.B, app_id: s.app_id, reason: "again" })).toEqual({ fresh: false });
    expect(await s.t.mutation(api.reports.report, { ...s.A, app_id: s.app_id, version: 1 })).toEqual({ fresh: true });
    expect(await s.t.query(api.reports.reported, { ...s.B, app_id: s.app_id })).toBe(true);

    const rows = await s.t.run((ctx) => ctx.db.query("reports").collect());
    expect(rows.map((r) => [r.visitor_id, r.version])).toEqual([[s.B.visitor_id, 1], [s.A.visitor_id, 1]]);
    expect(rows[0].reason).toStartWith("phishing for passwords x");
    expect(rows[0].reason).toHaveLength(REPORT_REASON_MAX);
    expect(rows[1].reason).toBeUndefined();
  });

  test("refuses a version the app does not have and a wrong secret", async () => {
    const s = await setup();
    await expect(s.t.mutation(api.reports.report, { ...s.A, app_id: s.app_id, version: 2 })).rejects.toThrow(/does not exist/);
    await expect(s.t.mutation(api.reports.report, { ...s.A, secret: s.B.secret, app_id: s.app_id })).rejects.toThrow(/unauthorized/);
  });
});

describe("rate rules", () => {
  test("only heartbeats that write count toward the presence rule", async () => {
    const s = await setup();
    const beat = (viewing: number | null) => s.t.mutation(api.presence.heartbeat, { ...s.A, app_id: s.app_id, viewing_version: viewing });
    // The same view inside seenWriteMs writes nothing, however often it beats.
    expect(await allowedBefore(() => beat(null), RATE.presence.max + 20)).toBe(RATE.presence.max + 20);
    // Stepping through versions writes each step, and is bounded.
    let step = 1;
    expect(await allowedBefore(() => beat(step++ % 2 ? 1 : null), RATE.presence.max + 20)).toBe(RATE.presence.max - 1);
    jest.advanceTimersByTime(RATE.presence.windowMs);
    await beat(1);
  });

  test("typing pings count toward the presence rule", async () => {
    const s = await setup();
    await s.t.mutation(api.presence.heartbeat, { ...s.A, app_id: s.app_id });
    const typing = () => s.t.mutation(api.presence.setTyping, { ...s.A, app_id: s.app_id, typing: true });
    expect(await allowedBefore(typing, RATE.presence.max + 5)).toBe(RATE.presence.max - 1);
    // Stopping always goes through.
    await s.t.mutation(api.presence.setTyping, { ...s.A, app_id: s.app_id, typing: false });
    expect(PRESENCE.typingMs).toBeGreaterThan(0);
  });

  test("character changes are rate limited per visitor", async () => {
    const s = await setup();
    const rename = (i: number) => s.t.mutation(api.visitors.setCharacter, { ...s.B, name: `Name ${i}` });
    let i = 0;
    expect(await allowedBefore(() => rename(i++), RATE.character.max + 5)).toBe(RATE.character.max);
  });

  test("no shared counter can lock everyone out: app creation is limited per visitor only", async () => {
    const s = await setup();
    const make = (i: number) => s.t.mutation(api.apps.create, { ...s.B, name: `App ${i}` });
    let i = 0;
    expect(await allowedBefore(() => make(i++), RATE.createApp.max + 3)).toBe(RATE.createApp.max);
    // B is spent; A, untouched by B's spree, still makes apps.
    await s.t.mutation(api.apps.create, { ...s.A, name: "Still mine" });
  });

  test("lapsed counters are pruned and live ones kept", async () => {
    const s = await setup();
    const now = Date.now();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("limits", { key: "message:old", window_start: now - RATE_WINDOW_MAX_MS - 1, count: 3 });
      await ctx.db.insert("limits", { key: "message:new", window_start: now - 1_000, count: 3 });
    });
    expect(await s.t.mutation(internal.limits.prune, {})).toBe(1);
    const keys = await s.t.run(async (ctx) => (await ctx.db.query("limits").collect()).map((r) => r.key));
    expect(keys).toContain("message:new");
    expect(keys).not.toContain("message:old");
  });
});

describe("triage under the kill switch and budgets", () => {
  const auto = (s: Awaited<ReturnType<typeof setup>>) =>
    s.t.mutation(api.messages.send, { ...s.A, app_id: s.app_id, mode: "auto", body: "make it blue" });

  test("an Auto message triages while builds can start", async () => {
    const s = await setup();
    const sent = await auto(s);
    expect((await s.room()).find((m) => m.id === sent.message_id)?.triage_pending).toBe(true);
  });

  test("with builds off, an Auto message is plain chat and no model is asked", async () => {
    const s = await setup();
    process.env.PLAYGROUND_BUILDS_OFF = "1";
    try {
      const sent = await auto(s);
      const m = (await s.room()).find((x) => x.id === sent.message_id);
      expect([m?.kind, m?.triage_pending]).toEqual(["chat", false]);
      const scheduled = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(scheduled.map((f) => f.name)).not.toContain("builder/triage:classify");
    } finally {
      delete process.env.PLAYGROUND_BUILDS_OFF;
    }
  });

  test("with the app's budget spent, an Auto message is plain chat", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.insert("tallies", { key: TALLY.appSpend(s.app_id), day: dayKey(Date.now()), value: APP_DAILY_BUDGET_USD }));
    const sent = await auto(s);
    expect((await s.room()).find((m) => m.id === sent.message_id)?.triage_pending).toBe(false);
  });

  test("a triage call holds its ceiling from the moment it is asked, then its real cost", async () => {
    const s = await setup();
    const spent = async () => Object.fromEntries((await s.t.run((ctx) => ctx.db.query("tallies").collect())).map((r) => [r.key, +r.value.toFixed(6)]));
    const keys = [TALLY.spend, TALLY.appSpend(s.app_id), TALLY.visitorSpend(s.A.visitor_id as Id<"visitors">)];
    const sent = await auto(s);
    expect(await spent()).toEqual(Object.fromEntries(keys.map((k) => [k, TRIAGE_CEILING_USD])));
    await s.t.mutation(internal.builder.triage.settle, { message_id: sent.message_id, kind: "chat", cost_usd: 0.002 });
    expect(await spent()).toEqual(Object.fromEntries(keys.map((k) => [k, 0.002])));
  });
});

describe("the global budget counts builds still running", () => {
  /** Today's global spend at `usd`, and `running` builds in progress in another app. */
  async function spentWithRunning(s: Awaited<ReturnType<typeof setup>>, usd: number, running: number) {
    const other = (await s.t.mutation(api.apps.create, { ...s.B, name: "Elsewhere" })).app_id as Id<"apps">;
    await s.t.run(async (ctx) => {
      await ctx.db.insert("tallies", { key: TALLY.spend, day: dayKey(Date.now()), value: usd });
      const message = await ctx.db.insert("messages", { app_id: other, kind: "request", visitor_id: s.B.visitor_id as Id<"visitors">, body: "x" });
      for (let i = 0; i < running; i++) {
        await ctx.db.insert("builds", {
          app_id: other,
          request_message_id: message,
          requested_by: s.B.visitor_id as Id<"visitors">,
          status: "building",
        });
      }
    });
  }

  async function startOne(s: Awaited<ReturnType<typeof setup>>) {
    const sent = await s.t.mutation(api.messages.send, { ...s.A, app_id: s.app_id, mode: "change", body: "make it blue" });
    await s.t.mutation(internal.builder.queue.advance, { app_id: s.app_id });
    return (await s.room()).find((m) => m.id === sent.message_id)?.build;
  }

  test("a build starts while charged spend plus running ceilings stay under the budget", async () => {
    const s = await setup();
    await spentWithRunning(s, GLOBAL_DAILY_BUDGET_USD - 2 * BUILD_CEILING_USD, 1);
    expect((await startOne(s))?.status).toBe("building");
  });

  test("running builds hold their ceiling, so a burst cannot overrun the day", async () => {
    const s = await setup();
    await spentWithRunning(s, GLOBAL_DAILY_BUDGET_USD - 2 * BUILD_CEILING_USD, 2);
    const build = await startOne(s);
    expect(build?.status).toBe("failed");
    expect(build?.error).toMatch(/today's building budget/);
  });

  test("the app page's paused line reads charged spend only", async () => {
    const s = await setup();
    await spentWithRunning(s, GLOBAL_DAILY_BUDGET_USD - BUILD_CEILING_USD, 5);
    expect(await s.t.query(api.apps.buildsPaused, { ...s.A, app_id: s.app_id })).toBeNull();
  });
});

describe("the paused line wakes only when a budget is crossed", () => {
  test("a charge that uses up a budget marks it, and giving back clears the mark", async () => {
    const s = await setup();
    const asker = s.A.visitor_id as Id<"visitors">;
    const charge = (usd: number, by?: Id<"visitors">) => s.t.run((ctx) => chargeSpend(ctx, s.app_id, by, usd));
    const paused = () => s.t.query(api.apps.buildsPaused, { ...s.A, app_id: s.app_id });
    const marks = async () => (await s.t.run((ctx) => ctx.db.query("tallies").collect())).filter((r) => r.key.startsWith("over:")).map((r) => r.key);
    await charge(APP_DAILY_BUDGET_USD / 2);
    await charge(APP_DAILY_BUDGET_USD / 4);
    expect([await paused(), await marks()]).toEqual([null, []]);
    await charge(APP_DAILY_BUDGET_USD / 4);
    expect([await paused(), await marks()]).toEqual([expect.stringMatching(/This app/), [`over:${TALLY.appSpend(s.app_id)}`]]);
    await charge(-APP_DAILY_BUDGET_USD / 2);
    expect([await paused(), await marks()]).toEqual([null, []]);
    await charge(VISITOR_DAILY_BUDGET_USD, asker);
    expect(await paused()).toMatch(/a lot of changes today/);
  });
});

describe("a flooded room stays a bounded read", () => {
  test("presence reads return the most recently seen HERE_MAX people", async () => {
    const s = await setup();
    const now = Date.now();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < HERE_MAX + 5; i++) {
        const visitor = await ctx.db.insert("visitors", { secret_hash: "x", created_at: now });
        await insertPresence(ctx, s.app_id, visitor, now - i);
      }
    });
    const here = await s.t.query(api.presence.here, { ...s.A, app_id: s.app_id });
    expect(here).toHaveLength(HERE_MAX);
    // The most recently seen, earliest arrival first: the oldest beat here is
    // the HERE_MAXth most recent, and it arrived first.
    const rows = await s.t.run((ctx) => ctx.db.query("presence").collect());
    const joined = new Map(rows.map((r) => [r.visitor_id as string, r.joined_at]));
    const order = here.map((h) => joined.get(h.visitor.id)!);
    expect(order[0]).toBe(now - (HERE_MAX - 1));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const card = (await s.t.query(api.apps.gallery, {})).apps.find((a) => a.id === s.app_id);
    // The gallery counts everyone from the app's crowd, one row, and shows the first few faces.
    expect([card?.here_count, card?.here.length]).toEqual([HERE_MAX + 5, CROWD_FACES]);
  });
});

describe("link previews", () => {
  test("/og/<slug> is inert: nothing on it can run", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.patch(s.app_id, { name: '<script>alert(1)</script>' }));
    const slug = (await s.t.run((ctx) => ctx.db.get(s.app_id)))!.slug;
    const res = await s.t.fetch(`/og/${slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const html = await res.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("becoming a visitor costs a proof of work", () => {
  const t = () => convexTest(schema, modules);
  const proved = async (bits: number) => {
    const secret = newSecret();
    return { secret, nonce: await solveProof(await sha256Hex(secret), bits) };
  };

  test("a register without enough work is refused with the bits it needs", async () => {
    const secret = newSecret();
    const hash = await sha256Hex(secret);
    let nonce = 0;
    while (proofHolds(hash, nonce, 1)) nonce++;
    await expect(t().mutation(api.visitors.register, { secret, nonce })).rejects.toThrow(/proof_bits/);
  });

  test("a secret registers once", async () => {
    const tt = t();
    const args = await proved(PROOF_BITS);
    await tt.mutation(api.visitors.register, args);
    await expect(tt.mutation(api.visitors.register, args)).rejects.toThrow(/taken/);
  });

  test("a flood of newcomers raises the proof for the next ones instead of turning anyone away", async () => {
    const tt = t();
    await tt.run(async (ctx) => {
      await ctx.db.insert("limits", { key: "registerCalm:all", window_start: Date.now(), count: RATE.registerCalm.max });
    });
    const easy = await proved(PROOF_BITS);
    const hard = proofHolds(await sha256Hex(easy.secret), easy.nonce, PROOF_BITS_FLOOD);
    if (!hard) await expect(tt.mutation(api.visitors.register, easy)).rejects.toThrow(new RegExp(`"proof_bits":${PROOF_BITS_FLOOD}`));
    const { visitor_id } = await tt.mutation(api.visitors.register, await proved(PROOF_BITS_FLOOD));
    expect(visitor_id).toBeTruthy();
  });
});

describe("every public function proves its caller", () => {
  const PUBLIC = /^export const (\w+) = (mutation|query|action)\(\{/gm;
  const PROOF = /\b(requireVisitor|findVisitor|requireRuntime|requireRuntimeVisitor)\(/;
  /** Minting a visitor needs no visitor, and what the home page and an app
   *  link show says only what anyone can already see (the apps themselves,
   *  /og/<slug>), so those pages draw before their visitor is known. */
  const OPEN = new Set(["visitors.register", "apps.get", "apps.gallery", "activity.recent"]);

  function sources(dir: string, prefix = ""): { name: string; text: string }[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.isDirectory()) return e.name === "_generated" || e.name === "lib" ? [] : sources(join(dir, e.name), `${prefix}${e.name}/`);
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) return [];
      return [{ name: `${prefix}${e.name.slice(0, -3)}`, text: readFileSync(join(dir, e.name), "utf8") }];
    });
  }

  test("with a visitor secret or a runtime token, before anything else", () => {
    const unproven: string[] = [];
    let seen = 0;
    for (const file of sources(import.meta.dir)) {
      for (const m of file.text.matchAll(PUBLIC)) {
        seen++;
        const end = file.text.indexOf("\nexport ", m.index + 1);
        const body = file.text.slice(m.index, end === -1 ? undefined : end);
        const name = `${file.name.replace("/", ".")}.${m[1]}`;
        if (!OPEN.has(name) && !PROOF.test(body)) unproven.push(name);
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(unproven).toEqual([]);
  });

  test("every runtime write needs a token that may write", () => {
    const runtime = readFileSync(join(import.meta.dir, "runtime.ts"), "utf8");
    const writes = [...runtime.matchAll(/^export const (\w+) = mutation\(\{[\s\S]*?(?=\nexport |(?![\s\S]))/gm)];
    expect(writes.length).toBeGreaterThan(3);
    for (const [body, name] of writes) expect([name, body.includes('requireRuntime(ctx, args, "write")')]).toEqual([name, true]);
  });

  test("the HTTP routes call only internal functions", () => {
    const http = readFileSync(join(import.meta.dir, "http.ts"), "utf8");
    expect(http).not.toMatch(/\bapi\./);
  });
});
