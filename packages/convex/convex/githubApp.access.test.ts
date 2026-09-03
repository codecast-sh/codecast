// Workspace scoping for GitHub App installation lookup.
//
// An installation is a credential: resolving one yields a token that can read
// and write the repositories it covers. Lookup therefore has to answer "which
// installations may THIS principal reach", not "which installation matches this
// owner name". The lookup used to answer the second question — it tried the
// named team first and then scanned by account_login across every team — so a
// member of team A resolved team B's installation for any repo under an owner
// name they could guess.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getInstallationForRepo, getInstallationForRepoInTeam } from "./githubApp";

const TEAM_A = "t_a";
const TEAM_B = "t_b";
const USER_A = "u_a";
const USER_B = "u_b";

const PRIVATE_CONV = "conv_private";

function tables(installations: any[]) {
  return {
    teams: [
      { _id: TEAM_A, name: "Team A" },
      { _id: TEAM_B, name: "Team B" },
    ],
    team_memberships: [
      { _id: "tm_a", user_id: USER_A, team_id: TEAM_A, role: "member", joined_at: 1 },
      { _id: "tm_b", user_id: USER_B, team_id: TEAM_B, role: "member", joined_at: 1 },
    ],
    // Only the narrowing test links this; inert for every other case.
    conversations: [
      { _id: PRIVATE_CONV, user_id: USER_B, team_id: TEAM_B, is_private: true },
    ],
    github_app_installations: installations,
  };
}

// Team B's installation on the `acme` account.
function teamBInstallation(extra: Record<string, any> = {}) {
  return {
    _id: "gai_b",
    team_id: TEAM_B,
    installation_id: 555,
    account_login: "acme",
    account_type: "Organization",
    account_id: 900,
    repository_selection: "all",
    created_at: 1,
    updated_at: 1,
    ...extra,
  };
}

// Team A's OWN installation on the same account. A fixture holding one
// installation cannot tell "scoped correctly" apart from "found nothing at
// all" — both return null for the outsider. Two rows on one account can.
function teamAInstallation(extra: Record<string, any> = {}) {
  return teamBInstallation({ _id: "gai_a", team_id: TEAM_A, installation_id: 111, ...extra });
}

function ctx(installations: any[]) {
  return { db: makeFakeDb(tables(installations)) } as any;
}

function lookup(installations: any[], args: Record<string, any>) {
  return (getInstallationForRepo as any)._handler(ctx(installations), {
    repository: "acme/widgets",
    ...args,
  });
}

describe("getInstallationForRepo workspace scoping", () => {
  test("a member of the owning team resolves the installation", async () => {
    const found = await lookup([teamBInstallation()], { user_id: USER_B, team_id: TEAM_B });
    expect(found?.installation_id).toBe(555);
  });

  test("resolves without a named team from the caller's own memberships", async () => {
    const found = await lookup([teamBInstallation()], { user_id: USER_B });
    expect(found?.installation_id).toBe(555);
  });

  // The hole: an outsider used to reach team B's credential through the
  // account_login fallback.
  test("an outsider gets nothing when they name no team", async () => {
    expect(await lookup([teamBInstallation()], { user_id: USER_A })).toBeNull();
  });

  test("an outsider gets nothing when they name their own team", async () => {
    expect(await lookup([teamBInstallation()], { user_id: USER_A, team_id: TEAM_A })).toBeNull();
  });

  test("naming a team you do not belong to is refused, not answered", async () => {
    await expect(lookup([teamBInstallation()], { user_id: USER_A, team_id: TEAM_B }))
      .rejects.toThrow(/team membership required/i);
  });

  // Repository coverage still decides within a team the caller does belong to:
  // a `selected` installation only answers for the repos it lists.
  test("a selected installation answers only for its listed repositories", async () => {
    const selected = teamBInstallation({
      repository_selection: "selected",
      repositories: [{ id: 1, name: "gadgets", full_name: "acme/gadgets" }],
    });
    expect(await lookup([selected], { user_id: USER_B, team_id: TEAM_B })).toBeNull();

    const covering = teamBInstallation({
      repository_selection: "selected",
      repositories: [{ id: 2, name: "widgets", full_name: "acme/widgets" }],
    });
    expect((await lookup([covering], { user_id: USER_B, team_id: TEAM_B }))?.installation_id).toBe(555);
  });

  test("a different account login never matches", async () => {
    const other = teamBInstallation({ account_login: "other-org" });
    expect(await lookup([other], { user_id: USER_B, team_id: TEAM_B })).toBeNull();
  });

  // The sharpest cross-tenant case, and the one every test above is too weak to
  // make: BOTH teams installed on `acme`, with team B's row listed first, so the
  // deleted by_account_login fallback would hand team B's credential to USER_A.
  // Scoping has to PICK the caller's own row, not merely fail to find one.
  test("two teams on one account each resolve their own installation", async () => {
    const both = [teamBInstallation(), teamAInstallation()];
    expect((await lookup(both, { user_id: USER_A, team_id: TEAM_A }))?.installation_id).toBe(111);
    expect((await lookup(both, { user_id: USER_A }))?.installation_id).toBe(111);
    expect((await lookup(both, { user_id: USER_B }))?.installation_id).toBe(555);
  });

  // GitHub refuses every token minted from a suspended installation, so
  // resolving one buys a failed round trip instead of a clean null.
  test("a suspended installation stops answering, even for its own team", async () => {
    const suspended = teamBInstallation({ suspended_at: 1_700_000_000_000 });
    expect(await lookup([suspended], { user_id: USER_B, team_id: TEAM_B })).toBeNull();
  });

  // effectiveTeamForResource narrows any record linking a private conversation
  // down to no team. This table links none, so the state is unreachable today —
  // but a credential must never be narrowed that way, and the narrowing reads
  // to the caller exactly like "nobody installed this app". Pinned so it stays
  // loud rather than becoming a silent denial for the owning team.
  test("an installation that resolves to no team throws instead of vanishing", async () => {
    const narrowed = teamBInstallation({ conversation_id: PRIVATE_CONV });
    await expect(lookup([narrowed], { user_id: USER_B, team_id: TEAM_B }))
      .rejects.toThrow(/resolved to no team/);
  });
});

// The team-scoped entry point serves callers with no user to check — webhook
// processing knows only which team the repository work belongs to.
describe("getInstallationForRepoInTeam", () => {
  function lookupInTeam(installations: any[], team_id: string) {
    return (getInstallationForRepoInTeam as any)._handler(ctx(installations), {
      repository: "acme/widgets",
      team_id,
    });
  }

  test("returns the installation the named team owns", async () => {
    expect((await lookupInTeam([teamBInstallation()], TEAM_B))?.installation_id).toBe(555);
  });

  test("another team's installation is never substituted", async () => {
    expect(await lookupInTeam([teamBInstallation()], TEAM_A)).toBeNull();
  });

  test("the caller's own row wins when two teams share an account", async () => {
    const both = [teamBInstallation(), teamAInstallation()];
    expect((await lookupInTeam(both, TEAM_A))?.installation_id).toBe(111);
    expect((await lookupInTeam(both, TEAM_B))?.installation_id).toBe(555);
  });

  // This is the entry point webhooks use, so it is where a suspended
  // installation would actually cost a failed mint against GitHub.
  test("a suspended installation stops answering here too", async () => {
    const suspended = teamBInstallation({ suspended_at: 1_700_000_000_000 });
    expect(await lookupInTeam([suspended], TEAM_B)).toBeNull();
  });
});

// The webhook path had its own copy of the lookup, with the same
// `by_account_login` fallback. Both of its callers always know their team, so
// that fallback could only ever fire to hand a webhook another tenant's
// credential. It is deleted and both callers now use the scoped resolver.
describe("the webhook lookup is scoped too", () => {
  test("githubWebhooks no longer defines its own installation lookup", async () => {
    const src = await Bun.file(
      new URL("./githubWebhooks.ts", import.meta.url).pathname,
    ).text();
    expect(src).not.toContain("export const getInstallationForRepository");
  });

  test("no CREDENTIAL lookup there falls back to an unscoped owner scan", async () => {
    // `by_account_login` still appears once, and that one is legitimate: an
    // inbound webhook carries no team, so the owner scan is how it works out
    // which team the repository belongs to in the first place. It reads an
    // installation for attribution and never mints a token from it. The rule
    // this pins is narrower than "never scan by owner": a lookup that RESOLVES
    // A CREDENTIAL must be scoped.
    //
    // The scan used to sit inline in matchPRToConversation. It now lives in
    // resolveTeamForRepository, because push ingest and trigger scoping ask the
    // same question. That is one named place instead of three inline copies, so
    // what this test pins is where it lives AND what it is allowed to return.
    const src = await Bun.file(
      new URL("./githubWebhooks.ts", import.meta.url).pathname,
    ).text();
    // Count the CODE form. A bare substring search also matches the comment
    // left where the deleted lookup used to be, which explains the fallback.
    const scans = src.match(/\.withIndex\("by_account_login"/g) ?? [];
    expect(scans.length).toBe(1);
    // The surviving scan must live in the attribution resolver, not near a mint.
    const idx = src.indexOf('.withIndex("by_account_login"');
    const enclosing = src.lastIndexOf("export async function", idx);
    expect(src.slice(enclosing, idx)).toContain("resolveTeamForRepository");

    // And it may hand back a team to attribute to, nothing else. A token read
    // here would be exactly the unscoped credential resolution this forbids.
    const body = src.slice(enclosing, src.indexOf("\n}", idx));
    expect(body).toContain("installation?.team_id");
    expect(body).not.toContain("token");
  });

  test("its callers go through the team-scoped resolver", async () => {
    const src = await Bun.file(
      new URL("./githubWebhooks.ts", import.meta.url).pathname,
    ).text();
    const calls = src.match(/internal\.githubApp\.getInstallationForRepoInTeam/g) ?? [];
    expect(calls.length).toBe(2);
  });
});
