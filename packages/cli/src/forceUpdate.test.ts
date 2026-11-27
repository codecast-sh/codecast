// `cast force-update` (ct-102483): which floor a call moves. Non-staff name
// their team; team admins lower or clear it; no floor is set above the
// newest published release.
import { describe, expect, test } from "bun:test";
import { runForceUpdate, type ForceUpdateDeps, type ForceUpdateOptions } from "./forceUpdate";

function harness(o: { staff?: boolean; latest?: string | null; active?: string | null } = {}) {
  const calls: Array<{ path: string; body: any }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const global: string[] = [];
  const finished: string[] = [];
  const deps: ForceUpdateDeps = {
    latest: async () => (o.latest === undefined ? "1.1.310" : o.latest),
    setGlobal: async (v) => { if (!o.staff) return false; global.push(v); return true; },
    team: async (name) => ({ teamId: `team_${name}`, name }),
    activeTeam: async () => (o.active === undefined ? "Acme" : o.active),
    post: async (path, body) => {
      calls.push({ path, body: structuredClone(body) });
      if (path === "/cli/team-cli-floor/lower") return { team: "Acme", version: (body.version as string) ?? null, changed: true };
      return { team: "Acme", version: body.version, changed: true };
    },
    finish: async (v) => { finished.push(v); },
    log: (l) => out.push(l),
    error: (l) => err.push(l),
  };
  const run = (version: string | undefined, opts: ForceUpdateOptions = {}) => runForceUpdate(version, opts, deps);
  return { run, calls, out, err, global, finished };
}

describe("cast force-update without --team", () => {
  test("platform staff set the global floor", async () => {
    const h = harness({ staff: true });
    expect(await h.run("1.1.306")).toBe(0);
    expect(h.global).toEqual(["1.1.306"]);
    expect(h.calls).toEqual([]);
  });

  test("anyone else is told which --team they meant, and no floor moves", async () => {
    const h = harness();
    expect(await h.run("1.1.306")).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.err.join("\n")).toContain("cast force-update 1.1.306 --team Acme");
    const personal = harness({ active: null });
    expect(await personal.run("1.1.306")).toBe(1);
    expect(personal.err.join("\n")).toContain("pass --team <team>");
  });
});

describe("a team's floor", () => {
  test("--team raises it", async () => {
    const h = harness();
    expect(await h.run("1.1.306", { team: "Acme" })).toBe(0);
    expect(h.calls).toEqual([{ path: "/cli/team-cli-floor/set", body: { team_id: "team_Acme", version: "1.1.306" } }]);
  });

  test("--lower-to and --clear lower and clear it, and take a team and no version", async () => {
    const h = harness();
    expect(await h.run(undefined, { team: "Acme", lowerTo: "1.1.300" })).toBe(0);
    expect(await h.run(undefined, { team: "Acme", clear: true })).toBe(0);
    expect(h.calls).toEqual([
      { path: "/cli/team-cli-floor/lower", body: { team_id: "team_Acme", version: "1.1.300" } },
      { path: "/cli/team-cli-floor/lower", body: { team_id: "team_Acme" } },
    ]);
    expect(h.out).toEqual(["Acme's minimum CLI version lowered to 1.1.300", "Acme's minimum CLI version cleared"]);
    expect(await h.run(undefined, { clear: true })).toBe(1);
    expect(await h.run("1.1.300", { team: "Acme", clear: true })).toBe(1);
    expect(await h.run(undefined, { team: "Acme", clear: true, lowerTo: "1.1.300" })).toBe(1);
    expect(h.calls).toHaveLength(2);
  });
});

describe("a floor above every published release", () => {
  test("is refused before anything moves, on every path", async () => {
    const h = harness({ staff: true, latest: "1.1.306" });
    expect(await h.run("1.1.307")).toBe(1);
    expect(await h.run("1.1.307", { team: "Acme" })).toBe(1);
    expect(await h.run("1.1.307", { deploy: "dp-9" })).toBe(1);
    expect(await h.run(undefined, { team: "Acme", lowerTo: "1.1.307" })).toBe(1);
    expect(h.err[0]).toContain("1.1.307 is newer than the newest release (1.1.306, latest.json)");
    expect([h.global, h.calls, h.finished]).toEqual([[], [], []]);
    // The release itself is fine.
    expect(await h.run("1.1.306", { deploy: "dp-9" })).toBe(0);
    expect(h.finished).toEqual(["1.1.306"]);
  });

  test("an unreadable latest.json is said, not taken as a refusal", async () => {
    const h = harness({ latest: null });
    expect(await h.run("1.1.306", { team: "Acme" })).toBe(0);
    expect(h.err).toEqual(["Could not read latest.json, so 1.1.306 is not checked against the newest release."]);
  });

  test("a malformed version is refused", async () => {
    const h = harness({ staff: true });
    expect(await h.run("latest")).toBe(1);
    expect(await h.run(undefined)).toBe(1);
    expect(h.global).toEqual([]);
  });
});
