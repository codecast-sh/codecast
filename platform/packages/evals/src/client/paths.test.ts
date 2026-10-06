import { describe, expect, it } from "bun:test";
import { evalsPaths, evalsSection, type EvalsView } from "./paths";

// Codecast's grammar at its own base: every case below is the codecast test, unchanged.
const { canonicalPath: evalsCanonicalPath, href: evalsHref, hrefFor: evalsHrefFor, searchTargets: evalsSearchTargets, senseHref: evalsSenseHref, tabLabel: evalsTabLabel, parse: parseEvalsPath } = evalsPaths("/evals");

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
    { view: "freeze", freezeId: "ef03830f", batch: BATCH, a: null, b: null },
    { view: "freeze", freezeId: "ef03830f", batch: null, a: RUN, b: "title-7ab2a29e-seed5-2026-10-03T01-13-08-164Z" },
    { view: "commit", sha: "0ae504f0123", surface: "settle" },
    { view: "commit", sha: "0ae504f0123", surface: null },
    { view: "patch", sha: "87d03b".padEnd(64, "0") },
    { view: "run", runId: RUN },
    { view: "compare", a: RUN, b: "title-7ab2a29e-seed5-2026-10-03T01-13-08-164Z" },
    { view: "bisect-list" },
    { view: "bisect-new", surface: "settle", good: BATCH, bad: "6cd0083b3", freeze: null },
    { view: "bisect-new", surface: null, good: null, bad: null, freeze: null },
    { view: "bisect-new", surface: "settle", good: BATCH, bad: "6cd0083b3", freeze: null, all: true },
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
    expect(evalsSearchTargets("6cd0083b3", known)).toEqual([{ kind: "commit", label: "commit 6cd0083b3", href: evalsHref.commit("6cd0083b3") }]);
  });

  it("offers runs and freezes the index found by prefix, not only full ids", () => {
    const found = { ...known, freezes: [...known.freezes, { id: "jx7btyt:100", name: "the broken moment" }], runs: [{ id: RUN, surface: "settle", freezeName: "unresolvable-error" }] };
    expect(evalsSearchTargets(RUN.slice(0, 12), found)).toContainEqual({ kind: "run", label: RUN, href: evalsHref.run(RUN) });
    expect(evalsSearchTargets("jx7b", found)).toContainEqual({ kind: "freeze", label: "the broken moment (jx7btyt:)", href: evalsHref.freeze("jx7btyt:100") });
  });

  it("finds nothing for blank input", () => {
    expect(evalsSearchTargets("   ", known)).toEqual([]);
  });
});

describe("addresses carry identifiers only", () => {
  const FULL = "ef03830f-4363-41c1-9fe9-1e0a4532e14d";
  const LABEL = "org-review-opus-ct56470-v1";

  it("names a freeze by its 8-character prefix", () => {
    expect(evalsHref.freeze(FULL)).toBe("/evals/f/ef03830f");
    expect(evalsHref.bisectNew({ surface: "title", freeze: FULL })).toBe("/evals/bisect/new?surface=title&freeze=ef03830f");
  });

  it("keeps a stamp or a sha as itself and hashes any other batch name", () => {
    expect(evalsHref.surface("title", { batch: BATCH })).toContain(encodeURIComponent(BATCH));
    expect(evalsHref.bisectNew({ surface: "title", good: "6cd0083b3", bad: BATCH })).toContain("good=6cd0083b3");
    const href = evalsHref.surface("title", { batch: LABEL, compare: `${BATCH}~line-branch` });
    expect(href).not.toContain("org-review");
    expect(href).not.toContain("line-branch");
    expect(href).toMatch(/batch=_[0-9a-f]{8}&compare=_[0-9a-f]{8}$/);
  });

  it("brings any typed or older address to that form, and anything else to the wall", () => {
    expect(evalsCanonicalPath(`/evals/f/${FULL}?batch=${LABEL}`)).toMatch(/^\/evals\/f\/ef03830f\?batch=_[0-9a-f]{8}$/);
    expect(evalsCanonicalPath(`/evals/r/${RUN}#gate-no-leak`)).toBe(`/evals/r/${RUN}#gate-no-leak`);
    expect(evalsCanonicalPath("/evals/r/not a run id")).toBe("/evals");
    expect(evalsCanonicalPath("/evals/whatever/this/is")).toBe("/evals");
    expect(evalsCanonicalPath("/evals/s/title?batch=" + encodeURIComponent(BATCH))).toBe(evalsHref.surface("title", { batch: BATCH }));
    // Idempotent: a canonical address stays as it is.
    const once = evalsCanonicalPath(`/evals/bisect/new?surface=title&good=${LABEL}&bad=${BATCH}&freeze=${FULL}`);
    expect(evalsCanonicalPath(once)).toBe(once);
  });
});

describe("another base", () => {
  const union = evalsPaths("/admin/evals/v2/");
  const FULL = "ef03830f-4363-41c1-9fe9-1e0a4532e14d";

  it("builds every link under the base and reads each back", () => {
    expect(union.basePath).toBe("/admin/evals/v2");
    expect(union.href.home()).toBe("/admin/evals/v2");
    expect(union.href.surface("outreach", { batch: BATCH })).toBe(`/admin/evals/v2/s/outreach?batch=${encodeURIComponent(BATCH)}`);
    expect(union.href.run(RUN, "gate-no-leak")).toBe(`/admin/evals/v2/r/${RUN}#gate-no-leak`);
    for (const v of [{ view: "home", cadence: null }, { view: "run", runId: RUN }, { view: "freeze", freezeId: "ef03830f", batch: null, a: null, b: null }, { view: "bisect-list" }] as EvalsView[]) {
      const [path, query = ""] = union.hrefFor(v).split("?");
      expect(union.parse(path!, query)).toEqual(v);
    }
  });

  it("names nothing outside the base, and nothing of another base", () => {
    expect(union.isPath("/admin/evals/v2")).toBe(true);
    expect(union.isPath("/admin/evals/v2/s/x")).toBe(true);
    expect(union.isPath("/admin/evals/v20")).toBe(false);
    expect(union.isPath("/evals")).toBe(false);
    expect(union.parse("/evals/s/settle").view).toBe("not-found");
    expect(union.parse("/admin/evals/s/settle").view).toBe("not-found");
    expect(evalsPaths("/evals").parse("/admin/evals/v2/s/settle").view).toBe("not-found");
  });

  it("canonicalises under its own base", () => {
    expect(union.canonicalPath(`/admin/evals/v2/f/${FULL}`)).toBe("/admin/evals/v2/f/ef03830f");
    expect(union.canonicalPath("/admin/evals/v2/nowhere")).toBe("/admin/evals/v2");
  });

  it("a root mount keeps every address absolute", () => {
    const root = evalsPaths("/");
    expect(root.href.home()).toBe("/");
    expect(root.href.bisectList()).toBe("/bisect");
    expect(root.parse("/s/settle")).toEqual({ view: "surface", surface: "settle", batch: null, compare: null });
  });
});
