// DSL self-test (docs/architecture/multiplayer-sim-harness.md, unit U12): a
// trivial scenario registered through scenario() runs in scripted mode and two
// interleave seeds; a run is deterministic; a red run is held to its markers
// (a pass flips, a failure on the marked invariant is expected, anything else
// fails); SIM_SEEDS, SIM_SWEEP and SIM_ORDER are honoured; and the point
// checks pass and fail with a report that names them.

import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  SCRIPTED_ORDER_MARK,
  SimFailure,
  judgeRun,
  knownMarkers,
  redFlipMessage,
  redFor,
  runScenario,
  scenario,
  scenarioRuns,
  seedBase,
  type ScenarioRun,
  type ScenarioWorld,
} from "../dsl";
import { formatOrder } from "../net";
import { eventsJsonl, type DeliveryRecord } from "../report";

const TRIVIAL = "dsl-trivial";
// Genesis, a role hire and a handful of real handler calls per run, on a loaded machine.
const SLOW = 180_000;

// Two daemons, an agent and the clock act on separate channels, so an
// interleave seed can reorder them; the checks read only what every order
// ends with.
async function trivial(w: ScenarioWorld): Promise<void> {
  w.team("acme", { features: { chat: true, org: true } });
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  w.session("ada", "s", { agentStatus: "working" });
  w.session("ada", "p", { private: true });
  w.session("bo", "s", { agentStatus: "working" });
  w.task("t", { owner: "ada", session: "ada/p" });
  const rev = w.role("acme", "rev");
  await w.daemon("ada").settles("ada/s", "idle");
  await w.daemon("bo").heartbeat("bo/s");
  await w.agent("bo/s").says("acme/general", "have a look", ["rev"]);
  await w.advance(1_000);
  await w.expect(rev).wokenTimes(1);
  await w.expect("bo").cannotRead("task:t");
  await w.expect("bo").cannotRead("ada/p");
  await w.expect.server.row("ada/s").has({ user_id: w.idOf("ada"), is_private: false });
  await w.expect.server.row("task:t").has({ workspace: `user:${w.idOf("ada")}` });
}

// What the registered scenario's runs did, in order.
const ran: string[] = [];

scenario({ name: "dsl-trivial" }, async (w) => {
  ran.push(`${w.mode}:${w.seed}`);
  await trivial(w);
});

const hashOf = (events: readonly DeliveryRecord[]) => createHash("sha256").update(eventsJsonl(events)).digest("hex");
const runOf = (mode: "scripted" | "interleave", seed: number): ScenarioRun => ({ mode, seed, drainPerVerb: mode === "scripted" });
// Direct runs ignore the caller's SIM_* variables (no trace, no artifacts).
const quiet = { env: {} };

async function failureOf(p: Promise<unknown>): Promise<SimFailure> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SimFailure) return e;
    throw e;
  }
  throw new Error("expected the run to fail with a SimFailure");
}

describe("dsl", () => {
  test("the trivial scenario ran once per planned run: scripted and two interleave seeds by default", () => {
    const base = seedBase(TRIVIAL);
    expect(scenarioRuns({ name: TRIVIAL }, {})).toEqual([runOf("scripted", base), runOf("interleave", base), runOf("interleave", base + 1)]);
    const planned = process.env.SIM_RED === "1" ? [] : scenarioRuns({ name: TRIVIAL });
    expect(ran).toEqual(planned.map((r) => `${r.mode}:${r.seed}`));
  });

  test("SIM_SEEDS pins the seeds, SIM_SWEEP widens them, and modes narrow the runs", () => {
    expect(scenarioRuns({ name: TRIVIAL }, { SIM_SEEDS: "3" })).toEqual([runOf("scripted", 3), runOf("interleave", 3)]);
    expect(scenarioRuns({ name: TRIVIAL }, { SIM_SEEDS: "5,9" })).toEqual([runOf("scripted", 5), runOf("interleave", 5), runOf("interleave", 9)]);
    const base = seedBase(TRIVIAL);
    expect(scenarioRuns({ name: TRIVIAL }, { SIM_SWEEP: "4" }).map((r) => r.seed)).toEqual([base, base, base + 1, base + 2, base + 3]);
    expect(scenarioRuns({ name: TRIVIAL, modes: ["interleave"], seeds: 1 }, {})).toEqual([runOf("interleave", base)]);
    expect(() => scenarioRuns({ name: TRIVIAL }, { SIM_SEEDS: "3,x" })).toThrow("SIM_SEEDS takes comma separated");
    // Seeds come from the name alone, so another scenario never shifts them.
    expect(seedBase(TRIVIAL)).toBe(seedBase("dsl-trivial"));
    expect(seedBase("another")).not.toBe(base);
  });

  test("a run is deterministic: one seed twice gives the same events.jsonl hash", async () => {
    const seed = seedBase(TRIVIAL) + 1;
    const a = await runScenario({ name: TRIVIAL }, runOf("interleave", seed), trivial, quiet);
    const b = await runScenario({ name: TRIVIAL }, runOf("interleave", seed), trivial, quiet);
    expect(a.events.length).toBeGreaterThan(4);
    expect(hashOf(b.events)).toBe(hashOf(a.events));
    expect(formatOrder(b.order)).toBe(formatOrder(a.order));
  }, SLOW);

  test("SIM_ORDER replays an interleave run and a scripted run exactly", async () => {
    const seed = seedBase(TRIVIAL);
    for (const mode of ["interleave", "scripted"] as const) {
      const recorded = await runScenario({ name: TRIVIAL }, runOf(mode, seed), trivial, quiet);
      const line = formatOrder(recorded.order);
      expect(line.startsWith(`${SCRIPTED_ORDER_MARK} `)).toBe(mode === "scripted");
      const runs = scenarioRuns({ name: TRIVIAL }, { SIM_ORDER: line, SIM_SEEDS: String(seed) });
      expect(runs).toEqual([{ mode: "order", seed, order: recorded.order.filter((c) => c !== SCRIPTED_ORDER_MARK), drainPerVerb: mode === "scripted" }]);
      const replay = await runScenario({ name: TRIVIAL }, runs[0], trivial, quiet);
      expect(hashOf(replay.events)).toBe(hashOf(recorded.events));
    }
  }, SLOW * 2);

  test("an order that diverges from the run fails with the net's order-mismatch, as a report", async () => {
    const [run] = scenarioRuns({ name: TRIVIAL }, { SIM_ORDER: "actor:nobody" });
    const f = await failureOf(runScenario({ name: TRIVIAL }, run, trivial, quiet));
    expect(f.ctx.invariant.id).toBe("net.order-mismatch");
    expect(f.message).toContain('expected "actor:nobody" but it is not ready');
    expect(f.message).toContain(`bun run sim ${TRIVIAL} --seed ${run.seed} --order`);
  }, SLOW);

  const RED = { task: "ct-00000", invariant: "expect.server.gone" };
  // A tiny run that fails its planted point check.
  const holds = async (w: ScenarioWorld) => {
    w.user("ada");
    w.session("ada", "s");
    await w.expect.server.gone("ada/s");
  };

  test("markers scope to their seeds, and known invariants become the known check's markers", () => {
    const opts = {
      name: "x",
      red: [RED, { task: "ct-1", invariant: "INV-a", modes: ["interleave" as const], seeds: [5] }],
      known: { "INV-fixpoint": "ct-56011", "INV-b": ["ct-2", "ct-3"] },
    };
    expect(redFor(opts, { mode: "interleave", seed: 4 })).toEqual([RED]);
    expect(redFor(opts, { mode: "interleave", seed: 5 }).map((m) => m.task)).toEqual(["ct-00000", "ct-1"]);
    expect(redFor(opts, { mode: "scripted", seed: 5 })).toEqual([RED]);
    // An order replay can be of either mode.
    expect(redFor(opts, { mode: "order", seed: 5 }).map((m) => m.task)).toEqual(["ct-00000", "ct-1"]);
    expect(redFor({ red: RED }, { mode: "scripted", seed: 1 })).toEqual([RED]);
    expect(knownMarkers(opts)).toEqual([{ task: "ct-56011", invariant: "INV-fixpoint" }, { task: "ct-2, ct-3", invariant: "INV-b" }]);
  });

  test("a red run that passes fails with the flip message", async () => {
    const opts = { name: "dsl-red-flip", red: RED };
    const passing = async (w: ScenarioWorld) => {
      w.user("ada");
      w.session("ada", "s");
      await w.start(); // labels exist from genesis on
      await w.expect.server.row("ada/s").has({ user_id: w.idOf("ada") });
    };
    const flip = redFlipMessage("dsl-red-flip", [RED]);
    expect(flip).toBe('red scenario "dsl-red-flip" now passes; it was marked to fail on expect.server.gone (ct-00000). Remove those red: markers and close ct-00000');
    await expect(judgeRun(opts, runOf("scripted", 1), passing, quiet)).rejects.toThrow(flip);
    // With no marker for the run, the same pass is a pass.
    expect("passed" in (await judgeRun({ name: "dsl-red-flip" }, runOf("scripted", 1), passing, quiet))).toBe(true);
  }, SLOW);

  test("a red run that fails on its marked invariant is expected, and its report says so", async () => {
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await judgeRun({ name: "dsl-red-holds", red: RED }, runOf("scripted", 1), holds, quiet);
      if (!("expected" in out)) throw new Error("expected the red run to fail on its marker");
      expect(out.expected.ctx.expected).toBe("ct-00000");
      expect(out.expected.message).toStartWith("sim failure (expected, red: ct-00000): dsl-red-holds");
      expect(out.expected.message).toContain("ada/s is still on the server");
    } finally {
      said.mockRestore();
    }
  }, SLOW);

  test("a red run that fails on another invariant, or on a harness error, fails", async () => {
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const other = { name: "dsl-red-other", red: { task: "ct-00000", invariant: "INV-sessions-mine" } };
      const f = await failureOf(judgeRun(other, runOf("scripted", 1), holds, quiet));
      expect(f.ctx.invariant.id).toBe("expect.server.gone");
      expect(f.ctx.expected).toBeUndefined();
      expect(f.message).toStartWith("sim failure: dsl-red-other");
      const crash = judgeRun({ name: "dsl-red-crash", red: RED }, runOf("scripted", 1), async (w) => {
        w.user("ada");
        await w.start();
        throw new TypeError("harness bug");
      }, quiet);
      await expect(crash).rejects.toThrow("harness bug");
    } finally {
      said.mockRestore();
    }
  }, SLOW);

  test("the known check fails on a known invariant, and flips once nothing trips it", async () => {
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const known = { "expect.server.gone": "ct-00001" };
      const out = await judgeRun({ name: "dsl-known", known }, runOf("scripted", 1), holds, { ...quiet, expected: knownMarkers({ known }), field: "known" });
      expect("expected" in out && out.expected.ctx.expected).toBe("ct-00001");
      const fixed = judgeRun({ name: "dsl-known", known }, runOf("scripted", 1), async (w) => {
        w.user("ada");
        await w.start();
      }, { ...quiet, expected: knownMarkers({ known }), field: "known" });
      await expect(fixed).rejects.toThrow('scenario "dsl-known" no longer fails on expect.server.gone (ct-00001) with nothing left out; remove them from known: and close ct-00001');
    } finally {
      said.mockRestore();
    }
  }, SLOW);

  // A window's point checks, with every invariant on.
  const WINDOW = { env: {} };

  test("window point checks: shows, hides, inspect, and a failing check's report", async () => {
    const said = spyOn(console, "error").mockImplementation(() => {});
    const logged = spyOn(console, "log").mockImplementation(() => {});
    try {
      const run = runOf("scripted", seedBase("dsl-window"));
      const f = await failureOf(runScenario({ name: "dsl-window" }, run, async (w) => {
        w.user("ada");
        w.session("ada", "s", { agentStatus: "working" });
        const ada = await w.device("ada");
        await w.expect(ada.host).shows("ada/s");
        const before = await w.inspect("ada/s");
        expect(before.table).toBe("conversations");
        expect(Object.keys(before.windows["ada-host"] ?? {})).toContain("sessions");
        await w.human(ada.host).kill("ada/s");
        await w.expect(ada.host).hides("ada/s");
        // The planted failure: the killed row is not shown.
        await w.expect(ada.host).shows("ada/s");
      }, WINDOW));
      expect(f.ctx.invariant.id).toBe("expect.shows");
      expect(f.ctx.window?.name).toBe("ada-host");
      expect(f.message).toContain("expect.shows: window ada-host shows ada/s");
      expect(f.message).toContain("ada/s is not among the active rows");
      expect(f.message).toContain("row ada/s (conversations)");
      expect(f.message).toContain(`bun run sim dsl-window --seed ${run.seed} --trace ada/s`);
      expect(f.message).toContain(`--order "${SCRIPTED_ORDER_MARK} `);
      expect(logged.mock.calls.flat().join("\n")).toContain("sim inspect ada/s");
    } finally {
      said.mockRestore();
      logged.mockRestore();
    }
  }, SLOW);
});
