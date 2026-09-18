import { describe, expect, test } from "bun:test";
import { rollUpUsage } from "./messages";
import { PROMPT_CACHE_LIFETIME_MS, contextShareOf, formatIdle, formatShare, formatTokens, restartPlan, restartReloadsContext, wakeCost, wakeFieldsOf } from "./wakeCost";

const NOW = 1_800_000_000_000;

describe("context size rides the usage roll up", () => {
  test("the latest call's context is recorded, and a refused turn does not erase it", async () => {
    const conv: any = { _id: "c1" };
    const patch1: Record<string, unknown> = {};
    await rollUpUsage({ db: {} }, conv, [
      { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90 }, api_message_id: "a", inserted: true },
      { usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 1100, cache_creation_input_tokens: 400 }, api_message_id: "b", inserted: true },
    ], patch1, NOW);
    expect((patch1.usage_totals as any).context_tokens).toBe(1502);
    Object.assign(conv, patch1);

    const patch2: Record<string, unknown> = {};
    await rollUpUsage({ db: {} }, conv, [
      { usage: { input_tokens: 0, output_tokens: 3 }, api_message_id: "refused", inserted: true },
    ], patch2, NOW + 1000);
    expect((patch2.usage_totals as any).context_tokens).toBe(1502);
    expect(wakeFieldsOf(conv)).toEqual({ context_tokens: 1502, last_model_call_at: NOW });
  });
});

describe("wakeCost", () => {
  test("idle past the cache lifetime is cold; the last model call decides, not a heartbeat bump", () => {
    const warm = wakeCost({ last_model_call_at: NOW - 10 * 60_000, updated_at: NOW, context_tokens: 400_000 }, NOW);
    expect(warm.cacheCold).toBe(false);
    const cold = wakeCost({ last_model_call_at: NOW - PROMPT_CACHE_LIFETIME_MS - 1, updated_at: NOW }, NOW);
    expect(cold.cacheCold).toBe(true);
    expect(cold.contextTokens).toBeNull();
  });

  test("a row with no usage yet falls back to updated_at", () => {
    expect(wakeCost({ updated_at: NOW - 2 * PROMPT_CACHE_LIFETIME_MS }, NOW).cacheCold).toBe(true);
  });

  test("killed is either the inbox kill stamp or a completed status", () => {
    expect(wakeCost({ inbox_killed_at: NOW - 1 }, NOW).killed).toBe(true);
    expect(wakeCost({ status: "completed" }, NOW).killed).toBe(true);
    expect(wakeCost({ status: "active" }, NOW).killed).toBe(false);
  });

  test("formatTokens climbs from plain digits to k to M", () => {
    expect(formatTokens(940)).toBe("940");
    expect(formatTokens(999_400)).toBe("999k");
    expect(formatTokens(999_600)).toBe("1M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(2_116_000)).toBe("2.1M");
  });

  test("formatIdle reads in minutes, hours, then days", () => {
    expect(formatIdle(5 * 60_000)).toBe("5m");
    expect(formatIdle(3 * 3600_000)).toBe("3h");
    expect(formatIdle(4 * 86400_000)).toBe("4d");
  });
});

describe("context share — tokens read against what the model holds", () => {
  const claude = (model: string, ctx: number) => ({ model, agent_type: "claude_code", context_tokens: ctx });

  test("the same token count is half a window on Fable and a quarter on Haiku", () => {
    expect(formatShare(contextShareOf(claude("claude-fable-5-1", 500_000)))).toBe("50%");
    expect(formatShare(contextShareOf(claude("claude-haiku-4-5-20251001", 50_000)))).toBe("25%");
  });

  test("a point release resolves through its catalog key", () => {
    expect(formatShare(contextShareOf(claude("claude-opus-4-8", 250_000)))).toBe("25%");
  });

  test("an unknown model or a session with no reading reports no share", () => {
    expect(contextShareOf(claude("gpt-6-astra", 200_000))).toBeNull();
    expect(contextShareOf({ model: "claude-opus-5", agent_type: "claude_code" })).toBeNull();
    expect(formatShare(null)).toBeNull();
  });

  test("something is never rendered as nothing", () => {
    expect(formatShare(contextShareOf(claude("claude-opus-5", 400)))).toBe("<1%");
  });

  test("wakeCost carries the share beside the tokens", () => {
    const cost = wakeCost({ ...claude("claude-opus-5", 300_000), last_model_call_at: NOW }, NOW);
    expect(cost.contextTokens).toBe(300_000);
    expect(formatShare(cost.contextShare)).toBe("30%");
  });
});

describe("restartReloadsContext", () => {
  const recent = { last_model_call_at: NOW - 5 * 60_000 };
  test("a warm session on the same login restarts cheap", () => {
    expect(restartReloadsContext(recent, NOW, { switchingAccount: false, activeSince: NOW - 3 * PROMPT_CACHE_LIFETIME_MS })).toBe(false);
  });
  test("an explicit switch, a login newer than the last call, or an expired cache all reload", () => {
    expect(restartReloadsContext(recent, NOW, { switchingAccount: true })).toBe(true);
    expect(restartReloadsContext(recent, NOW, { switchingAccount: false, activeSince: NOW - 60_000 })).toBe(true);
    expect(restartReloadsContext({ last_model_call_at: NOW - 2 * PROMPT_CACHE_LIFETIME_MS }, NOW, { switchingAccount: false })).toBe(true);
  });
});

describe("restartPlan — what the restart bar ticks and what it costs", () => {
  const row = (id: string, parkedMinAgo: number, ctx: number, model = "claude-opus-5") => ({
    _id: id, pending_api_error_at: NOW - parkedMinAgo * 60_000,
    last_model_call_at: NOW - parkedMinAgo * 60_000, context_tokens: ctx,
    model, agent_type: "claude_code",
  });
  const acted = [row("a", 4, 800_000), row("b", 90, 300_000), row("c", 8 * 60, 500_000), row("d", 30 * 60, 400_000)];
  const base = {
    now: NOW, windowMs: 6 * 60 * 60 * 1000, parkedAt: (r: any) => r.pending_api_error_at,
    switchingAccount: false, rowFor: (r: any) => r, activeSinceFor: () => null,
  };

  test("parks inside the window are ticked, older ones are left for the human", () => {
    const plan = restartPlan(acted, base);
    expect([...plan.chosenIds].sort()).toEqual(["a", "b"]);
    expect(plan.scoped).toBe(true);
    expect(plan.leftUnticked).toBe(2);
  });

  test("the cost counts only the sessions whose cache is gone", () => {
    // "a" parked 4 minutes ago keeps its cache; "b" at 90 minutes does not.
    expect(restartPlan(acted, base).reloadTokens).toBe(300_000);
    // Switching account reloads every ticked session.
    expect(restartPlan(acted, { ...base, switchingAccount: true }).reloadTokens).toBe(1_100_000);
    // A login that took over after those calls does the same.
    expect(restartPlan(acted, { ...base, activeSinceFor: () => NOW - 60_000 }).reloadTokens).toBe(1_100_000);
  });

  test("the total reads as a share of the windows the reloading sessions fill", () => {
    // Switching reloads all four: 2.0M of tokens against 4M of windows.
    expect(formatShare(restartPlan(acted, { ...base, switchingAccount: true, picked: new Set(["a", "b", "c", "d"]) }).reloadShare)).toBe("50%");
    // A model with no published window sits out of BOTH halves: the total still
    // counts its tokens, and the share describes only the sessions it can vouch
    // for — 500k of Opus's million, not 1.4M over one window.
    const mixed = [row("a", 90, 500_000), row("e", 90, 900_000, "gpt-6-astra")];
    const plan = restartPlan(mixed, { ...base, picked: new Set(["a", "e"]) });
    expect(plan.reloadTokens).toBe(1_400_000);
    expect(formatShare(plan.reloadShare)).toBe("50%");
  });

  test("nothing reloading means no share to report", () => {
    expect(restartPlan([row("a", 4, 800_000)], base).reloadShare).toBeNull();
  });

  test("an explicit pick replaces the default and stops counting unticked rows", () => {
    const plan = restartPlan(acted, { ...base, picked: new Set(["c", "d"]) });
    expect(plan.chosen.map((r) => r._id)).toEqual(["c", "d"]);
    expect(plan.reloadTokens).toBe(900_000);
    expect(plan.leftUnticked).toBe(0);
  });

  test("ticking every session is not a scoped revive", () => {
    expect(restartPlan(acted, { ...base, picked: new Set(["a", "b", "c", "d"]) }).scoped).toBe(false);
  });
});
