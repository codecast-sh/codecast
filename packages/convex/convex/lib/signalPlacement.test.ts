import { describe, expect, test } from "bun:test";
import { placeSignal } from "./signalPlacement";

const WS = "team:t1";

type Finder = { source: string; single_purpose?: boolean };
const project = (id: string, title: string, finders: Finder[], isDefault?: boolean) => ({
  _id: id,
  title,
  workspace: WS,
  line_profile: { finders, ...(isDefault === undefined ? {} : { default: isDefault }) },
});

function ctxWith(projects: ReturnType<typeof project>[]) {
  return {
    db: {
      normalizeId: () => null,
      get: async (id: string) => projects.find((p) => p._id === id) ?? null,
      query: (table: string) => ({
        withIndex: () => ({
          collect: async () => (table === "projects" ? projects : []),
          first: async () => null,
          take: async () => (table === "projects" ? projects : []),
        }),
      }),
    },
  };
}

describe("placeSignal from a server filer (no repo profile)", () => {
  test("a source whose finder sits on the profile's default project files there, for Ground to place", async () => {
    const ctx = ctxWith([
      project("p-aq", "Agent Quality", [{ source: "sentry:union-sentry" }, { source: "sdk:union-errors" }], true),
      project("p-mf", "Matching", [{ source: "union.match", single_purpose: true }], false),
    ]);
    expect(await placeSignal(ctx, WS, { source: "sentry:union-sentry" }, {})).toEqual({ project_id: "p-aq", placed: "default" });
  });

  test("the repo profile's default_project still wins over the published default", async () => {
    const ctx = ctxWith([
      project("p-aq", "Agent Quality", [{ source: "sdk:union-errors" }], true),
      project("p-in", "Infrastructure", [], false),
    ]);
    expect(await placeSignal(ctx, WS, { source: "sdk:union-errors" }, { default_project: "Infrastructure" })).toEqual({ project_id: "p-in", placed: "default" });
  });

  test("a single-purpose source settles its own project", async () => {
    const ctx = ctxWith([
      project("p-aq", "Agent Quality", [], true),
      project("p-mf", "Matching", [{ source: "union.match", single_purpose: true }], false),
    ]);
    expect(await placeSignal(ctx, WS, { source: "union.match" }, {})).toEqual({ project_id: "p-mf", placed: "source" });
  });

  test("a source no profile publishes files in no project", async () => {
    const ctx = ctxWith([project("p-aq", "Agent Quality", [{ source: "sdk:union-errors" }], true)]);
    expect(await placeSignal(ctx, WS, { source: "sentry:other" }, {})).toEqual({ project_id: null, placed: "none" });
  });
});
