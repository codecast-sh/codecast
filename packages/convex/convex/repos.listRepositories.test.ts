// The repository list reads one row per repository a team's activity names,
// never the team's pull requests and commits themselves: those rows are heavy
// (a pull request carries its files, commits and checks), and taking hundreds
// of them per team ran listRepositories out of memory on prod.
import { expect, test } from "bun:test";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { listRepositories } from "./repos";

// Counts every document a query hands back, the unit that filled the 64 MB.
function countingDb(db: any, docs = { n: 0 }) {
  const wrap = (q: any): any =>
    new Proxy(q, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== "function") return value;
        return (...args: any[]) => {
          const out = value.apply(target, args);
          if (prop === "first") return out.then((row: any) => (row && docs.n++, row));
          if (prop === "take" || prop === "collect") return out.then((rows: any[]) => ((docs.n += rows.length), rows));
          return out && typeof out === "object" && !("then" in out) ? wrap(out) : out;
        };
      },
    });
  return new Proxy(db, { get: (t, p) => (p === "query" ? (table: string) => wrap(t.query(table)) : t[p]) });
}

test("lists every repository a team's pull requests and commits name, one read per repository", async () => {
  const repos = ["acme/api", "acme/web", "acme/mobile"];
  const pull_requests = repos.flatMap((repository, r) =>
    Array.from({ length: 400 }, (_, i) => ({ _id: `pr${r}_${i}`, team_id: "team", repository, number: i, files: [] })),
  );
  const commits = [
    ...repos.flatMap((repository, r) =>
      Array.from({ length: 400 }, (_, i) => ({ _id: `c${r}_${i}`, team_id: "team", repository, timestamp: i, sha: `${r}${i}` })),
    ),
    // Only commits name this one; a commit with no repository names nothing.
    { _id: "c_cli", team_id: "team", repository: "acme/cli", timestamp: 1, sha: "x" },
    { _id: "c_none", team_id: "team", timestamp: 2, sha: "y" },
    { _id: "c_other", team_id: "other-team", repository: "else/where", timestamp: 3, sha: "z" },
  ];
  const docs = { n: 0 };
  const db = countingDb(
    makeFakeDb(
      {
        users: [{ _id: "viewer" }],
        team_memberships: [{ _id: "m1", user_id: "viewer", team_id: "team" }],
        github_app_installations: [],
        repo_sources: [],
        pull_requests,
        commits,
      },
      { indexes: schemaIndexes(schema) },
    ),
    docs,
  );
  const ctx = { auth: { getUserIdentity: async () => ({ subject: "viewer|sess", tokenIdentifier: "t" }) }, db };

  const listed = (await (listRepositories as any)._handler(ctx, {})).map((r: any) => r.repository);

  expect(listed).toEqual(["acme/api", "acme/cli", "acme/mobile", "acme/web"]);
  expect(docs.n).toBeLessThan(20);
});
