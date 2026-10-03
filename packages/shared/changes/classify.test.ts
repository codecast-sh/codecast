import { describe, expect, test } from "bun:test";
import {
  areaOf,
  commitArea,
  isRestamp,
  isRevert,
  parseConventional,
  parseRelease,
  splitMessage,
  subjectKind,
  summarizeFiles,
} from "./classify";

describe("areaOf", () => {
  test("names the package, app or backend child", () => {
    expect(areaOf("packages/web/components/x.tsx")).toBe("web");
    expect(areaOf("apps/mobile/src/a.ts")).toBe("mobile");
    expect(areaOf("backend/lb/handler.go")).toBe("lb");
  });

  test("falls back to the first segment, root files share one area", () => {
    expect(areaOf("docs/proposals/changes-page.md")).toBe("docs");
    expect(areaOf(".github/workflows/ci.yml")).toBe("github");
    expect(areaOf("bun.lock")).toBe("root");
    expect(areaOf("packages/package.json")).toBe("packages");
  });
});

describe("summarizeFiles", () => {
  test("collapses files to areas, top paths and schema paths", () => {
    const s = summarizeFiles([
      { filename: "packages/convex/convex/schema.ts", additions: 4, deletions: 1 },
      { filename: "packages/web/a.tsx", additions: 100, deletions: 20 },
      { filename: "packages/web/b.tsx", additions: 1, deletions: 0 },
    ]);
    expect(s.areas).toEqual({ convex: { touches: 1, insertions: 4, deletions: 1 }, web: { touches: 2, insertions: 101, deletions: 20 } });
    expect(s.top_paths[0]).toBe("packages/web/a.tsx");
    expect(s.schema_paths).toEqual(["packages/convex/convex/schema.ts"]);
  });
});

describe("conventional subjects", () => {
  test("parses type, scope and breaking mark", () => {
    expect(parseConventional("feat(web)!: line pages")).toEqual({ type: "feat", scope: "web", breaking: true, description: "line pages" });
    expect(parseConventional("docs: architecture updates")?.scope).toBeNull();
    expect(parseConventional("Added zoom support")).toBeNull();
  });

  test("the scope names the area when the files agree", () => {
    const areas = { "browser-extension": { touches: 1, insertions: 3, deletions: 1 }, docs: { touches: 4, insertions: 9, deletions: 0 } };
    expect(commitArea(areas, "extension")).toBe("browser-extension");
    expect(commitArea(areas, "web")).toBe("docs");
    expect(commitArea({}, "cli")).toBe("cli");
  });

  test("kinds come from the type, then a leading verb", () => {
    expect(subjectKind("feat(web): x")).toBe("feature");
    expect(subjectKind("fix(cli): x")).toBe("fix");
    expect(subjectKind("refactor(shared): x")).toBe("infra");
    expect(subjectKind("Revert \"feat(web): x\"")).toBe("revert");
    expect(subjectKind("chore(cli): bump version to 1.1.163")).toBe("release");
    expect(subjectKind("Fix the image pill click")).toBe("fix");
    expect(subjectKind("Added zoom support")).toBe("feature");
  });
});

describe("parseRelease", () => {
  test("reads the surface from the subject's word, else the scope", () => {
    expect(parseRelease("chore(cli): bump version to 1.1.163")).toEqual({ surface: "cli", version: "1.1.163", scope: "cli" });
    expect(parseRelease("chore(electron): release desktop 1.1.123")).toEqual({ surface: "desktop", version: "1.1.123", scope: "electron" });
    expect(parseRelease("chore(electron): bump desktop to v1.1.122")?.version).toBe("1.1.122");
    expect(parseRelease("release: bump 2.0.0")?.surface).toBe("release");
    expect(parseRelease("chore(mobile): bump app version to 1.0.4")).toEqual({ surface: "mobile", version: "1.0.4", scope: "mobile" });
    expect(parseRelease("chore(cli): bump version from 1.1.162 to 1.1.163")?.version).toBe("1.1.163");
  });

  test("a dependency bump is not a release", () => {
    expect(parseRelease("chore(deps): bump lodash from 1.0.0 to 2.0.0")).toBeNull();
    expect(parseRelease("chore(deps-dev): bump vite to 5.4.1")).toBeNull();
    expect(parseRelease("chore: bump lodash from 4.17.20 to 4.17.21")).toBeNull();
    expect(subjectKind("chore(deps): bump lodash from 1.0.0 to 2.0.0")).toBe("infra");
  });

  test("ignores everything else", () => {
    expect(parseRelease("chore(cli): restamp daemon build id from the committed tree")).toBeNull();
    expect(parseRelease("feat(cli): bump the retry count to 3.1.4 times")).toBeNull();
    expect(isRestamp("chore(cli): restamp daemon build id")).toBe(true);
    expect(isRevert("revert: feat(web): x")).toBe(true);
  });
});

describe("splitMessage", () => {
  test("splits subject from body and drops the trailer paragraph", () => {
    const m = splitMessage("fix(cli): x\n\nWhy it broke.\n\nCodecast-Session: https://codecast.sh/conversation/jx7abc\n");
    expect(m).toEqual({ subject: "fix(cli): x", body: "Why it broke." });
    expect(splitMessage("docs: y").body).toBe("");
  });
});
