import { describe, expect, test } from "bun:test";
import { FILES_ROUTE, filesHref, isFilesPath } from "../vaultHref";

describe("filesHref", () => {
  test("mints the canonical /files route, never the legacy one", () => {
    // The CLI, the palette, wiki links and the editor all mint through here.
    // If this ever went back to /vault, every new link would be a legacy link.
    expect(filesHref()).toBe("/files");
    expect(FILES_ROUTE).toBe("/files");
    expect(filesHref({ path: "notes/Sleep.md" })).toBe("/files?f=notes%2FSleep.md");
  });

  test("encodes paths that would otherwise break the query string", () => {
    expect(filesHref({ path: "a b/c&d.md" })).toBe("/files?f=a+b%2Fc%26d.md");
  });

  test("carries a search hit's line and the graph view", () => {
    expect(filesHref({ path: "a.md", line: 42 })).toBe("/files?f=a.md&l=42");
    expect(filesHref({ graph: true })).toBe("/files?view=graph");
    expect(filesHref({ path: "a.md", graph: true })).toBe("/files?f=a.md&view=graph");
  });

  test("a falsy line or path is omitted rather than serialized", () => {
    expect(filesHref({ path: null })).toBe("/files");
    expect(filesHref({ path: "a.md", line: 0 })).toBe("/files?f=a.md");
  });
});

describe("isFilesPath", () => {
  test("recognises both routes — /vault links are already on users' disks", () => {
    // `cast vault open` printed /vault?f=… into sessions and notes, and entity
    // links write real codecast URLs into markdown files. Dropping this branch
    // would break links that already exist.
    expect(isFilesPath("/vault?f=a.md")).toBe(true);
    expect(isFilesPath("/vault")).toBe(true);
    expect(isFilesPath("/files?f=a.md")).toBe(true);
    expect(isFilesPath("/files")).toBe(true);
  });

  test("does not claim paths that merely start with the same letters", () => {
    expect(isFilesPath("/filesystem")).toBe(false);
    expect(isFilesPath("/vaults")).toBe(false);
    expect(isFilesPath("/docs")).toBe(false);
  });
});
