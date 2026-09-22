import { describe, expect, test } from "bun:test";
import { FAILED_PUSH_RETRY_MS, Gate, QUIET_MS, STALE_RETRY_MS, shipsToProd, signatureOf, type CheckResult } from "./gated-push";

// The pusher's contract, driven with fakes: a push happens only for a quiet,
// fresh, green tree, and a tree that moved under the push goes around again.

function harness(over: Partial<{ fresh: boolean; check: CheckResult; pushCode: number }> = {}) {
  let now = 1_000_000;
  let sig = "a";
  const log: string[] = [];
  const calls = { push: 0, typecheck: 0 };
  const state = { fresh: true, check: { errors: 0, diagnostics: "" }, pushCode: 0, sigDuringPush: null as string | null, ...over };
  const gate = new Gate({
    now: () => now,
    treeIsFresh: async () => state.fresh,
    signature: async () => sig,
    typecheck: async () => { calls.typecheck += 1; return state.check; },
    push: async () => {
      calls.push += 1;
      if (state.sigDuringPush !== null) sig = state.sigDuringPush;
      return state.pushCode;
    },
    log: (l) => log.push(l),
  });
  return { gate, log, calls, state, advance: (ms: number) => { now += ms; }, setSig: (s: string) => { sig = s; } };
}

describe("gated convex push", () => {
  test("a fresh pusher pushes the tree once, the way convex dev did", async () => {
    const h = harness();
    expect(await h.gate.tick()).toBe("pushed");
    expect(h.calls).toEqual({ push: 1, typecheck: 1 });
    expect(await h.gate.tick()).toBe("idle");
  });

  test("a save is not pushed until the tree has been quiet", async () => {
    const h = harness();
    await h.gate.tick();
    h.gate.onChange("teams.ts");
    expect(await h.gate.tick()).toBe("quiet");
    h.advance(QUIET_MS - 1);
    expect(await h.gate.tick()).toBe("quiet");
    h.gate.onChange("teams.ts"); // a second save restarts the quiet clock
    h.advance(QUIET_MS - 1);
    expect(await h.gate.tick()).toBe("quiet");
    h.advance(1);
    expect(await h.gate.tick()).toBe("pushed");
    expect(h.calls.push).toBe(2);
  });

  test("a red typecheck never pushes, and the next save re-arms it", async () => {
    const h = harness({ check: { errors: 1, diagnostics: "teams.ts(481,54): error TS2304: Cannot find name 'feedFilter'." } });
    expect(await h.gate.tick()).toBe("errors");
    expect(h.calls.push).toBe(0);
    expect(h.log.join("\n")).toContain("feedFilter");
    // Nothing changed: no retry loop against the same red tree.
    h.advance(10 * QUIET_MS);
    expect(await h.gate.tick()).toBe("idle");
    h.state.check = { errors: 0, diagnostics: "" };
    h.gate.onChange("teams.ts");
    h.advance(QUIET_MS);
    expect(await h.gate.tick()).toBe("pushed");
  });

  test("a tree behind origin/main is refused and re-checked a minute later", async () => {
    const h = harness({ fresh: false });
    expect(await h.gate.tick()).toBe("stale");
    expect(h.calls).toEqual({ push: 0, typecheck: 0 });
    h.advance(STALE_RETRY_MS - 1);
    expect(await h.gate.tick()).toBe("quiet");
    h.state.fresh = true;
    h.advance(1);
    expect(await h.gate.tick()).toBe("pushed");
    expect(h.log.some((l) => l.includes("BEHIND origin/main"))).toBe(true);
  });

  test("files that moved under the push make it dirty again, even when the push succeeded", async () => {
    const h = harness();
    h.state.sigDuringPush = "b";
    expect(await h.gate.tick()).toBe("moved");
    expect(h.calls.push).toBe(1);
    h.state.sigDuringPush = null;
    expect(await h.gate.tick()).toBe("quiet");
    h.advance(QUIET_MS);
    expect(await h.gate.tick()).toBe("pushed");
    expect(h.calls.push).toBe(2);
  });

  test("a failed push retries after a minute, or sooner on the next save", async () => {
    const h = harness({ pushCode: 1 });
    expect(await h.gate.tick()).toBe("failed");
    h.advance(FAILED_PUSH_RETRY_MS - 1);
    expect(await h.gate.tick()).toBe("quiet");
    h.state.pushCode = 0;
    h.gate.onChange("teams.ts");
    h.advance(QUIET_MS);
    expect(await h.gate.tick()).toBe("pushed");
  });

  test("codegen output, tests and dotfiles never trigger a push", () => {
    expect(shipsToProd("teams.ts")).toBe(true);
    expect(shipsToProd("lib/access.ts")).toBe(true);
    expect(shipsToProd("_generated/api.d.ts")).toBe(false);
    expect(shipsToProd("teams.roster.guard.test.ts")).toBe(false);
    expect(shipsToProd(".teams.ts.swp")).toBe(false);
    expect(shipsToProd("README.md")).toBe(false);
    const h = harness();
    h.gate.onChange("_generated/api.d.ts");
    // Still the startup push, not a second one: the change was ignored.
    expect(h.gate.tick()).resolves.toBe("pushed");
  });

  test("the signature moves on any shipping file's bytes and on nothing else", () => {
    const base = [
      { rel: "teams.ts", mtimeMs: 10, size: 100 },
      { rel: "_generated/api.d.ts", mtimeMs: 10, size: 5 },
    ];
    const a = signatureOf(base);
    expect(signatureOf([{ rel: "teams.ts", mtimeMs: 11, size: 100 }, base[1]!])).not.toBe(a);
    expect(signatureOf([base[0]!, { rel: "_generated/api.d.ts", mtimeMs: 99, size: 9 }])).toBe(a);
    expect(signatureOf([base[1]!, base[0]!])).toBe(a);
  });
});
