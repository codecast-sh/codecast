import { describe, expect, test } from "bun:test";
import { sessionQueryCompletion } from "@codecast/shared/search";
import { reposFromSessions, sessionQuerySuggestions } from "../sessionQuerySuggestions";

const at = (q: string) => sessionQueryCompletion(q);

describe("sessionQuerySuggestions", () => {
  test("operator names come from the shared list with their hints", () => {
    const rows = sessionQuerySuggestions(at("bug au"), {});
    expect(rows.map((r) => r.text)).toEqual(["author:"]);
    expect(rows[0].hint).toBe("who ran the session");
  });

  test("file: offers recent files, prefix hits first, recency breaking ties, quoted when needed", () => {
    const files = ["web/app.tsx", "docs/a b.md", "web/api.ts", "cli/app.ts"];
    expect(sessionQuerySuggestions(at("file:"), { files }).map((r) => r.text)).toEqual([
      "file:web/app.tsx",
      'file:"docs/a b.md"',
      "file:web/api.ts",
      "file:cli/app.ts",
    ]);
    expect(sessionQuerySuggestions(at("file:cli"), { files }).map((r) => r.label)).toEqual(["cli/app.ts"]);
    expect(sessionQuerySuggestions(at("file:app"), { files }).map((r) => r.label)).toEqual(["web/app.tsx", "cli/app.ts"]);
  });

  test("author: offers me, then teammates by handle, matched on any name field", () => {
    const people = [{ name: "Samvit Jain", github_username: "samvit" }, { name: "Ada", email: "ada@x.org" }, { name: "Union (Slack)", bot_kind: "slack" }];
    expect(sessionQuerySuggestions(at("author:"), { people }).map((r) => r.label)).toEqual(["me", "samvit", "Ada"]);
    expect(sessionQuerySuggestions(at("author:jain"), { people }).map((r) => r.text)).toEqual(["author:samvit"]);
  });

  test("pr: and commit: carry titles and subjects as hints", () => {
    const prs = [{ repository: "acme/web", number: 12, title: "Fix login" }];
    expect(sessionQuerySuggestions(at("pr:login"), { prs })).toEqual([{ text: "pr:acme/web#12", label: "acme/web#12", hint: "Fix login" }]);
    const commits = [{ sha: "3f2a91cdeadbeef", message: "feat: x\n\nbody" }];
    expect(sessionQuerySuggestions(at("commit:3f"), { commits })).toEqual([{ text: "commit:3f2a91c", label: "3f2a91c", hint: "feat: x" }]);
  });

  test("a value typed in full offers nothing; plain text offers nothing", () => {
    expect(sessionQuerySuggestions(at("label:api"), { labels: ["api"] })).toEqual([]);
    expect(sessionQuerySuggestions(at("fix login"), { labels: ["api"] })).toEqual([]);
  });
});

describe("reposFromSessions", () => {
  test("remote names win, folder names fill in, most recent first, each once", () => {
    expect(
      reposFromSessions([
        { git_remote_url: "git@github.com:acme/web.git", updated_at: 1 },
        { git_root: "/src/tools/", updated_at: 5 },
        { git_remote_url: "https://github.com/acme/web", updated_at: 9 },
        {},
      ]),
    ).toEqual(["acme/web", "tools"]);
  });
});
