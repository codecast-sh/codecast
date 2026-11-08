import { describe, expect, test } from "bun:test";
import {
  ROUND_MAX_LAPS,
  deferBusy,
  endRound,
  grantFloor,
  nextCandidate,
  recordOutcome,
  restartRound,
  roundStrip,
  startRound,
  type ChatRound,
} from "./rounds";

const seeds = ["a", "b", "c"].map((k) => ({ key: k, kind: "session" as const, short_id: `jx7${k}`, name: k.toUpperCase() }));

/** Take the next floor and grant it, as the server does. */
function take(round: ChatRound): { round: ChatRound; key: string | null } {
  const step = nextCandidate(round, 1);
  return step.key ? { round: grantFloor(step.round, step.key, `s-${step.key}`, `w-${step.key}`, 1), key: step.key } : step;
}

describe("rounds", () => {
  test("a person's line asks every member, one at a time, in room order", () => {
    let r = startRound(seeds, { named: [], byPerson: true, now: 0 });
    expect(r.queue).toEqual(["a", "b", "c"]);
    let t = take(r);
    expect(t.key).toBe("a");
    // Nobody else is woken while a holds the floor.
    expect(nextCandidate(t.round, 1).key).toBeNull();
    r = recordOutcome(t.round, "a", "spoke", { now: 2 });
    t = take(r);
    expect(t.key).toBe("b");
  });

  test("a line that names members asks only them, in the order named", () => {
    const r = startRound(seeds, { named: ["c", "a"], byPerson: true, now: 0 });
    expect(r.queue).toEqual(["c", "a"]);
    expect(r.members.find((m) => m.key === "b")!.state).toBe("out");
  });

  test("an agent's root leaves the opener out of the first lap", () => {
    const r = startRound(seeds, { named: [], exclude: ["a"], byPerson: false, now: 0 });
    expect(r.queue).toEqual(["b", "c"]);
  });

  test("a reply that mentions a member hands it the floor next", () => {
    let t = take(startRound(seeds, { named: [], byPerson: true, now: 0 }));
    const r = recordOutcome(t.round, "a", "spoke", { handTo: ["c"], now: 2 });
    t = take(r);
    expect(t.key).toBe("c");
  });

  test("a second lap runs only when someone spoke, and the rounds end", () => {
    let r = startRound(seeds, { named: [], byPerson: true, now: 0 });
    const outcomes: Record<string, "spoke" | "passed"> = { a: "spoke", b: "passed", c: "passed" };
    const order: string[] = [];
    for (let i = 0; i < 20; i++) {
      const t = take(r);
      if (!t.key) { r = t.round; break; }
      order.push(t.key);
      r = recordOutcome(t.round, t.key, t.round.lap === 1 ? outcomes[t.key] : "passed", { now: 3 });
    }
    // Lap 2 skips the last speaker (a) and then the round is done.
    expect(order).toEqual(["a", "b", "c", "b", "c"]);
    expect(r.status).toBe("done");
    expect(r.lap).toBeLessThanOrEqual(ROUND_MAX_LAPS);
  });

  test("members who keep talking still stop at the caps", () => {
    let r = startRound(seeds, { named: [], byPerson: true, now: 0 });
    let turns = 0;
    for (let i = 0; i < 50; i++) {
      const t = take(r);
      if (!t.key) { r = t.round; break; }
      turns++;
      r = recordOutcome(t.round, t.key, "spoke", { now: 3 });
    }
    expect(r.status).toBe("done");
    expect(turns).toBeLessThanOrEqual(seeds.length * 2);
  });

  test("a busy member moves to the end of the lap once", () => {
    let r = startRound(seeds, { named: [], byPerson: true, now: 0 });
    const step = nextCandidate(r, 1);
    r = deferBusy(step.round, step.key!);
    expect(r.queue).toEqual(["b", "c", "a"]);
    expect(r.members.find((m) => m.key === "a")!.deferred).toBe(true);
  });

  test("a person's next line restarts the lap and keeps the floor where it is", () => {
    const t = take(startRound(seeds, { named: [], byPerson: true, now: 0 }));
    const r = restartRound(t.round, seeds, { named: [], now: 5 });
    expect(r.floor_key).toBe("a");
    expect(r.queue).toEqual(["b", "c"]);
  });

  test("ending a round clears the floor and the queue", () => {
    const t = take(startRound(seeds, { named: [], byPerson: true, now: 0 }));
    const r = endRound(t.round, 9);
    expect(r.status).toBe("ended");
    expect(r.floor_key).toBeUndefined();
    expect(r.queue).toEqual([]);
  });

  test("the strip shows finished turns, then the floor, then the queue", () => {
    let t = take(startRound(seeds, { named: [], byPerson: true, now: 0 }));
    const r = recordOutcome(t.round, "a", "spoke", { now: 2 });
    t = take(r);
    expect(roundStrip(t.round).map((m) => `${m.key}:${m.state}`)).toEqual(["a:spoke", "b:floor", "c:waiting"]);
  });
});
