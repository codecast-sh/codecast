import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { makeFakeDb } from "./testDb";
import { splitModelLimitParks, modelPinTarget } from "./lib/modelLimitPins";
import { hasModelRoom } from "./lib/modelRoom";
import { resumePinFor } from "./ccAccountsShared";

// A park on one model's week moves the fleet only when the fleet mostly runs
// that model. One Fable session hopped an Opus fleet across three accounts
// every few minutes (2026-11-21). Model weeks are per account, so with
// switching on the parked session moves ALONE onto an account whose meter
// proves room on its model; the fleet stays put (2026-11-22: six accounts at
// Fable 100%, adanovagreen at 22%, and nothing moved the parked session).

const FABLE_BANNER = "You've hit your Fable limit · resets Nov 24 at 2am (America/Los_Angeles). /model to switch models.";
const WEEKLY_BANNER = "You've hit your weekly limit · resets Nov 24, 2am (UTC)";

describe("splitModelLimitParks", () => {
  function world() {
    return makeFakeDb({
      conversations: [{ _id: "conv_fable" }, { _id: "conv_week" }],
      messages: [
        { _id: "m1", conversation_id: "conv_fable", role: "user", content: "continue", timestamp: 1 },
        { _id: "m2", conversation_id: "conv_fable", role: "assistant", content: FABLE_BANNER, timestamp: 2 },
        { _id: "m3", conversation_id: "conv_week", role: "user", content: "continue", timestamp: 1 },
        { _id: "m4", conversation_id: "conv_week", role: "assistant", content: WEEKLY_BANNER, timestamp: 2 },
      ],
    });
  }

  test("an Opus fleet leaves a Fable park out of the account decision", async () => {
    const split = await splitModelLimitParks({ db: world() }, [{ _id: "conv_fable" }, { _id: "conv_week" }] as any, ["claude-opus-5-5"]);
    expect(split.fleet.map((c) => c._id)).toEqual(["conv_week"] as any);
    expect(split.minority).toEqual([{ conv: { _id: "conv_fable" }, family: "fable" }] as any);
  });

  test("a Fable fleet still acts on its Fable park", async () => {
    const split = await splitModelLimitParks({ db: world() }, [{ _id: "conv_fable" }] as any, ["claude-fable-5-2"]);
    expect(split.fleet.map((c) => c._id)).toEqual(["conv_fable"] as any);
    expect(split.minority).toEqual([]);
  });
});

const HOUR = 3_600_000;
const T0 = Date.now();
const win = (percent: number, resetsIn = 3 * 24 * HOUR) => ({ percent, resets_at: T0 + resetsIn });
const TOKEN_META = { stored_at: T0 - HOUR, expires_at: T0 + 300 * 24 * HOUR };
/** An account's meter: `fable` undefined = the account reports no Fable week. */
function usage(week: number, fable?: number) {
  return {
    fetched_at: T0 - 60_000,
    session: win(5, 4 * HOUR),
    weekly: win(week),
    ...(fable === undefined ? {} : { weekly_scoped: { ...win(fable), label: "Fable" } }),
  };
}
const profile = (name: string, u: ReturnType<typeof usage>) => ({ name, email: `${name}@example.com`, usage: u, token: TOKEN_META });

describe("hasModelRoom", () => {
  test("only a measured Fable week below its cap is room", () => {
    expect(hasModelRoom(usage(11, 22), "fable", T0)).toBe(true);
    expect(hasModelRoom(usage(11, 100), "fable", T0)).toBe(false);
    // No Fable meter is unproven, never room: the 2026-11-21 cycling.
    expect(hasModelRoom(usage(11), "fable", T0)).toBe(false);
    expect(hasModelRoom(usage(100, 22), "fable", T0)).toBe(false);
    // A week that rolled after the probe is unmeasured.
    const rolled = { ...usage(11), weekly_scoped: { percent: 100, resets_at: T0 - HOUR, label: "Fable" }, fetched_at: T0 - 2 * HOUR };
    expect(hasModelRoom(rolled, "fable", T0)).toBe(false);
  });

  test("the target is the account with the most proven room, never the one it parked on or one tried", () => {
    const profiles = [profile("a", usage(30, 60)), profile("b", usage(11, 22)), profile("c", usage(1))];
    expect(modelPinTarget(profiles, "fable", undefined, [], T0)?.name).toBe("b");
    expect(modelPinTarget(profiles, "fable", "b@example.com", [], T0)?.name).toBe("a");
    expect(modelPinTarget(profiles, "fable", undefined, ["b", "a"], T0)).toBeUndefined();
    // A profile with no launch credential cannot carry a pinned session.
    expect(modelPinTarget([{ ...profiles[1], token: undefined }], "fable", undefined, [], T0)).toBeUndefined();
  });
});

const TOKEN = "m".repeat(64);
const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-2";
const SIX = ["studiomgmt", "personal226", "symmetrylabs", "lb1", "lb2", "lb3"];

async function setup(opts: { profiles: ReturnType<typeof profile>[]; mode?: "auto" | "ask"; parked?: Record<string, unknown> }) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Alex" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    await ctx.db.insert("devices", {
      user_id: user, device_id: "studio", label: "Mac Studio", platform: "darwin", last_seen: Date.now(),
      ...(opts.mode === "ask" ? { cc_recovery_ask: true } : { cc_auto_switch: true }),
      cc_accounts: { active_email: "studiomgmt@example.com", active_since: T0 - 24 * HOUR, profiles: opts.profiles },
    } as any);
    const conv = (session: string, model: string, extra: Record<string, unknown> = {}) => ctx.db.insert("conversations", {
      user_id: user, session_id: session, agent_type: "claude_code", status: "active", owner_device_id: "studio",
      model, cc_account: "studiomgmt", cc_account_auto: true, started_at: T0 - HOUR, updated_at: T0 - 30_000, message_count: 4, ...extra,
    } as any);
    const opus = [await conv("s-opus-1", OPUS), await conv("s-opus-2", OPUS), await conv("s-opus-3", OPUS)];
    const fable = await conv("s-fable", FABLE, {
      pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: T0 - 60_000, ...opts.parked,
    });
    await ctx.db.insert("messages", { conversation_id: fable, role: "user", content: "keep going", timestamp: T0 - 120_000 } as any);
    await ctx.db.insert("messages", { conversation_id: fable, role: "assistant", content: FABLE_BANNER, timestamp: T0 - 60_000 } as any);
    return { user, opus, fable };
  });
  const check = () => t.mutation(internal.accountSwitch.autoSwitchCheck, { user_id: ids.user }) as Promise<any>;
  const row = (id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<any>;
  const commands = () => t.run((ctx) => ctx.db.query("daemon_commands").collect()) as Promise<any[]>;
  const device = () => t.run((ctx) => ctx.db.query("devices").first()) as Promise<any>;
  const resume = (id: any) => t.mutation(api.accountSwitch.pinForResume, { api_token: TOKEN, conversation_id: id, device_id: "studio" });
  return { t, ids, check, row, commands, device, resume };
}

describe("autoSwitchCheck: a park on one model's week the fleet does not run", () => {
  test("adanovagreen case: the Fable session alone moves onto the account with Fable room", async () => {
    const w = await setup({ profiles: [...SIX.map((n) => profile(n, usage(40, 100))), profile("adanovagreen", usage(11, 22))] });
    const res = await w.check();
    expect(res).toMatchObject({ acted: "model_pin", pinned: [{ conversation_id: w.ids.fable, profile: "adanovagreen", family: "fable" }] });
    const fable = await w.row(w.ids.fable);
    expect(fable).toMatchObject({ cc_account: "adanovagreen", cc_account_auto: true, cc_account_model_pin: { family: "fable", profile: "adanovagreen" } });
    // One restart for that session, with no profile: the fleet does not move.
    const cmds = await w.commands();
    expect(cmds).toHaveLength(1);
    const args = JSON.parse(cmds[0].args);
    expect(args.profile).toBeUndefined();
    expect(args).toMatchObject({ conversation_ids: [w.ids.fable], continue_blocked: true });
    for (const id of w.ids.opus) expect((await w.row(id)).cc_account).toBe("studiomgmt");
    const dev = await w.device();
    expect(dev.cc_accounts.active_email).toBe("studiomgmt@example.com");
    expect(dev.cc_auto_switch_state?.last_action).toBeUndefined();
    // The daemon's resume sources the pin the recovery placed, and keeps it.
    expect(await w.resume(w.ids.fable)).toEqual({ cc_account: "adanovagreen" });
    expect((await w.row(w.ids.fable)).cc_account).toBe("adanovagreen");
    // A second pass before the restart lands does not send another.
    await w.check();
    expect(await w.commands()).toHaveLength(1);
  });

  test("cycling regression: accounts with no Fable meter are never room, and nothing moves", async () => {
    // 2026-11-21: the active account's Fable week is spent and the others
    // report no Fable meter at all.
    const w = await setup({ profiles: [profile("studiomgmt", usage(40, 100)), ...SIX.slice(1).map((n) => profile(n, usage(20))), profile("adanovagreen", usage(11))] });
    for (let i = 0; i < 3; i++) expect(await w.check()).toMatchObject({ acted: "nothing_blocked" });
    expect(await w.commands()).toHaveLength(0);
    expect((await w.row(w.ids.fable)).cc_account).toBe("studiomgmt");
    for (const id of w.ids.opus) expect((await w.row(id)).cc_account).toBe("studiomgmt");
    expect((await w.device()).cc_accounts.active_email).toBe("studiomgmt@example.com");
  });

  test("re-parked on the pinned account: the pin is released and that account is not tried again", async () => {
    const w = await setup({ profiles: [...SIX.map((n) => profile(n, usage(40, 100))), profile("adanovagreen", usage(11, 22))] });
    await w.check();
    // The restart landed on adanovagreen and parked again on its Fable week (its meter lagged).
    const again = Date.now() + 1_000;
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.ids.fable, { pending_api_error: true, pending_api_error_at: again, updated_at: again } as any);
      await ctx.db.insert("messages", { conversation_id: w.ids.fable, role: "assistant", content: FABLE_BANNER, timestamp: again } as any);
    });
    expect(await w.check()).toMatchObject({ acted: "nothing_blocked" });
    expect(await w.commands()).toHaveLength(1);
    // A resume now follows the machine's account, not the pin that re-parked.
    expect(await w.resume(w.ids.fable)).toEqual({ cc_account: "studiomgmt" });
    // With the pin released, the same account is still not picked again this week.
    expect((await w.check()).pinned).toBeUndefined();
    expect(await w.commands()).toHaveLength(1);
  });

  test("ask-first never changes a session's account on its own", async () => {
    const w = await setup({ mode: "ask", profiles: [...SIX.map((n) => profile(n, usage(40, 100))), profile("adanovagreen", usage(11, 22))] });
    expect((await w.check()).pinned).toBeUndefined();
    expect(await w.commands()).toHaveLength(0);
    expect((await w.row(w.ids.fable)).cc_account).toBe("studiomgmt");
  });

  test("an account a person chose for the session is left alone", async () => {
    const w = await setup({
      parked: { cc_account_auto: undefined },
      profiles: [...SIX.map((n) => profile(n, usage(40, 100))), profile("adanovagreen", usage(11, 22))],
    });
    expect((await w.check()).pinned).toBeUndefined();
    expect(await w.commands()).toHaveLength(0);
  });
});

describe("resumePinFor with a model-room pin", () => {
  const device = (fable: number | undefined) => ({
    cc_accounts: { active_email: "studiomgmt@example.com", profiles: [profile("studiomgmt", usage(40, 100)), profile("adanovagreen", usage(11, fable))] },
  });
  const conv = { cc_account: "adanovagreen", cc_account_auto: true, cc_account_model_pin: { family: "fable", profile: "adanovagreen", at: T0 } };

  test("held while the account proves room, released when it does not", () => {
    expect(resumePinFor(conv, device(22), T0)).toBe("adanovagreen");
    expect(resumePinFor(conv, device(100), T0)).toBe("studiomgmt");
    expect(resumePinFor(conv, device(undefined), T0)).toBe("studiomgmt");
  });

  test("a pin the row no longer carries is not restored", () => {
    expect(resumePinFor({ ...conv, cc_account: "studiomgmt" }, device(22), T0)).toBe("studiomgmt");
  });
});
