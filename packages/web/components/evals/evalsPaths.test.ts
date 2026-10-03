import { describe, expect, it } from "bun:test";
import { evalsHref, evalsHrefFor, evalsSearchTargets, evalsSenseHref, evalsSection, evalsTabLabel, parseEvalsPath, type EvalsView } from "./evalsPaths";

const at = (href: string) => {
  const [path, query = ""] = href.split("?");
  return parseEvalsPath(path, query);
};

const RUN = "role-wake-0bd46dcc-seed1-2026-10-02T15-57-10-246Z";
const BATCH = "2026-10-03T00:53:31.614Z";

describe("parseEvalsPath", () => {
  const views: EvalsView[] = [
    { view: "home", cadence: null },
    { view: "home", cadence: "nightly" },
    { view: "surface", surface: "settle", batch: null, compare: null },
    { view: "surface", surface: "settle", batch: BATCH, compare: "2026-10-01T00:00:00.000Z" },
    { view: "freeze", freezeId: "ef03830f-4363-41c1-9fe9-1e0a4532e14d", batch: BATCH, a: null, b: null },
    { view: "freeze", freezeId: "ef03830f-4363-41c1-9fe9-1e0a4532e14d", batch: null, a: RUN, b: "title-7ab2a29e-seed5-2026-10-03T01-13-08-164Z" },
    { view: "commit", sha: "0ae504f0123", surface: "settle" },
    { view: "commit", sha: "0ae504f0123", surface: null },
    { view: "patch", sha: "87d03b".padEnd(64, "0") },
    { view: "run", runId: RUN },
    { view: "compare", a: RUN, b: "title-7ab2a29e-seed5-2026-10-03T01-13-08-164Z" },
    { view: "bisect-list" },
    { view: "bisect-new", surface: "settle", good: BATCH, bad: "6cd0083b3", freeze: null },
    { view: "bisect-new", surface: null, good: null, bad: null, freeze: null },
    { view: "bisect", id: "b-settle-1003" },
    { view: "sim" },
    { view: "sim-run", session: "2026-10-02T11-06-14-581Z", run: "memberRemovedMidTurn-interleave-3" },
  ];

  it("reads back every view from the href it builds", () => {
    for (const v of views) expect(at(evalsHrefFor(v))).toEqual(v);
  });

  it("keeps batch names with colons intact through the query", () => {
    expect(evalsHref.surface("settle", { batch: BATCH })).toBe(`/evals/s/settle?batch=${encodeURIComponent(BATCH)}`);
  });

  it("tolerates a trailing slash, a hash and an encoded segment", () => {
    expect(parseEvalsPath("/evals/")).toEqual({ view: "home", cadence: null });
    expect(parseEvalsPath(`/evals/r/${RUN}#gate-no-leak`)).toEqual({ view: "run", runId: RUN });
    expect(parseEvalsPath("/evals/s/call%2Dsummary")).toMatchObject({ view: "surface", surface: "call-summary" });
  });

  it("names nothing it does not know", () => {
    for (const p of ["/evals/x", "/evals/s", "/evals/compare", "/evals/compare?a=x", "/evals/sim/one", "/evals/r/a/b", "/evals/s/%E0%A4%A", "/evalsx", "/memory"]) {
      const [path, query] = p.split("?");
      expect(parseEvalsPath(path, query ?? "").view).toBe("not-found");
    }
  });

  it("puts each view under its nav section", () => {
    expect(evalsSection(at("/evals"))).toBe("surfaces");
    expect(evalsSection(at(`/evals/r/${RUN}`))).toBe("surfaces");
    expect(evalsSection(at("/evals/bisect/new"))).toBe("bisects");
    expect(evalsSection(at("/evals/sim/a/b"))).toBe("sim");
    expect(evalsSection(at("/evals/nope"))).toBeNull();
  });

  it("carries a gate fragment on a run link", () => {
    expect(evalsHref.run(RUN, "gate-no-leak")).toBe(`/evals/r/${RUN}#gate-no-leak`);
  });
});

describe("evalsSenseHref", () => {
  it("the Line page's evals row opens the surface its newest signal names, else the wall", () => {
    expect(evalsSenseHref("settle")).toBe("/evals/s/settle");
    expect(evalsSenseHref(undefined)).toBe("/evals");
    expect(evalsSenseHref("not a surface/../x")).toBe("/evals");
  });
});

describe("evalsTabLabel", () => {
  it("names the tab by what it shows", () => {
    expect(evalsTabLabel("/evals")).toBe("Evals");
    expect(evalsTabLabel("/evals/s/settle?batch=x")).toBe("settle");
    expect(evalsTabLabel(`/evals/r/${RUN}#gate-no-leak`)).toBe("role-wake seed 1");
    expect(evalsTabLabel("/evals/sim")).toBe("Multiplayer sim");
    expect(evalsTabLabel("/evals/bisect/new?surface=settle")).toBe("Attribute settle");
  });
});

describe("evalsSearchTargets", () => {
  const known = {
    surfaces: ["settle", "title", "role-wake", "call-summary"],
    batches: { [BATCH]: ["settle", "title"] },
    freezes: [{ id: "ef03830f-4363-41c1-9fe9-1e0a4532e14d", name: "unresolvable-error" }],
  };

  it("puts an exact surface first", () => {
    expect(evalsSearchTargets("settle", known)[0]).toEqual({ kind: "surface", label: "settle", href: "/evals/s/settle" });
    expect(evalsSearchTargets("summ", known).map((t) => t.label)).toEqual(["call-summary"]);
  });

  it("opens a run id on its run page", () => {
    expect(evalsSearchTargets(RUN, known)).toContainEqual({ kind: "run", label: RUN, href: evalsHref.run(RUN) });
  });

  it("sends a batch to each surface that ran it", () => {
    expect(evalsSearchTargets(BATCH, known).map((t) => t.href)).toEqual([evalsHref.surface("settle", { batch: BATCH }), evalsHref.surface("title", { batch: BATCH })]);
  });

  it("reads a known freeze prefix as the freeze, and an unknown hex as a commit", () => {
    expect(evalsSearchTargets("ef03830f", known)).toEqual([{ kind: "freeze", label: "unresolvable-error (ef03830f)", href: evalsHref.freeze("ef03830f-4363-41c1-9fe9-1e0a4532e14d") }]);
    expect(evalsSearchTargets("6cd0083b3", known)).toEqual([{ kind: "commit", label: "commit 6cd0083b3 as the bad end", href: evalsHref.bisectNew({ bad: "6cd0083b3" }) }]);
  });

  it("finds nothing for blank input", () => {
    expect(evalsSearchTargets("   ", known)).toEqual([]);
  });
});
