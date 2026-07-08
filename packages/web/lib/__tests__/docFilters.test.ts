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
});
