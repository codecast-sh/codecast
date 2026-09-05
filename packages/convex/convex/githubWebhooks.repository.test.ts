// The owner of a repository is looked up by `by_account_login`, which stores
// the canonical spelling. A webhook or a person naming the owner with capitals
// must reach the same installation.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { resolveTeamForRepository } from "./githubWebhooks";

describe("resolveTeamForRepository", () => {
  test("an owner spelled with capitals routes to the installation stored in canonical form", async () => {
    const ctx = { db: makeFakeDb({
      github_app_installations: [{ _id: "i1", team_id: "team_1", installation_id: 1, account_login: "codecast-sh" }],
    }) };
    expect(await resolveTeamForRepository(ctx, "Codecast-SH/Codecast")).toBe("team_1" as any);
  });
});
