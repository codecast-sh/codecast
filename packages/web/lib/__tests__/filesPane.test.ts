import { describe, expect, test } from "bun:test";
import { cursorParam, filesHref } from "../vault/vaultHref";
import { editorHref, editedLineRange, firstChangedLine, gitRefForDiffBase, localCheckoutFile } from "../filesPane";
import { parseCursorTarget } from "../code/editorHost";
import { filePathHref, filePathMention, parseFilePathHref } from "../filePathLinks";
import { besideSessionId } from "../code/agent/sessions";

describe("the editor address", () => {
  test("line, column and a flash range share `l`", () => {
    expect(cursorParam(12)).toBe("12");
    expect(cursorParam(12, 4)).toBe("12:4");
    expect(cursorParam(12, undefined, 20)).toBe("12-20");
    expect(cursorParam(12, 4, 20)).toBe("12:4-20");
    expect(cursorParam(12, undefined, 12)).toBe("12");
    expect(cursorParam(undefined, 4, 20)).toBe("");
  });

  test("filesHref writes it and the editor reads it back", () => {
    const href = filesHref({ localPath: "/Users/ada/src/app/x.ts", line: 10, column: 3, endLine: 14 });
    expect(href).toBe("/files?path=%2FUsers%2Fada%2Fsrc%2Fapp%2Fx.ts&l=10%3A3-14");
    const l = new URLSearchParams(href.split("?")[1]).get("l");
    expect(parseCursorTarget(l)).toEqual({ line: 10, column: 3, endLine: 14 });
    expect(parseCursorTarget("12-20")).toEqual({ line: 12, column: undefined, endLine: 20 });
    expect(parseCursorTarget("12:4")).toEqual({ line: 12, column: 4 });
    // A raw `l` off a URL rides through the ?path= → ?f= rewrite as it came.
    expect(filesHref({ path: "x.ts", line: "10:3-14" })).toBe("/files?f=x.ts&l=10%3A3-14");
  });

  test("editorHref resolves a relative path against the conversation", () => {
    const ctx = { base: "/Users/ada/src/app", home: "/Users/ada" };
    expect(editorHref({ path: "lib/x.ts", line: 5, column: 2, ctx })).toBe("/files?path=%2FUsers%2Fada%2Fsrc%2Fapp%2Flib%2Fx.ts&l=5%3A2");
    expect(editorHref({ path: "lib/x.ts", line: 5, ctx })).toBe(filePathHref("lib/x.ts", 5, ctx));
    // An Edit's range flashes; the same address a link carries, plus `-end`.
    expect(editorHref({ path: "lib/x.ts", line: 40, endLine: 42, ctx })).toBe("/files?path=%2FUsers%2Fada%2Fsrc%2Fapp%2Flib%2Fx.ts&l=40-42");
  });

  test("a cloud host session's path opens on that host", () => {
    const ctx = { base: "/home/ada/app", home: "/home/ada", deviceId: "host-1" };
    expect(editorHref({ path: "x.ts", line: 3, ctx })).toBe("/files?path=%2Fhome%2Fada%2Fapp%2Fx.ts&d=host-1&l=3");
    expect(editorHref({ path: "x.ts", line: 3, ctx })).toBe(filePathHref("x.ts", 3, ctx));
  });

  test("a path mention's column survives into the link and back", () => {
    expect(filePathMention("lib/x.ts:12:4")).toMatchObject({ path: "lib/x.ts", line: 12, column: 4 });
    expect(filePathMention("lib/x.ts:12-20")).toMatchObject({ path: "lib/x.ts", line: 12 });
    expect(filePathMention("lib/x.ts:12-20")?.column).toBeUndefined();
    expect(parseFilePathHref("/files?path=%2Fa%2Fb.ts&l=12%3A4")).toEqual({ path: "/a/b.ts", line: 12, column: 4 });
    expect(parseFilePathHref("/Users/ada/b.ts:7:3")).toEqual({ path: "/Users/ada/b.ts", line: 7, column: 3 });
  });
});

describe("ranges", () => {
  test("firstChangedLine finds the first added or removed row", () => {
    expect(firstChangedLine("@@ -10,4 +12,5 @@\n ctx\n ctx\n+new\n ctx")).toBe(14);
    expect(firstChangedLine("@@ -1 +1 @@\n-old\n+new")).toBe(1);
    expect(firstChangedLine(undefined)).toBeUndefined();
  });

  test("editedLineRange places the replacement inside the result snippet", () => {
    const snippet = "    40→head\n    41→  const b = 2;\n    42→  const c = 3;\n    43→tail";
    expect(editedLineRange(snippet, "  const b = 2;\n  const c = 3;")).toEqual({ line: 41, endLine: 42 });
    expect(editedLineRange(snippet, "\n  const b = 2;")).toEqual({ line: 40, endLine: 41 });
    expect(editedLineRange(snippet, "not there")).toEqual({ line: 40 });
    expect(editedLineRange("   7\tone line", "one line")).toEqual({ line: 7 });
    expect(editedLineRange("no numbers", "x")).toBeUndefined();
  });

  test("editedLineRange matches the whole block, nearest the snippet's middle", () => {
    // A `}` head appears three times; only the block at 45 has `return b;` after it.
    const snippet = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]
      .map((n) => `    ${n}→${({ 41: "}", 43: "}", 44: "return a;", 45: "}", 46: "return b;", 49: "}", 50: "return b;" } as Record<number, string>)[n] ?? "x"}`)
      .join("\n");
    expect(editedLineRange(snippet, "}\nreturn b;")).toEqual({ line: 45, endLine: 46 });
    // A replacement longer than the snippet shows still places by what it shows.
    expect(editedLineRange("    10→a\n    11→b", "b\nc\nd")).toEqual({ line: 11, endLine: 13 });
  });

  test("a diff base maps to the git ref the editor diffs against", () => {
    expect(gitRefForDiffBase("session", [])).toEqual({ ref: "HEAD", label: "HEAD" });
    expect(gitRefForDiffBase("session", [{ changeType: "commit" }])?.ref).toBe("@merge-base");
    expect(gitRefForDiffBase("commit", [{ changeType: "commit" }])?.ref).toBe("HEAD");
    expect(gitRefForDiffBase("branch", [])?.ref).toBe("@merge-base");
    expect(gitRefForDiffBase("turn", [])).toBeNull();
  });

  test("localCheckoutFile picks this machine's worktree on the ref", () => {
    const checkouts = [
      { root: "/m/app", device_id: "other", mine: true, worktrees: [{ path: "/m/app", main: true }] },
      { root: "/Users/ada/src/app", device_id: "here", mine: true, worktrees: [{ path: "/Users/ada/src/app", branch: "main", main: true }, { path: "/Users/ada/src/app-wt", branch: "feat" }] },
    ];
    expect(localCheckoutFile(checkouts, "here", "feat", "lib/x.ts")).toBe("/Users/ada/src/app-wt/lib/x.ts");
    expect(localCheckoutFile(checkouts, "here", "v1.2", "lib/x.ts")).toBe("/Users/ada/src/app/lib/x.ts");
    expect(localCheckoutFile(checkouts, "nowhere", "main", "x")).toBeNull();
    expect(localCheckoutFile(checkouts, null, "main", "x")).toBeNull();
  });
});

describe("the editor's linked session", () => {
  const leaf = (id: string, path: string) => ({ type: "leaf", id, path });
  const s1 = "1".repeat(32);
  const s2 = "2".repeat(32);
  const tab = (editorOpenedFrom?: string) => ({ id: "t1", path: "/files?f=x.ts", editorOpenedFrom, layout: { type: "split", children: [leaf("a", `/conversation/${s1}`), leaf("b", `/conversation/${s2}`), leaf("c", "/files?f=x.ts")] } });

  test("prefers the conversation the editor was opened from while it is on stage", () => {
    expect(besideSessionId([tab()], "t1", null)).toBe(s1);
    expect(besideSessionId([tab(s2)], "t1", null)).toBe(s2);
    // Gone from the stage: the first conversation beside it again.
    expect(besideSessionId([tab("s9")], "t1", null)).toBe(s1);
  });
});
