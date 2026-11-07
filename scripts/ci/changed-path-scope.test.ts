import { describe, expect, test } from "bun:test";

import {
  AREAS,
  GATED_JOBS,
  areaOf,
  classifyChangedPaths,
  formatScope,
  jobFlag,
  touchesPlatform,
  touchesComputer,
  computerScope,
} from "./changed-path-scope";

const flags = (files: string[]) => classifyChangedPaths(files).flags;

describe("areaOf", () => {
  test("maps each package to its area", () => {
    expect(areaOf("packages/cli/src/daemon.ts")).toBe("cli");
    expect(areaOf("packages/evals/src/x.ts")).toBe("evals");
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
  // The jobs one change runs. Each set follows from what the job's files
  // import or read (test-reach.test.ts checks those edges against the tree).
  const ran = (files: string[]) => GATED_JOBS.filter((job) => flags(files)[jobFlag(job)]).sort();

  test("a docs-only change runs the cli and shared suites, which read docs/", () => {
    const result = flags(["docs/architecture/sync-host.md", "README.md"]);
    expect(result.docs).toBe(true);
    expect(ran(["docs/architecture/sync-host.md", "README.md"])).toEqual(["test-cli", "test-shared"]);
    for (const area of AREAS) {
      if (area !== "docs") expect(result[area]).toBe(false);
    }
  });

  // The few web and convex test files that import cli code run in
  // test-always instead.
  test("a cli change runs build, typecheck and the cli tests", () => {
    expect(ran(["packages/cli/src/daemon.ts"])).toEqual(["build", "test-cli", "typecheck"]);
  });

  // convex source imports web code. The cli test files that read web files
  // run in test-always instead.
  test("a web change runs lint and the web, convex and mobile tests", () => {
    expect(ran(["packages/web/components/DiffView.tsx"])).toEqual(
      ["build", "lint", "test-convex", "test-mobile", "test-web", "typecheck"],
    );
  });

  test("a convex change runs the convex, web, cli and mobile tests", () => {
    expect(ran(["packages/convex/convex/tasks.ts"])).toEqual(
      ["build", "test-cli", "test-convex", "test-mobile", "test-web", "typecheck"],
    );
  });

  // The eval home's unit tests are a step of test-cli.
  test("an evals change runs typecheck and the cli tests without forcing every job", () => {
    const scope = classifyChangedPaths(["packages/evals/src/x.ts"]);
    expect(scope.forcedBy).toEqual([]);
    expect(ran(["packages/evals/src/x.ts"])).toEqual(["test-cli", "typecheck"]);
  });

  test("a shared change runs every job that reads shared", () => {
    expect(ran(["packages/shared/contracts/inboxProjection.ts"])).toEqual(
      ["build", "test-cli", "test-convex", "test-mobile", "test-shared", "test-web", "typecheck"],
    );
  });

  // The vendored mirror is a dependency of every package, so a change to it
  // reaches every job that reads it, and the job that tests the mirror itself
  // (ct-49675). Only packages/web has a lint script.
  test("a vendored platform change runs every job but lint", () => {
    const result = flags(["platform/packages/engine/src/store.ts"]);
    expect(result.platform).toBe(true);
    expect(result.shared).toBe(false);
    expect(ran(["platform/packages/engine/src/store.ts"])).toEqual(GATED_JOBS.filter((job) => job !== "lint").sort());
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

  test("a mobile change runs the mobile tests only", () => {
    expect(flags(["packages/mobile/app/index.tsx"]).mobile).toBe(true);
    expect(ran(["packages/mobile/app/index.tsx"])).toEqual(["test-mobile"]);
  });

  // web imports electron's window registry, so an electron change reaches
  // every job that loads web code.
  test("an electron or desktop change runs the electron tests and everything that loads web", () => {
    for (const file of ["packages/electron/main.js", "packages/desktop/src-tauri/tauri.conf.json"]) {
      expect(flags([file]).electron).toBe(true);
      expect(ran([file]), file).toEqual(["build", "test-electron", "test-mobile", "test-web", "typecheck"]);
    }
  });

  // The cli files that read the extension's manifest run in test-always.
  test("an extension change runs build only", () => {
    expect(ran(["packages/browser-extension/background.js"])).toEqual(["build"]);
  });

  test("the electron tests rerun for the vendored @platform/desktop they require", () => {
    expect(flags(["platform/packages/desktop/src/index.js"]).run_test_electron).toBe(true);
    expect(flags(["packages/electron/package.json"]).run_test_electron).toBe(true);
    expect(flags(["packages/web/components/DiffView.tsx"]).run_test_electron).toBe(false);
    expect(flags(["packages/shared/contracts/agentClients.ts"]).run_test_electron).toBe(false);
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
    stdin: new TextEncoder().encode("packages/mobile/app/index.tsx\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(stdout.split("\n")).toContain("run_test_mobile=true");
  expect(stdout.split("\n")).toContain("run_test_web=false");
});

describe("computer test scope", () => {
  test("runs for computer source, native helpers and verification scripts", () => {
    for (const file of [
      "packages/cli/src/computer/client.ts",
      "packages/cli/src/computer/__fixtures__/fakeHelper.ts",
      "packages/cli/native/computer-use-macos/Package.swift",
      "packages/cli/scripts/computer-verify.ts",
    ]) expect(touchesComputer(file)).toBe(true);
  });

  test("does not run for unrelated CLI, web or documentation changes", () => {
    for (const file of ["packages/cli/src/daemon.ts", "packages/web/index.ts", "docs/README.md", ""])
      expect(touchesComputer(file)).toBe(false);
  });

  // Same fail-closed rule as classifyChangedPaths: an empty diff is a failed
  // git command or a missing base, not a no-op.
  test("an empty diff runs the helper lane, an unrelated one skips it", () => {
    expect(computerScope([])).toBe(true);
    expect(computerScope(["", "  "])).toBe(true);
    expect(computerScope(["packages/cli/src/daemon.ts"])).toBe(false);
    expect(computerScope(["packages/cli/src/daemon.ts", "packages/cli/src/computer/client.ts"])).toBe(true);
  });

  test("the script prints the fail-closed flag on empty input", async () => {
    const proc = Bun.spawn(["bun", new URL("./changed-path-scope.ts", import.meta.url).pathname, "--computer-only"], {
      stdin: new TextEncoder().encode("\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout.trim()).toBe("run_test_computer=true");
  });
});
