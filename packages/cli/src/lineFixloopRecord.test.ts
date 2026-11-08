// The nightly recorder on a real repository: it reads the mirror's branch, not
// the checkout's working tree, and sends each change once and each fix with the
// change whose lines it changed.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { freshMirror, recordRepository } from "./lineFixloopRecord";

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

describe("recordRepository", () => {
  test("records main from the mirror and traces the fix to the change it repaired", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixloop-"));
    const origin = path.join(root, "origin");
    fs.mkdirSync(origin);
    g(origin, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(origin, "a.ts"), "one\ntwo\nthree\n");
    g(origin, "add", "."); g(origin, "commit", "-q", "-m", "feat: three lines");
    const intro = g(origin, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(origin, "a.ts"), "one\nTWO\nthree\n");
    g(origin, "commit", "-qam", "fix: the second line");
    const fix = g(origin, "rev-parse", "HEAD");
    // A local edit in the checkout the mirror never sees.
    fs.writeFileSync(path.join(origin, "a.ts"), "uncommitted\n");

    const mirror = await freshMirror(origin, "t/repo", root);
    expect(mirror.branch).toBe("main");
    const posts: Array<{ p: string; body: any }> = [];
    const post = async (p: string, body: any) => {
      posts.push({ p, body });
      if (p.endsWith("/cursor")) return { landed_at: null };
      return { inserted: body.changes.length, linked: body.fixes.reduce((n: number, f: any) => n + f.introduced.length, 0) };
    };
    const r = await recordRepository({ ...mirror, repository: "t/repo", teamId: "team1", post });
    expect(r).toMatchObject({ changes: 2, inserted: 2, fixes: 1, links: 1 });
    const sent = posts.filter((x) => x.p.endsWith("/record"));
    expect(sent[0].body.changes.map((c: any) => [c.sha, c.fix_reason ?? null])).toEqual([[fix, "subject_fix"], [intro, null]]);
    expect(sent[1].body.fixes).toEqual([{ sha: fix, at: expect.any(Number), introduced: [{ sha: intro, lines: 1 }] }]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
