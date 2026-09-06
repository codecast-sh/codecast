import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Command } from "commander";
import {
  fileDiffIdentity,
  formatReviewList,
  isStale,
  parseReviewTarget,
  registerReviewCommand,
  repoRelativePath,
  resolveNoteRef,
  staleIdsOf,
  type ReviewNoteRow,
} from "./reviewCommand.js";

describe("parseReviewTarget", () => {
  test("a line, a range, a file, and a bare path", () => {
    expect(parseReviewTarget("src/api.ts:42")).toEqual({ filePath: "src/api.ts", lineNumber: 42 });
    expect(parseReviewTarget("src/api.ts:10-20")).toEqual({ filePath: "src/api.ts", lineNumber: 10, lineEnd: 20 });
    expect(parseReviewTarget("src/api.ts:file")).toEqual({ filePath: "src/api.ts" });
    expect(parseReviewTarget("src/api.ts")).toEqual({ filePath: "src/api.ts" });
  });

  test("a reversed range still reads low to high", () => {
    expect(parseReviewTarget("a.ts:20-10")).toEqual({ filePath: "a.ts", lineNumber: 10, lineEnd: 20 });
  });

  test("a suffix that is neither a line nor `file` belongs to the path", () => {
    expect(parseReviewTarget("weird:name.ts")).toEqual({ filePath: "weird:name.ts" });
  });
});

describe("resolveNoteRef", () => {
  const notes = [
    { _id: "aaa111", content: "one", created_at: 1 },
    { _id: "bbb222", content: "two", created_at: 2 },
  ] as ReviewNoteRow[];

  test("by listing number, by id, by prefix", () => {
    expect(resolveNoteRef(notes, "2")._id).toBe("bbb222");
    expect(resolveNoteRef(notes, "aaa111")._id).toBe("aaa111");
    expect(resolveNoteRef(notes, "bbb")._id).toBe("bbb222");
  });

  test("a reference that matches nothing, or too much, is an error", () => {
    expect(() => resolveNoteRef(notes, "9")).toThrow(/No review note/);
    expect(() => resolveNoteRef(notes, "zzz")).toThrow(/No review note/);
    const twins = [{ _id: "ab1", content: "", created_at: 1 }, { _id: "ab2", content: "", created_at: 2 }] as ReviewNoteRow[];
    expect(() => resolveNoteRef(twins, "ab")).toThrow(/matches 2 notes/);
  });
});

describe("isStale", () => {
  test("only a stamp that exists on both sides and differs is stale", () => {
    expect(isStale("blob:a", "blob:b")).toBe(true);
    expect(isStale("blob:a", "blob:a")).toBe(false);
    // An unprovable claim of staleness would train the reader to ignore it.
    expect(isStale(undefined, "blob:b")).toBe(false);
    expect(isStale("blob:a", undefined)).toBe(false);
  });
});

describe("formatReviewList", () => {
  test("numbers the notes and flags stale and sent ones", () => {
    const notes = [
      { _id: "a", file_path: "src/api.ts", line_number: 42, content: "leaks", created_at: 1 },
      { _id: "b", file_path: "src/db.ts", content: "no test", created_at: 2, sent_at: 5 },
    ] as ReviewNoteRow[];
    expect(formatReviewList(notes, new Set(["a"]))).toBe(
      [
        " 1. src/api.ts · Line: 42  [stale]",
        "    leaks",
        " 2. src/db.ts · Scope: file  [sent]",
        "    no test",
      ].join("\n"),
    );
  });

  test("an empty batch says so", () => {
    expect(formatReviewList([])).toBe("No review notes in this worktree.");
  });
});

// ── The batch, end to end against a fake backend and a real git repo ──

const realFetch = globalThis.fetch;
let dir = "";
let envBackup: Record<string, string | undefined> = {};
let rows: any[] = [];
let logged: string[] = [];
const realLog = console.log;

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** The three review routes, over an in-memory table. */
function fakeBackend() {
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    const route = String(url).replace(/^.*\/cli\/review\//, "");
    if (route === "add") {
      const id = `id${rows.length + 1}`;
      rows.push({ ...body, _id: id, created_at: rows.length + 1 });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    if (route === "list") {
      const mine = rows.filter((r) => r.git_root === body.git_root && (body.include_sent || !r.sent_at));
      return new Response(JSON.stringify(mine), { status: 200 });
    }
    if (route === "send") {
      const mine = rows.filter((r) => r.git_root === body.git_root && !r.sent_at);
      for (const r of mine) r.sent_at = 99;
      return new Response(JSON.stringify({ sent: mine.length, stale_ids: body.stale_ids }), { status: 200 });
    }
    if (route === "rm") {
      rows = rows.filter((r) => r._id !== body.comment_id);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (route === "edit") {
      const row = rows.find((r) => r._id === body.comment_id);
      if (row) { row.content = body.content; row.sent_at = undefined; }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: `no route ${route}` }), { status: 404 });
  }) as unknown as typeof fetch;
}

async function run(...args: string[]) {
  logged = [];
  console.log = (...parts: any[]) => { logged.push(parts.join(" ")); };
  try {
    const program = new Command();
    program.exitOverride();
    registerReviewCommand(program, {
      getCliEndpoint: () => ({ siteUrl: "https://example.invalid", apiToken: "t" }),
      detectCurrentSessionId: () => "sess-current",
    });
    await program.parseAsync(["node", "cast", "review", ...args]);
  } finally {
    console.log = realLog;
  }
  return logged.join("\n");
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-review-")));
  envBackup = { CODECAST_DIR: process.env.CODECAST_DIR, CODECAST_CWD: process.env.CODECAST_CWD, HOME: process.env.HOME };
  process.env.CODECAST_DIR = path.join(dir, ".codecast");
  process.env.HOME = dir;
  process.env.CODECAST_CWD = dir;
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "T"], dir);
  fs.writeFileSync(path.join(dir, "api.ts"), "one\ntwo\nthree\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "init"], dir);
  rows = [];
  fakeBackend();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cast review lifecycle", () => {
  test("add, ls, send, rm", async () => {
    await run("add", "api.ts:2", "this leaks on the error path");
    await run("add", "api.ts:file", "the module needs a test");
    expect(rows).toHaveLength(2);
    expect(rows[0].file_path).toBe("api.ts");
    expect(rows[0].line_number).toBe(2);
    expect(rows[0].git_root).toBe(dir);
    expect(rows[0].diff_identity).toMatch(/^blob:[0-9a-f]{12}$/);
    // A whole-file note carries no line at all, not line 0.
    expect(rows[1].line_number).toBeUndefined();

    const listing = await run("ls");
    expect(listing).toContain(" 1. api.ts · Line: 2");
    expect(listing).toContain(" 2. api.ts · Scope: file");
    expect(listing).not.toContain("[stale]");

    const sent = await run("send", "jx7abcd");
    expect(sent).toContain("sent 2 notes");
    // A sent batch is empty; --all still shows it.
    expect(await run("ls")).toBe("No review notes in this worktree.");
    expect(await run("ls", "--all")).toContain("[sent]");

    await run("rm", "1");
    expect(rows).toHaveLength(1);
  });

  test("editing a note puts it back in the batch", async () => {
    await run("add", "api.ts:2", "first thought");
    await run("send", "jx7abcd");
    expect(await run("ls")).toBe("No review notes in this worktree.");

    await run("edit", "1", "what I actually meant");
    const listing = await run("ls");
    expect(listing).toContain("what I actually meant");
    expect(listing).not.toContain("[sent]");
  });

  test("rm resolves every reference before deleting any of them", async () => {
    await run("add", "api.ts:1", "one");
    await run("add", "api.ts:2", "two");
    await run("add", "api.ts:3", "three");
    await run("rm", "1", "2");
    expect(rows.map((r) => r.content)).toEqual(["three"]);
  });

  test("a note goes stale when its file moves on, and says so in the message", async () => {
    await run("add", "api.ts:2", "this leaks on the error path");
    expect(await run("ls")).not.toContain("[stale]");

    fs.writeFileSync(path.join(dir, "api.ts"), "one\nTWO\nthree\n");
    expect(await run("ls")).toContain("[stale]");

    const preview = await run("send", "--dry-run");
    expect(preview).toContain("Stale: the file changed after this note was written");
    // A dry run sends nothing.
    expect(rows[0].sent_at).toBeUndefined();

    await run("send", "jx7abcd");
    const sentBody = rows[0];
    expect(sentBody.sent_at).toBe(99);
  });

  test("a note on an unchanged file is never called stale after a commit", async () => {
    await run("add", "api.ts:2", "keep");
    git(["commit", "-qam", "no-op"], dir);
    expect(await run("ls")).not.toContain("[stale]");
  });
});

describe("git helpers", () => {
  test("a path typed from a subdirectory is stored relative to the repository", () => {
    const sub = path.join(dir, "src");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "a.ts"), "x\n");
    expect(repoRelativePath(dir, sub, "a.ts")).toBe("src/a.ts");
    expect(repoRelativePath(dir, dir, "./src/a.ts")).toBe("src/a.ts");
  });

  test("a path git cannot hash carries no stamp", () => {
    expect(fileDiffIdentity(dir, "api.ts")).toMatch(/^blob:/);
    expect(fileDiffIdentity(dir, "nope.ts")).toBeUndefined();
  });

  test("staleIdsOf hashes each file once", () => {
    const notes = [
      { _id: "a", file_path: "api.ts", content: "x", created_at: 1, diff_identity: "blob:stale0000000" },
      { _id: "b", file_path: "api.ts", content: "y", created_at: 2, diff_identity: fileDiffIdentity(dir, "api.ts") },
    ] as ReviewNoteRow[];
    expect([...staleIdsOf(dir, notes)]).toEqual(["a"]);
  });
});
