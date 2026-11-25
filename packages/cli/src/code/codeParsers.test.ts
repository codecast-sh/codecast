import { describe, expect, test } from "bun:test";
import { CODE_SEARCH_MAX_LINE_CHARS } from "@codecast/shared/contracts";
import { EMPTY_RESOLUTION, ZERO_SHA, type ParsedBlame, type SessionRef } from "../blame.js";
import { blameHunks } from "./codeBlame.js";
import { isSafeRef, parsePorcelainV2 } from "./codeGit.js";
import { expandBraces, expandIncludeGlob, parseSearchParams, searchLine, splitGlobs, utf16Ranges } from "./codeSearch.js";
import { sourcedPaths } from "./vimrcSources.js";

const H = "a".repeat(40);
const B = "b".repeat(40);

describe("parsePorcelainV2", () => {
  test("every entry kind, spaces in paths, upstream counts, a vault prefix", () => {
    const out = [
      `# branch.oid ${H}`,
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +3 -1",
      `1 .M N... 100644 100644 100644 ${H} ${H} app/with space.ts`,
      `1 M. N... 100644 100644 100644 ${H} ${B} app/staged.ts`,
      `1 A. N... 000000 100644 100644 ${"0".repeat(40)} ${B} app/added.ts`,
      `1 AD N... 000000 100644 000000 ${"0".repeat(40)} ${B} app/gone-again.ts`,
      `1 D. N... 100644 000000 000000 ${H} ${"0".repeat(40)} app/removed.ts`,
      `2 R. N... 100644 100644 100644 ${H} ${H} R100 app/new name.ts`,
      "app/old name.ts",
      `2 C. N... 100644 100644 100644 ${H} ${H} C75 app/copy.ts`,
      "app/orig.ts",
      `u UU N... 100644 100644 100644 100644 ${H} ${B} ${H} app/both.ts`,
      "? app/untracked dir/file.ts",
      "? outside.ts",
      "",
    ].join("\0");
    const status = parsePorcelainV2(out, "app/");
    expect(status).toMatchObject({ repo: true, branch: "feature/x", head: H, ahead: 3, behind: 1 });
    expect(status.files).toEqual({
      "with space.ts": "modified",
      "staged.ts": "modified",
      "added.ts": "added",
      "removed.ts": "deleted",
      "new name.ts": "renamed",
      "copy.ts": "added",
      "both.ts": "conflicted",
      "untracked dir/file.ts": "untracked",
    });
    expect([...status.renamedFrom]).toEqual([["new name.ts", "app/old name.ts"]]);
  });

  test("detached and unborn heads", () => {
    expect(parsePorcelainV2(`# branch.oid ${H}\0# branch.head (detached)\0`, "")).toMatchObject({ branch: null, head: H });
    expect(parsePorcelainV2("# branch.oid (initial)\0# branch.head main\0", "")).toMatchObject({ branch: "main", head: null });
  });
});

test("isSafeRef admits ref forms and refuses what git would read as more", () => {
  for (const ok of ["HEAD", "HEAD~2", "main^", "@{u}", "feature/x-1", H, "v1.2.3"]) expect(isSafeRef(ok)).toBe(true);
  for (const bad of ["HEAD:path", "-p", "--output=x", "a..b", "a b", ""]) expect(isSafeRef(bad)).toBe(false);
});

describe("search params and lines", () => {
  test("defaults are literal, case-insensitive, capped", () => {
    expect(parseSearchParams(new URLSearchParams("q=x&include=src, *.ts&max=99999999"))).toEqual({
      query: "x",
      regex: false,
      caseSensitive: false,
      word: false,
      include: ["src", "*.ts"],
      exclude: [],
      max: 50_000,
      includeIgnored: false,
    });
    expect(parseSearchParams(new URLSearchParams("q="))).toBeNull();
  });

  test("glob lists split on commas outside braces only", () => {
    expect(splitGlobs("*.{ts,tsx}, src/{a,b{c,d}}/x ,,docs")).toEqual(["*.{ts,tsx}", "src/{a,b{c,d}}/x", "docs"]);
    expect(expandBraces("*.{ts,tsx}")).toEqual(["*.ts", "*.tsx"]);
    expect(expandBraces("src/{a,b{c,d}}/*.{js,}")).toEqual(["src/a/*.js", "src/a/*.", "src/bc/*.js", "src/bc/*.", "src/bd/*.js", "src/bd/*."]);
    expect(expandBraces("no-braces/*.ts")).toEqual(["no-braces/*.ts"]);
    expect(expandBraces("open{a,b")).toEqual(["open{a,b"]);
    expect(expandBraces("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}").length).toBe(64);
    expect(parseSearchParams(new URLSearchParams("q=x&include=*.{ts,tsx}"))?.include).toEqual(["*.{ts,tsx}"]);
  });

  test("a bare include name means the folder too", () => {
    expect(expandIncludeGlob("src")).toEqual(["src", "**/src/**"]);
    expect(expandIncludeGlob("./lib/code/")).toEqual(["lib/code", "lib/code/**"]);
    expect(expandIncludeGlob("*.ts")).toEqual(["*.ts"]);
  });

  test("a long line keeps its first match in view and says where it starts", () => {
    const text = "x".repeat(5000) + "needle" + "y".repeat(5000);
    const line = searchLine(7, text + "\r\n", [{ start: 5000, end: 5006 }]);
    expect(line.text.length).toBe(CODE_SEARCH_MAX_LINE_CHARS);
    expect(line.offset).toBe(5000 - 60);
    expect(line.text.slice(line.ranges[0].start, line.ranges[0].end)).toBe("needle");
    expect(searchLine(1, "short\n", [])).toEqual({ line: 1, text: "short", ranges: [] });
  });
});

test("utf16Ranges matches a full decode, one pass, capped", () => {
  const text = "a é 😀 b é ab 😀ab";
  const buf = Buffer.from(text, "utf8");
  const spans: Array<{ start: number; end: number }> = [];
  for (let at = buf.indexOf("ab"); at >= 0; at = buf.indexOf("ab", at + 1)) spans.push({ start: at, end: at + 2 });
  const naive = spans.map((s) => ({ start: buf.subarray(0, s.start).toString().length, end: buf.subarray(0, s.end).toString().length }));
  expect(utf16Ranges(buf, spans)).toEqual(naive);
  expect(naive.every((r) => text.slice(r.start, r.end) === "ab")).toBe(true);
});

test("utf16Ranges stops at the end of the visible window", () => {
  const buf = Buffer.from("é".repeat(100) + "ab".repeat(5_000), "utf8");
  const spans = Array.from({ length: 5_000 }, (_, i) => ({ start: 200 + 2 * i, end: 202 + 2 * i }));
  const ranges = utf16Ranges(buf, spans);
  expect(ranges[0]).toEqual({ start: 100, end: 102 });
  expect(ranges.at(-1)!.start).toBeLessThan(100 - 60 + CODE_SEARCH_MAX_LINE_CHARS);
  expect(ranges.length).toBe(Math.ceil((CODE_SEARCH_MAX_LINE_CHARS - 60) / 2));
});

describe("blameHunks", () => {
  const meta = (author: string, t: number) => ({ author, authorTime: t, authorTz: "+0000", summary: `by ${author}`, boundary: false });
  const parsed: ParsedBlame = {
    lines: [
      { sha: H, finalLine: 1, content: "a" },
      { sha: H, finalLine: 2, content: "b" },
      { sha: B, finalLine: 3, content: "c" },
      { sha: ZERO_SHA, finalLine: 4, content: "written by an agent" },
      { sha: ZERO_SHA, finalLine: 5, content: "typed by hand" },
    ],
    commits: new Map([[H, meta("Ada", 100)], [B, meta("Lin", 200)], [ZERO_SHA, meta("Not Committed Yet", 300)]]),
  };
  const session = (id: string): SessionRef => ({ conversation_id: id, title: `session ${id.slice(0, 3)}`, message_id: "m1" });

  test("plain git blame runs", () => {
    expect(blameHunks(parsed, EMPTY_RESOLUTION)).toEqual([
      { start: 1, end: 2, sha: H, author: "Ada", summary: "by Ada", time: 100_000 },
      { start: 3, end: 3, sha: B, author: "Lin", summary: "by Lin", time: 200_000 },
      { start: 4, end: 5, uncommitted: true, time: 300_000 },
    ]);
  });

  test("a content match splits a run by the session that wrote it", () => {
    const hunks = blameHunks(parsed, {
      bySha: new Map([[H, session("jx7committer000")]]),
      byLine: new Map([["written by an agent", session("jx7author00000")], ["b", session("jx7author00000")]]),
    });
    expect(hunks.map((h) => [h.start, h.end, h.session?.id])).toEqual([
      [1, 1, "jx7comm"],
      [2, 2, "jx7auth"],
      [3, 3, undefined],
      [4, 4, "jx7auth"],
      [5, 5, undefined],
    ]);
    expect(hunks[1].session).toEqual({ id: "jx7auth", conversation_id: "jx7author00000", title: "session jx7", message_id: "m1" });
  });
});

describe("sourcedPaths", () => {
  const home = "/home/u";
  test("source, so, runtime, after a bar, behind silent!, with <sfile>", () => {
    const text = [
      '" source ~/commented.vim',
      "source ~/.vim/a.vim",
      "  so $HOME/.vim/b.vim",
      "silent! source ${HOME}/c.vim",
      "if filereadable(expand('~/.local.vim')) | source ~/.local.vim | endif",
      "runtime macros/one.vim macros/two.vim",
      "runtime! plugin/*.vim",
      "source <sfile>:p:h/rel.vim",
      "exe 'source ' . g:path",
      "source $VIMRUNTIME/defaults.vim",
      "nnoremap <leader>s :source ~/.vimrc<CR>",
    ].join("\n");
    expect(sourcedPaths(text, "/home/u/.config/nvim/init.vim", home)).toEqual([
      { path: "/home/u/.vim/a.vim", runtime: false },
      { path: "/home/u/.vim/b.vim", runtime: false },
      { path: "/home/u/c.vim", runtime: false },
      { path: "/home/u/.local.vim", runtime: false },
      { path: "macros/one.vim", runtime: true },
      { path: "macros/two.vim", runtime: true },
      { path: "/home/u/.config/nvim/rel.vim", runtime: false },
    ]);
  });
});
