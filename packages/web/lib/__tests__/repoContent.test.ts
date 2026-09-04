import { expect, test } from "bun:test";
import { resolveRepoMarkdownUrl, safeRepoUrl } from "../repoContent";

test("README links and images resolve from their file directory at the selected ref", () => {
  const link = resolveRepoMarkdownUrl("../src/main.ts#L20", "o/r", "feature/one", "docs/README.md", "standalone");
  expect(link).toBe("/r/o/r/blob/feature%2Fone?path=src%2Fmain.ts#L20");
  expect(resolveRepoMarkdownUrl("./images/demo.png", "o/r", "v1", "docs/README.md", "app", true)).toBe("docs/images/demo.png");
  expect(resolveRepoMarkdownUrl("../docs/", "o/r", "v1", "docs/README.md", "app")).toBe("/repo/o/r/tree/v1?path=docs%2F");
  expect(resolveRepoMarkdownUrl("#usage", "o/r", "main", "README.md", "app")).toBe("#usage");
});
test("README URLs reject dangerous schemes and malformed escapes", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,x", "vbscript:msgbox(1)", "java\nscript:x", "//evil.test/x", "\\evil.test", "foo\\bar"]) {
    expect(safeRepoUrl(url)).toBeUndefined();
  }
  expect(resolveRepoMarkdownUrl("%ZZ", "o/r", "main", "README.md", "app")).toBeUndefined();
  expect(safeRepoUrl("https://example.com")).toBe("https://example.com");
  expect(safeRepoUrl("mailto:a@example.com", true)).toBeUndefined();
});
