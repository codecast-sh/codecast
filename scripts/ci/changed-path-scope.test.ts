import { describe, expect, test } from "bun:test";

import {
  AREAS,
  GATED_JOBS,
  areaOf,
  classifyChangedPaths,
  formatScope,
  jobFlag,
  touchesPlatform,
} from "./changed-path-scope";

const flags = (files: string[]) => classifyChangedPaths(files).flags;

describe("areaOf", () => {
  test("maps each package to its area", () => {
    expect(areaOf("packages/cli/src/daemon.ts")).toBe("cli");
    expect(areaOf("packages/web/components/DiffView.tsx")).toBe("web");
    expect(areaOf("packages/convex/convex/tasks.ts")).toBe("convex");
    expect(areaOf("packages/shared/contracts/agentClients.ts")).toBe("shared");
    expect(areaOf("platform/packages/engine/src/index.ts")).toBe("platform");
    expect(areaOf("platform/vendor-manifest.txt")).toBe("platform");
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

describe("touchesPlatform", () => {
  test("claims the mirror and the manifests the mirror is derived from", () => {
    expect(touchesPlatform("platform/packages/keys/src/index.ts")).toBe(true);
    expect(touchesPlatform("platform/vendor-manifest.txt")).toBe(true);
    expect(touchesPlatform("packages/web/package.json")).toBe(true);
    expect(touchesPlatform("packages/cli/package.json")).toBe(true);
  });

  test("claims nothing else", () => {
    expect(touchesPlatform("packages/web/components/DiffView.tsx")).toBe(false);
    // Only a workspace root manifest declares an @platform dep; one nested
    // inside a package is a fixture or a bundled copy.
    expect(touchesPlatform("packages/cli/src/fixtures/package.json")).toBe(false);
    expect(touchesPlatform("package.json")).toBe(false);
    expect(touchesPlatform("docs/architecture/sync-host.md")).toBe(false);
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

  test("a cli change runs build and the cli tests only", () => {
    const result = flags(["packages/cli/src/daemon.ts"]);
    expect(result.cli).toBe(true);
    expect(result.run_build).toBe(true);
    expect(result.run_test_cli).toBe(true);
    expect(result.run_typecheck).toBe(false);
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

  // The vendored mirror is a dependency of every package, so a change to it has
  // to keep reaching the jobs that used to see it through "shared" — and now
  // also reach the job that tests the mirror itself (ct-49675).
  test("a vendored platform change runs every job that reads the mirror", () => {
    const result = flags(["platform/packages/engine/src/store.ts"]);
    expect(result.platform).toBe(true);
    expect(result.shared).toBe(false);
    expect(result.run_test_platform).toBe(true);
    expect(result.run_build).toBe(true);
    expect(result.run_typecheck).toBe(true);
    expect(result.run_test_cli).toBe(true);
    expect(result.run_test_web).toBe(true);
    expect(result.run_test_convex).toBe(true);
    expect(result.run_lint).toBe(false);
  });

  test("a workspace manifest re-checks the mirror it declares", () => {
    // The mirror's package set is read out of these files, so adopting or
    // dropping an @platform dep here is what makes the mirror wrong.
    const result = flags(["packages/web/package.json"]);
    expect(result.run_test_platform).toBe(true);
    expect(result.web).toBe(true);
    expect(result.run_lint).toBe(true);
  });

  test("changes that cannot touch the mirror leave its job alone", () => {
    expect(flags(["packages/web/components/DiffView.tsx"]).run_test_platform).toBe(false);
    expect(flags(["packages/cli/src/daemon.ts"]).run_test_platform).toBe(false);
    expect(flags(["packages/shared/contracts/agentClients.ts"]).run_test_platform).toBe(false);
    expect(flags(["docs/architecture/sync-host.md"]).run_test_platform).toBe(false);
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
