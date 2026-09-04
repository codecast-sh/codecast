import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { installationCoversRepo, storeInstallation } from "./githubApp";

const base = { _id: "i1", team_id: "team_1", installation_id: 1, account_login: "codecast-sh" } as any;

describe("installationCoversRepo", () => {
  test("matches the owner and a selected repository case insensitively", () => {
    const selected = { ...base, repository_selection: "selected", repositories: [{ full_name: "Codecast-SH/Codecast" }] };
    expect(installationCoversRepo(selected, "codecast-sh/codecast")).toBe(true);
    expect(installationCoversRepo(selected, "CODECAST-SH/CODECAST")).toBe(true);
    expect(installationCoversRepo(selected, "codecast-sh/other")).toBe(false);
  });

  test("an installation on every repository still needs the owner to match", () => {
    const all = { ...base, repository_selection: "all" };
    expect(installationCoversRepo(all, "Codecast-SH/anything")).toBe(true);
    expect(installationCoversRepo(all, "someone-else/anything")).toBe(false);
  });
});

describe("storeInstallation", () => {
  test("stores the owner login in canonical form and keeps the repository list as GitHub spells it", async () => {
    const db = makeFakeDb({
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      github_app_installations: [],
    });
    await (storeInstallation as any)._handler({ db }, {
      team_id: "team_1", installation_id: 9, account_login: "Codecast-SH", account_type: "Organization",
      account_id: 1, repository_selection: "selected", repositories: [{ id: 1, name: "Codecast", full_name: "Codecast-SH/Codecast" }],
      installed_by_user_id: "u1",
    });
    const row = db._tables.github_app_installations[0];
    expect(row.account_login).toBe("codecast-sh");
    expect(row.repositories[0].full_name).toBe("Codecast-SH/Codecast");
  });
});
