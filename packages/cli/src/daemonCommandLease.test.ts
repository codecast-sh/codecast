import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  discardPrimedClaim,
  primeCommandClaims,
  releaseStrandedCommandClaims,
  takePrimedClaim,
} from "./daemon.js";

// The command lease over the wire. The decision itself lives on the server and
// is tested there; what these cover is the daemon half: one round trip for a
// whole batch instead of one per command, a lease it primed but will not run
// handed straight back, and the leases a dead daemon left behind released by
// the next one.

const SITE = "https://example.invalid";
const TOKEN = "tok";

type Call = { command_id: string; boot_id: string; release?: boolean };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records every claim request and answers each with `answer(call)`. */
function stubFetch(answer: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return { ok: true, json: async () => answer(body) } as any;
  }) as any;
  return calls;
}

describe("batch claims", () => {
  test("a batch costs one round trip per command and the executor spends the answer", async () => {
    const calls = stubFetch(() => ({ claimed: true }));
    primeCommandClaims(["a", "b", "c"], SITE, TOKEN);
    // All three requests are already out before the first command runs.
    expect(calls.map((c) => c.command_id).sort()).toEqual(["a", "b", "c"]);

    expect(await takePrimedClaim("a", SITE, TOKEN)).toEqual({ claimed: true });
    expect(calls.length).toBe(3); // the primed answer, not a second ask
    await takePrimedClaim("b", SITE, TOKEN);
    await takePrimedClaim("c", SITE, TOKEN);
    expect(calls.length).toBe(3);
  });

  test("priming the same command twice asks once", () => {
    const calls = stubFetch(() => ({ claimed: true }));
    primeCommandClaims(["dup"], SITE, TOKEN);
    primeCommandClaims(["dup"], SITE, TOKEN);
    expect(calls.length).toBe(1);
  });

  test("a command nobody primed still claims on its own", async () => {
    const calls = stubFetch(() => ({ claimed: true }));
    expect(await takePrimedClaim("solo", SITE, TOKEN)).toEqual({ claimed: true });
    expect(calls.length).toBe(1);
  });

  test("a lease this daemon will not run is handed back", async () => {
    const calls = stubFetch(() => ({ claimed: true }));
    primeCommandClaims(["deferred"], SITE, TOKEN);
    discardPrimedClaim("deferred", SITE, TOKEN);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(2);
    expect(calls[1]).toMatchObject({ command_id: "deferred", release: true });
  });

  test("a refused claim is not released", async () => {
    const calls = stubFetch(() => ({ claimed: false, reason: "held_by_other" }));
    primeCommandClaims(["taken"], SITE, TOKEN);
    discardPrimedClaim("taken", SITE, TOKEN);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(1);
  });

  test("discarding a command that was never primed does nothing", async () => {
    const calls = stubFetch(() => ({ claimed: true }));
    discardPrimedClaim("unknown", SITE, TOKEN);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(0);
  });
});

describe("leases stranded by the previous daemon", () => {
  const config = { auth_token: TOKEN, convex_url: "https://example.convex.cloud" } as any;
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "claims-"));
  const write = (dir: string, bootId: string, ids: unknown) =>
    fs.writeFileSync(path.join(dir, `daemon.claims.${bootId}.json`), JSON.stringify({ boot_id: bootId, ids }));

  test("the next daemon releases them under the boot id that took them", async () => {
    const calls = stubFetch(() => ({ released: true }));
    const dir = tmpDir();
    write(dir, "deadbeef", ["x", "y"]);

    expect(await releaseStrandedCommandClaims(config, dir, "0ff1ce")).toBe(2);
    expect(calls.map((c) => c.command_id).sort()).toEqual(["x", "y"]);
    // Only the holder may let go, so the request cannot carry our own id.
    for (const call of calls) {
      expect(call.boot_id).toBe("deadbeef");
      expect(call.release).toBe(true);
    }
    // Read once. A second boot must not re-release commands the fleet has moved on from.
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("our own file is left alone", async () => {
    const calls = stubFetch(() => ({ released: true }));
    const dir = tmpDir();
    write(dir, "0ff1ce", ["x"]);
    expect(await releaseStrandedCommandClaims(config, dir, "0ff1ce")).toBe(0);
    expect(calls.length).toBe(0);
    expect(fs.readdirSync(dir).length).toBe(1);
  });

  test("two dead daemons each get their own ids back under their own id", async () => {
    // One file per boot id, because a shared file lets two daemons on one
    // machine overwrite and then delete each other's record.
    const calls = stubFetch(() => ({ released: true }));
    const dir = tmpDir();
    write(dir, "aaaa", ["x"]);
    write(dir, "bbbb", ["y"]);
    expect(await releaseStrandedCommandClaims(config, dir, "0ff1ce")).toBe(2);
    expect(calls.find((c) => c.command_id === "x")!.boot_id).toBe("aaaa");
    expect(calls.find((c) => c.command_id === "y")!.boot_id).toBe("bbbb");
  });

  test("no file, an empty list, unreadable json and unrelated files are quiet no-ops", async () => {
    const calls = stubFetch(() => ({ released: true }));
    expect(await releaseStrandedCommandClaims(config, tmpDir(), "0ff1ce")).toBe(0);

    const empty = tmpDir();
    write(empty, "deadbeef", []);
    expect(await releaseStrandedCommandClaims(config, empty, "0ff1ce")).toBe(0);

    const junk = tmpDir();
    fs.writeFileSync(path.join(junk, "daemon.claims.deadbeef.json"), "not json");
    fs.writeFileSync(path.join(junk, "daemon.log"), "unrelated");
    expect(await releaseStrandedCommandClaims(config, junk, "0ff1ce")).toBe(0);
    expect(fs.readdirSync(junk)).toEqual(["daemon.log"]);

    expect(await releaseStrandedCommandClaims(config, "/nope/does/not/exist", "0ff1ce")).toBe(0);
    expect(calls.length).toBe(0);
  });
});
