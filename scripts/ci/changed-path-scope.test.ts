import { describe, expect, test } from "bun:test";

import {
  AREAS,
  GATED_JOBS,
  areaOf,
  classifyChangedPaths,
  formatScope,
  jobFlag,
} from "./changed-path-scope";

const flags = (files: string[]) => classifyChangedPaths(files).flags;

describe("areaOf", () => {
  test("maps each package to its area", () => {
    expect(areaOf("packages/cli/src/daemon.ts")).toBe("cli");
    expect(areaOf("packages/web/components/DiffView.tsx")).toBe("web");
    expect(areaOf("packages/convex/convex/tasks.ts")).toBe("convex");
    expect(areaOf("packages/shared/contracts/agentClients.ts")).toBe("shared");
    expect(areaOf("platform/packages/engine/src/index.ts")).toBe("shared");
    expect(areaOf("packages/electron/main.js")).toBe("electron");
    expect(areaOf("packages/desktop/src-tauri/tauri.conf.json")).toBe("electron");
    expect(areaOf("packages/mobile/app/index.tsx")).toBe("mobile");
    expect(areaOf("packages/browser-extension/background.js")).toBe("extension");
    expect(areaOf("packages/vscode-extension/src/extension.ts")).toBe("extension");
  });

  test("maps prose at the repo root to docs", () => {
    expect(areaOf("README.md")).toBe("docs");
    expect(areaOf("CLAUDE.md")).toBe("docs");
    expect(areaOf("docs/architecture/sync-host.md")).toBe("docs");
    expect(areaOf(".github/ISSUE_TEMPLATE/bug.md")).toBe("docs");
  });

  test("claims nothing it does not recognise", () => {
    expect(areaOf("package.json")).toBeNull();
    expect(areaOf("bun.lock")).toBeNull();
    expect(areaOf(".github/workflows/ci.yml")).toBeNull();
    expect(areaOf("scripts/ci/changed-path-scope.ts")).toBeNull();
    expect(areaOf("infra/nginx.conf")).toBeNull();
  });
});

describe("classifyChangedPaths", () => {
  test("a docs-only change runs no job", () => {
    const result = flags(["docs/architecture/sync-host.md", "README.md"]);
    expect(result.docs).toBe(true);
    for (const job of GATED_JOBS) expect(result[jobFlag(job)]).toBe(false);
    for (const area of AREAS) {
      if (area !== "docs") expect(result[area]).toBe(false);
    }
  });

  test("a cli change runs build, typecheck and the cli tests", () => {
    const result = flags(["packages/cli/src/daemon.ts"]);
    expect(result.cli).toBe(true);
    expect(result.run_build).toBe(true);
    expect(result.run_test_cli).toBe(true);
    // The typecheck job does not typecheck cli strictly, but it does run the
    // changed-lines gate over cli's added lines (ct-49564).
    expect(result.run_typecheck).toBe(true);
    expect(result.run_lint).toBe(false);
    expect(result.run_test_web).toBe(false);
    expect(result.run_test_convex).toBe(false);
  });

  test("a web change runs lint, typecheck, build and the web tests", () => {
    const result = flags(["packages/web/components/DiffView.tsx"]);
    expect(result.run_lint).toBe(true);
    expect(result.run_typecheck).toBe(true);
    expect(result.run_build).toBe(true);
    expect(result.run_test_web).toBe(true);
    expect(result.run_test_cli).toBe(false);
    expect(result.run_test_convex).toBe(false);
  });

  test("a shared change runs every job that reads shared", () => {
    const result = flags(["packages/shared/contracts/inboxProjection.ts"]);
    expect(result.run_build).toBe(true);
    expect(result.run_typecheck).toBe(true);
    expect(result.run_test_cli).toBe(true);
    expect(result.run_test_web).toBe(true);
    expect(result.run_test_convex).toBe(true);
    // Only packages/web has a lint script, so a shared change leaves it out.
    expect(result.run_lint).toBe(false);
  });

  test("a convex change runs typecheck, build and the convex tests", () => {
    const result = flags(["packages/convex/convex/tasks.ts"]);
    expect(result.run_typecheck).toBe(true);
    expect(result.run_test_convex).toBe(true);
    expect(result.run_test_cli).toBe(false);
    expect(result.run_test_web).toBe(false);
    expect(result.run_lint).toBe(false);
  });

  test("mobile and electron changes run nothing — no job covers them", () => {
    const result = flags(["packages/mobile/app/index.tsx", "packages/electron/main.js"]);
    expect(result.mobile).toBe(true);
    expect(result.electron).toBe(true);
    for (const job of GATED_JOBS) expect(result[jobFlag(job)]).toBe(false);
  });

  test("an empty diff runs everything", () => {
    const result = flags([]);
    for (const area of AREAS) expect(result[area]).toBe(true);
    for (const job of GATED_JOBS) expect(result[jobFlag(job)]).toBe(true);
    expect(classifyChangedPaths([]).forcedBy).toEqual(["empty diff"]);
  });

  test("blank lines from an empty git diff still count as empty", () => {
    expect(flags(["", "  ", "\n"]).run_test_cli).toBe(true);
  });

  test("an unrecognised path runs everything and names itself", () => {
    const scope = classifyChangedPaths(["infra/railway/web.toml"]);
    for (const job of GATED_JOBS) expect(scope.flags[jobFlag(job)]).toBe(true);
    expect(scope.forcedBy).toEqual(["infra/railway/web.toml"]);
  });

  test("a lockfile or workflow change runs everything", () => {
    expect(flags(["bun.lock"]).run_test_web).toBe(true);
    expect(flags([".github/workflows/ci.yml"]).run_test_cli).toBe(true);
    expect(flags(["scripts/ci/changed-path-scope.ts"]).run_build).toBe(true);
  });

  test("one unrecognised path outweighs a pile of docs", () => {
    expect(flags(["README.md", "package.json"]).run_lint).toBe(true);
  });

  test("emits one key=value line per flag", () => {
    const lines = formatScope(classifyChangedPaths(["packages/cli/src/daemon.ts"])).split("\n");
    expect(lines).toContain("cli=true");
    expect(lines).toContain("web=false");
    expect(lines).toContain("run_test_cli=true");
    expect(lines).toContain("run_lint=false");
    expect(lines).toHaveLength(AREAS.length + GATED_JOBS.length);
  });
});

test("the classifier runs as a script and prints the flags", async () => {
  const proc = Bun.spawn(["bun", new URL("./changed-path-scope.ts", import.meta.url).pathname], {
    stdin: new TextEncoder().encode("packages/convex/convex/tasks.ts\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(stdout.split("\n")).toContain("run_test_convex=true");
  expect(stdout.split("\n")).toContain("run_test_cli=false");
});
