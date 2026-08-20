import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { filePathMention, filePathHref, parseFilePathHref, FILE_PATH_SCAN_RE, mentionFromMatch } from "../filePathLinks";
import { entityRemarkPlugins } from "../remarkEntityIds";
import { resolveVaultTarget, filesHref } from "../vault/vaultHref";

const scan = (text: string) => {
  const out: string[] = [];
  for (const m of text.matchAll(FILE_PATH_SCAN_RE)) {
    const mention = mentionFromMatch(m[0], m[1], m[2]);
    if (mention) out.push(mention.text);
  }
  return out;
};

describe("file path mentions in prose", () => {
  test("absolute, home and relative file paths are found", () => {
    expect(scan("see /Users/ashot/src/codecast/packages/web/lib/pageLayout.tsx:38 for it")).toEqual([
      "/Users/ashot/src/codecast/packages/web/lib/pageLayout.tsx:38",
    ]);
    expect(scan("notes live in ~/vault-fixture/Daily/ now")).toEqual(["~/vault-fixture/Daily/"]);
    expect(scan("edited packages/web/app/vault/page.tsx and lib/utils.ts.")).toEqual([
      "packages/web/app/vault/page.tsx",
      "lib/utils.ts",
    ]);
    expect(scan("the dir packages/web/components/vault holds it")).toEqual(["packages/web/components/vault"]);
    expect(scan("in app/conversation/[id]/page.tsx and app/(marketing)/page.tsx")).toEqual([
      "app/conversation/[id]/page.tsx",
      "app/(marketing)/page.tsx",
    ]);
    expect(scan("config is .claude/settings.json, also ./scripts/run.sh")).toEqual([
      ".claude/settings.json",
      "./scripts/run.sh",
    ]);
  });

  test("a sentence-ending period is not part of the path", () => {
    const m = [...("fixed lib/x.ts.".matchAll(FILE_PATH_SCAN_RE))][0];
    const mention = mentionFromMatch(m[0], m[1], m[2])!;
    expect(mention.path).toBe("lib/x.ts");
    expect(mention.rest).toBe(".");
    expect(mention.line).toBeUndefined();
  });

  test("slashes that are not paths stay plain", () => {
    for (const text of [
      "either/or and km/h, TCP/IP, application/json",
      "on 08/20/2026 at /tasks/:id and /files?f=x",
      "see https://github.com/ashot/codecast/blob/main/x.ts or codecast.sh/a/slug",
      "import from @codecast/shared/render",
      "the /inbox route, w/ the team",
      "ratio 1/2 or 3/4",
    ]) {
      expect(scan(text)).toEqual([]);
    }
  });

  test("whole-string form for code spans", () => {
    expect(filePathMention("lib/pageLayout.tsx:38")).toEqual({ path: "lib/pageLayout.tsx", text: "lib/pageLayout.tsx:38", rest: "", line: 38 });
    expect(filePathMention("/tmp/codecast/images/a.png")).toMatchObject({ path: "/tmp/codecast/images/a.png" });
    expect(filePathMention("npm run build")).toBeNull();
    expect(filePathMention("page.tsx")).toBeNull();
    expect(filePathMention("/files?f=x")).toBeNull();
  });
});

describe("hrefs", () => {
  test("without context the raw path rides in ?path=", () => {
    expect(filePathHref("lib/x.ts", 12, null)).toBe("/files?path=lib%2Fx.ts&l=12");
    expect(parseFilePathHref("/files?path=lib%2Fx.ts&l=12")).toEqual({ path: "lib/x.ts", line: 12 });
    expect(parseFilePathHref("/files?f=notes%2Fa.md")).toBeNull();
  });

  test("with context a relative or ~ path becomes absolute", () => {
    const ctx = { base: "/Users/ashot/src/codecast", home: "/Users/ashot" };
    expect(filePathHref("lib/x.ts", undefined, ctx)).toBe(filesHref({ localPath: "/Users/ashot/src/codecast/lib/x.ts" }));
    expect(filePathHref("~/notes/a.md", undefined, ctx)).toBe(filesHref({ localPath: "/Users/ashot/notes/a.md" }));
    expect(filePathHref("/tmp/x.png", undefined, ctx)).toBe(filesHref({ localPath: "/tmp/x.png" }));
  });
});

describe("resolveVaultTarget", () => {
  const vaults = [
    { id: "src", root: "/Users/ashot/src" },
    { id: "cc", root: "/Users/ashot/src/codecast" },
    { id: "notes", root: "/Users/ashot/vault-fixture" },
    { id: "remote" },
  ];
  test("longest root wins; rel is vault-relative", () => {
    expect(resolveVaultTarget("/Users/ashot/src/codecast/packages/web/x.ts", vaults)).toEqual({
      vaultId: "cc", rel: "packages/web/x.ts", abs: "/Users/ashot/src/codecast/packages/web/x.ts",
    });
    expect(resolveVaultTarget("/Users/ashot/src/mail/app.ts", vaults)).toMatchObject({ vaultId: "src", rel: "mail/app.ts" });
    expect(resolveVaultTarget("/Users/ashot/src/codecast", vaults)).toMatchObject({ vaultId: "cc", rel: "" });
  });
  test("~ expands against the home the roots reveal; relative against the active root", () => {
    expect(resolveVaultTarget("~/vault-fixture/Daily/2026-08-20.md", vaults)).toMatchObject({ vaultId: "notes", rel: "Daily/2026-08-20.md" });
    expect(resolveVaultTarget("lib/x.ts", vaults, "/Users/ashot/src/codecast")).toMatchObject({ vaultId: "cc", rel: "lib/x.ts" });
    expect(resolveVaultTarget("lib/x.ts", vaults)).toBeNull();
  });
  test("a path outside every vault resolves to nothing", () => {
    expect(resolveVaultTarget("/tmp/x.png", vaults)).toBeNull();
  });
});

describe("remark integration", () => {
  const render = (md: string) =>
    renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: entityRemarkPlugins }, md));

  test("a bare path in prose becomes a /files?path= link; URLs and routes do not", () => {
    const html = render("Edited packages/web/lib/pageLayout.tsx:38. See https://github.com/a/b/c.ts and /tasks/:id.");
    expect(html).toContain('href="/files?path=packages%2Fweb%2Flib%2FpageLayout.tsx&amp;l=38"');
    expect(html).toContain(">packages/web/lib/pageLayout.tsx:38</a>.");
    expect(html).toContain('href="https://github.com/a/b/c.ts"');
    expect(html).not.toContain("tasks%2F");
  });

  test("inline code and existing links are left to the component layer", () => {
    const html = render("run `lib/x.ts` and [doc](lib/y.ts)");
    expect(html).toContain("<code>lib/x.ts</code>");
    expect(html).toContain('href="lib/y.ts"');
    expect(html).not.toContain("path=lib%2Fx.ts");
  });
});
