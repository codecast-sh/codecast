import { describe, expect, test } from "bun:test";
import { holdRepoLease, leaseRouteMissing } from "./repoLease";

// The client side of the repository's lease: a holder that lost it (the server
// says another holds it, or it has not renewed for half the lease) knows, and
// asks the server outright before anything that must happen under it.

function server(answers: Array<Record<string, unknown> | Error>) {
  const ops: string[] = [];
  const post = async (_path: string, body: Record<string, unknown>) => {
    ops.push(String(body.op));
    if (body.op === "release") return { released: true };
    const next = answers.shift() ?? { held: true };
    if (next instanceof Error) throw next;
    return next;
  };
  return { ops, post };
}

describe("holdRepoLease", () => {
  test("assertHeld asks the server and is false once another holder has it; retake takes it back when free", async () => {
    const s = server([{ held: true }, { held: true }, { held: false, holder: "merge B" }, { held: true }]);
    const lease = await holdRepoLease(s.post, { repository: "o/r", holder: "merge A", log: () => {}, renewMs: 1e9 });
    expect(await lease.assertHeld()).toBe(true);
    expect(await lease.assertHeld()).toBe(false);
    // Lost stays lost without asking again, until a take succeeds.
    expect(await lease.assertHeld()).toBe(false);
    expect(await lease.retake()).toBe(true);
    expect(await lease.assertHeld()).toBe(true);
    await lease.release();
    expect(s.ops).toEqual(["take", "renew", "renew", "take", "renew", "release"]);
  });

  test("a background renewal answered by another holder marks it lost", async () => {
    const s = server([{ held: true }, { held: false, holder: "merge B" }]);
    const lease = await holdRepoLease(s.post, { repository: "o/r", holder: "merge A", log: () => {}, renewMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    expect(await lease.assertHeld()).toBe(false);
    await lease.release();
  });

  test("a holder that has not renewed for half the lease (a sleeping laptop) counts it lost without asking", async () => {
    let clock = 0;
    const s = server([{ held: true }]);
    const lease = await holdRepoLease(s.post, { repository: "o/r", holder: "merge A", log: () => {}, renewMs: 1e9, staleMs: 1000, now: () => clock });
    clock = 1001;
    expect(await lease.assertHeld()).toBe(false);
    expect(s.ops).toEqual(["take"]);
    await lease.release();
  });

  test("a post that fails on the way while another holds it keeps waiting; a missing route or a refusal ends the wait", async () => {
    const s = server([{ held: false, holder: "merge B", since: 0 }, new Error("fetch failed"), { held: false, holder: "merge B", since: 0 }, { held: true }]);
    const lines: string[] = [];
    const lease = await holdRepoLease(s.post, { repository: "o/r", holder: "merge A", log: (l) => lines.push(l), pollMs: 1, renewMs: 1e9, now: () => 0 });
    // Held only once the server said so: the failed post neither proceeded nor gave up.
    expect(s.ops).toEqual(["take", "take", "take", "take"]);
    expect(lines.some((l) => l.startsWith("could not ask for the lease on o/r (fetch failed)"))).toBe(true);
    await lease.release();
    const missing = new Error("this codecast server has no /cli/repo-lease route — it needs a newer deployment.");
    const old = server([missing]);
    const err = await holdRepoLease(old.post, { repository: "o/r", holder: "x", log: () => {}, pollMs: 1 }).then(() => null, (e: Error) => e);
    expect(leaseRouteMissing(err)).toBe(true);
    const refused = server([new Error("Run r1 cannot lease o/r: neither its workspace nor any of your teams works on it.")]);
    await expect(holdRepoLease(refused.post, { repository: "o/r", holder: "x", log: () => {}, pollMs: 1 })).rejects.toThrow("cannot lease o/r");
    expect(refused.ops).toEqual(["take"]);
  });
});
