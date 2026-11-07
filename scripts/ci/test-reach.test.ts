// Keeps JOB_AREAS honest. A package test job is skipped when none of its areas
// changed, so each job must list every area its test files can be broken by.
// test-reach.ts computes that reach from the tree as it stands; this fails when
// a new cross-package import or disk read lands without the gate it needs.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { JOB_AREAS } from "./changed-path-scope";
import { JOB_TEST_ROOTS, LITERAL_FALSE_POSITIVES, reachOf, resolveImport } from "./test-reach";
import { SUITES, TREE_WIDE_TEST, treeWideFiles } from "./tree-wide-tests";

const ROOT = join(import.meta.dir, "..", "..");
const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, { steps: Array<{ run?: string; "working-directory"?: string }> }>;
};

describe("resolveImport", () => {
  const from = join(ROOT, "packages/web/lib/x.ts");

  test("resolves workspace packages through their manifests, without node_modules", () => {
    expect(resolveImport("@codecast/shared", from)).toBe(join(ROOT, "packages/shared/index.ts"));
    expect(resolveImport("@codecast/shared/contracts", from)).toBe(join(ROOT, "packages/shared/contracts/index.ts"));
    // No exports map: the subpath is a path inside the package. A file bun
    // cannot load (a .d.ts) still lands in the package's area.
    expect(resolveImport("@codecast/convex/convex/_generated/dataModel", from)?.startsWith(join(ROOT, "packages/convex/"))).toBe(true);
  });

  test("maps @platform to the mirror and drops builtins and npm packages", () => {
    expect(resolveImport("@platform/engine", from)).toBe(join(ROOT, "platform/packages"));
    expect(resolveImport("node:fs", from)).toBeNull();
    expect(resolveImport("bun:test", from)).toBeNull();
    expect(resolveImport("react", from)).toBeNull();
  });
});

describe("package test job gates", () => {
  test("every gated test job but the mirror's has its test roots listed", () => {
    const testJobs = Object.keys(JOB_AREAS).filter((job) => job.startsWith("test-") && job !== "test-platform");
    expect(Object.keys(JOB_TEST_ROOTS).sort()).toEqual(testJobs.sort());
    for (const roots of Object.values(JOB_TEST_ROOTS)) {
      for (const root of roots) expect(existsSync(join(ROOT, root)), root).toBe(true);
    }
  });

  // The roots must be where the job really runs tests from, or the reach
  // below describes some other suite.
  test("each job's roots are the directories its steps test", () => {
    for (const [job, roots] of Object.entries(JOB_TEST_ROOTS)) {
      const steps = workflow.jobs[job].steps.filter((step) => /\b(bun test|bun run test)\b/.test(step.run ?? ""));
      const dirs = steps.map((step) => step["working-directory"]);
      for (const root of roots) {
        const pkg = root.split("/").slice(0, 2).join("/");
        expect(dirs, `${job} runs tests in ${pkg}`).toContain(pkg);
      }
    }
  });

  test("each job gates on every area its test files reach", () => {
    const missing: string[] = [];
    for (const [job, roots] of Object.entries(JOB_TEST_ROOTS)) {
      for (const [area, chain] of reachOf(roots)) {
        // A file outside every area is a root file, and any change to one runs
        // every job.
        if (area === "unmapped") continue;
        if (!JOB_AREAS[job].includes(area)) missing.push(`${job} reaches ${area}: ${chain.join(" -> ")}`);
      }
    }
    expect(missing).toEqual([]);
  }, 120_000);

  // A resolver that silently stops following imports would pass the test
  // above with nothing reached, so pin a few edges known to exist.
  test("finds the cross-package edges known to exist", () => {
    expect(reachOf(JOB_TEST_ROOTS["test-web"]).has("convex")).toBe(true);
    expect(reachOf(JOB_TEST_ROOTS["test-convex"]).has("web")).toBe(true);
    expect(reachOf(JOB_TEST_ROOTS["test-cli"]).has("extension")).toBe(true);
  }, 120_000);

  test("every listed false positive still exists", () => {
    for (const file of Object.keys(LITERAL_FALSE_POSITIVES)) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });
});

describe("tree-wide tests", () => {
  test("each suite's roots are the directories its package job tests", () => {
    for (const suite of SUITES) {
      expect(Object.values(JOB_TEST_ROOTS).flat().some((root) => root.startsWith(suite.dir)), suite.dir).toBe(true);
    }
  });

  test("every guard and ratchet file a package job runs is in a suite", () => {
    const covered = new Set(SUITES.flatMap((suite) => treeWideFiles(suite).map((file) => join(suite.dir, file))));
    const glob = new Bun.Glob("packages/*/**/*.test.{ts,tsx,js,jsx,mjs,cjs}");
    const outside: string[] = [];
    for (const file of glob.scanSync({ cwd: ROOT })) {
      if (file.includes("/node_modules/") || !TREE_WIDE_TEST.test(file)) continue;
      const runByJob = Object.values(JOB_TEST_ROOTS).flat().some((root) => file.startsWith(`${root}/`));
      if (runByJob && !covered.has(file)) outside.push(file);
    }
    expect(outside).toEqual([]);
  });
});
