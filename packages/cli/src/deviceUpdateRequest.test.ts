// union-line-1, 2026-11-24: a day-old cached "nothing newer" answered two
// `cast devices update` presses made after 1.1.273 shipped, and the daemon
// never read the manifest for either. A request now gets a read of its own,
// and the beat names it only once that read happened.
import { describe, expect, test } from "bun:test";
import { strictStub } from "./test-helpers/strictStub.js";
import { UpdateRequestAnswerer, type UpdateRequestDaemon } from "./deviceUpdateRequest.js";

function daemon(manifest: string | null, reads: boolean[] = []) {
  let available: string | null = null;
  const updates: number[] = [];
  const checks: number[] = [];
  const stub = strictStub<UpdateRequestDaemon>("daemon", {
    available: () => available,
    checkNow: async () => {
      checks.push(checks.length);
      const read = reads.shift() ?? true;
      if (read) available = manifest;
      return read;
    },
    update: (at) => { updates.push(at); },
  });
  return { stub, updates, checks, cached: (v: string | null) => { available = v; } };
}

describe("UpdateRequestAnswerer", () => {
  test("a release the cached answer missed is found by the request's own read and installed", async () => {
    const d = daemon("1.1.273");
    const answer = new UpdateRequestAnswerer(d.stub);
    expect(answer.checkedFor).toBe(0);
    await answer.ask(100);
    expect(d.checks).toHaveLength(1);
    expect(d.updates).toEqual([100]);
    expect(answer.checkedFor).toBe(100);
  });

  test("nothing newer: the beat names the request, which never reads again; a later press does", async () => {
    const d = daemon(null);
    const answer = new UpdateRequestAnswerer(d.stub);
    await answer.ask(100);
    await answer.ask(100);
    expect(d.checks).toHaveLength(1);
    expect(d.updates).toEqual([]);
    expect(answer.checkedFor).toBe(100);
    await answer.ask(200);
    expect(d.checks).toHaveLength(2);
    expect(answer.checkedFor).toBe(200);
  });

  test("no read (a failed fetch, a check already running): nothing is named and the next beat reads again", async () => {
    const d = daemon("1.1.273", [false]);
    const answer = new UpdateRequestAnswerer(d.stub);
    await answer.ask(100);
    expect(answer.checkedFor).toBe(0);
    expect(d.updates).toEqual([]);
    await answer.ask(100);
    expect(d.checks).toHaveLength(2);
    expect(d.updates).toEqual([100]);
  });

  test("a check that throws counts as no read", async () => {
    const answer = new UpdateRequestAnswerer(strictStub<UpdateRequestDaemon>("daemon", {
      available: () => null,
      checkNow: async () => { throw new Error("fetch failed"); },
    }));
    await answer.ask(100);
    expect(answer.checkedFor).toBe(0);
  });

  test("a newer release the daemon already knows of installs at once, without a read", async () => {
    const d = daemon("1.1.273");
    d.cached("1.1.273");
    await new UpdateRequestAnswerer(d.stub).ask(100);
    expect(d.checks).toHaveLength(0);
    expect(d.updates).toEqual([100]);
  });

  test("beats that carry the request while its read runs start no second read", async () => {
    const pending: Array<(read: boolean) => void> = [];
    const answer = new UpdateRequestAnswerer(strictStub<UpdateRequestDaemon>("daemon", {
      available: () => null,
      checkNow: () => new Promise<boolean>((resolve) => { pending.push(resolve); }),
    }));
    const first = answer.ask(100);
    await answer.ask(100);
    expect(pending).toHaveLength(1);
    pending[0]!(true);
    await first;
    expect(answer.checkedFor).toBe(100);
  });
});
