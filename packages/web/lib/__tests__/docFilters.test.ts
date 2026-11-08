// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { docMatchesProjectFilter } from "../docFilters";

describe("docMatchesProjectFilter", () => {
  it("matches docs by project_path", () => {
    expect(docMatchesProjectFilter(
      { project_path: "/Users/ashot/src/footage-app" },
      "/Users/ashot/src/footage-app",
    )).toBe(true);
  });

  it("matches mined docs by source_file under the project", () => {
    expect(docMatchesProjectFilter(
      { source_file: "/Users/ashot/src/footage-app/docs/export.md" },
      "/Users/ashot/src/footage-app",
    )).toBe(true);
  });

  it("matches the same repo across different machine roots", () => {
    expect(docMatchesProjectFilter(
      { project_path: "/Users/ec2-user/src/footage-app" },
      "/Users/ashot/src/footage-app",
    )).toBe(true);
  });

  it("does not match unrelated repos with similar prefixes", () => {
    expect(docMatchesProjectFilter(
      { project_path: "/Users/ashot/src/footage-app-old" },
      "/Users/ashot/src/footage-app",
    )).toBe(false);
  });

  // Regression: repos in ~/code/work.noindex/GitHub/<repo> were all named
  // "work.noindex", so filtering docs to one repo showed every repo's docs.
  it("tells apart repos nested below a code folder", () => {
    const GH = "/Users/a/code/work.noindex/GitHub";
    expect(docMatchesProjectFilter({ project_path: `${GH}/slack-bot` }, `${GH}/littlebird`)).toBe(false);
    expect(docMatchesProjectFilter({ project_path: "/Users/b/code/work.noindex/GitHub/littlebird" }, `${GH}/littlebird`)).toBe(true);
  });

  it("names a subfolder doc by the checkout a session names", () => {
    expect(docMatchesProjectFilter(
      { source_file: "/Users/ec2-user/src/footage-app/docs/export.md" },
      "/Users/ashot/src/footage-app",
      ["/Users/ec2-user/src/footage-app"],
    )).toBe(true);
  });
});
