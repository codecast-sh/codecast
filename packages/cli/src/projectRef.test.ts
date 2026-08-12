import { describe, expect, it } from "bun:test";
import { matchProject, looksLikeConvexId, type ProjectLike } from "./projectRef.js";

const PROJECTS: ProjectLike[] = [
  { _id: "sd72cbsfka4tq16cgpg2gftek58c8ghc", short_id: "sd-12", title: "Agent Quality" },
  { _id: "sd7de2bbc0e93d9tggthy82d4x8c9r66", short_id: "sd-13", title: "Infrastructure" },
  { _id: "sd7dqnq9hny1dtzy83as2av4z18c9z2z", short_id: "sd-14", title: "Codecast: Product" },
  { _id: "sd75q66m97st2ak4anybb8jwdh8c8ktw", short_id: "sd-15", title: "Codecast: Ops & Growth" },
];

describe("matchProject", () => {
  // The bug this module exists for: `task update <id> --project "Agent Quality"`
  // failed with "Project not found" because only the `task ls` filter resolved
  // names — every write sent the raw string to a server that speaks ids only.
  it("resolves a project by its title", () => {
    expect(matchProject(PROJECTS, "Agent Quality")).toEqual({
      kind: "one",
      id: "sd72cbsfka4tq16cgpg2gftek58c8ghc",
    });
  });

  it("resolves a title substring, case-insensitively", () => {
    expect(matchProject(PROJECTS, "agent qual")).toEqual({
      kind: "one",
      id: "sd72cbsfka4tq16cgpg2gftek58c8ghc",
    });
  });

  it("resolves a short id", () => {
    expect(matchProject(PROJECTS, "sd-13")).toEqual({
      kind: "one",
      id: "sd7de2bbc0e93d9tggthy82d4x8c9r66",
    });
  });

  it("passes a convex id straight through without consulting the list", () => {
    expect(matchProject([], "sd72cbsfka4tq16cgpg2gftek58c8ghc")).toEqual({
      kind: "id",
      id: "sd72cbsfka4tq16cgpg2gftek58c8ghc",
    });
  });

  it("reports every candidate when a substring matches several", () => {
    const result = matchProject(PROJECTS, "Codecast");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.matches.map((p) => p.title)).toEqual([
      "Codecast: Product",
      "Codecast: Ops & Growth",
    ]);
  });

  it("reports no match rather than guessing", () => {
    expect(matchProject(PROJECTS, "Nonexistent Thing")).toEqual({ kind: "none" });
  });

  // Typing the fuller name must never be the thing that breaks it.
  it("prefers an exact title over the longer titles containing it", () => {
    const withSuffix = [
      ...PROJECTS,
      { _id: "sd7newprojectidaaaaaaaaaaaaaaaaaa", short_id: "sd-16", title: "Infrastructure v2" },
    ];
    expect(matchProject(withSuffix, "Infrastructure")).toEqual({
      kind: "one",
      id: "sd7de2bbc0e93d9tggthy82d4x8c9r66",
    });
    // The longer name still resolves to itself.
    expect(matchProject(withSuffix, "Infrastructure v2")).toEqual({
      kind: "one",
      id: "sd7newprojectidaaaaaaaaaaaaaaaaaa",
    });
  });

  // `--project ''` is how you unfile a task; it must reach the server as an
  // empty value, not fail a lookup for the empty string.
  it("treats an empty ref as the clear signal, not a lookup", () => {
    expect(matchProject(PROJECTS, "")).toEqual({ kind: "empty" });
    expect(matchProject(PROJECTS, "   ")).toEqual({ kind: "empty" });
  });

  it("survives an empty or missing project list", () => {
    expect(matchProject([], "Agent Quality")).toEqual({ kind: "none" });
    expect(matchProject(undefined as any, "Agent Quality")).toEqual({ kind: "none" });
  });

  it("ignores rows with no title instead of throwing", () => {
    const untitled: ProjectLike[] = [{ _id: "sd7untitledaaaaaaaaaaaaaaaaaaaaa" }];
    expect(matchProject(untitled, "anything")).toEqual({ kind: "none" });
  });
});

describe("looksLikeConvexId", () => {
  it("accepts a convex id and rejects prose", () => {
    expect(looksLikeConvexId("sd72cbsfka4tq16cgpg2gftek58c8ghc")).toBe(true);
    expect(looksLikeConvexId("Agent Quality")).toBe(false);
    expect(looksLikeConvexId("sd-12")).toBe(false);
    // A single long lowercase word must not be mistaken for an id.
    expect(looksLikeConvexId("infrastructure")).toBe(false);
  });
});
