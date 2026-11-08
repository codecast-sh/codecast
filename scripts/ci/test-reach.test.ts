// Pins the test reach analysis that decides which test files run on every
// change. A package test job is skipped when none of its areas changed; any of
// its files that can be broken from outside those areas must be in the
// always-run set, or that skip hides a failure.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { JOB_AREAS } from "./changed-path-scope";
import { alwaysRunFiles, SUITES } from "./always-run-tests";
import {
  crossingTests,
  JOB_TEST_ROOTS,
  jobTestFiles,
  LITERAL_FALSE_POSITIVES,
  literalReach,
  reachOf,
  resolveImport,
  TREE_WIDE_TEST,
} from "./test-reach";

const ROOT = join(import.meta.dir, "..", "..");
const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, { steps: Array<{ run?: string; "working-directory"?: string }> }>;
};

const cache = new Map<string, unknown>();
const once = <T>(key: string, compute: () => T): T => {
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key) as T;
};
const reachOfJob = (job: string) => once(`reach:${job}`, () => reachOf(job));
const crossingOf = (job: string) => once(`crossing:${job}`, () => crossingTests(job));

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

describe("job test roots", () => {
  test("every gated test job but the mirror's has its test roots listed", () => {
    const testJobs = Object.keys(JOB_AREAS).filter((job) => job.startsWith("test-") && job !== "test-platform");
    expect(Object.keys(JOB_TEST_ROOTS).sort()).toEqual(testJobs.sort());
    for (const roots of Object.values(JOB_TEST_ROOTS)) {
      for (const root of roots) expect(existsSync(join(ROOT, root)), root).toBe(true);
    }
  });

  // The roots must be where the job really runs tests from, or the reach
  // describes some other suite.
  test("each job's roots are in the packages its steps test", () => {
    for (const [job, roots] of Object.entries(JOB_TEST_ROOTS)) {
      const dirs = workflow.jobs[job].steps
        .filter((step) => /\b(bun test|bun run test)\b/.test(step.run ?? ""))
        .map((step) => step["working-directory"]);
      for (const root of roots) {
        const pkg = root.split("/").slice(0, 2).join("/");
        expect(dirs, `${job} runs tests in ${pkg}`).toContain(pkg);
      }
    }
  });

  test("every listed false positive still exists", () => {
    for (const file of Object.keys(LITERAL_FALSE_POSITIVES)) expect(existsSync(join(ROOT, file)), file).toBe(true);
  });
});

describe("reach", () => {
  // A resolver that silently stopped following imports would find no
  // crossing tests and pass everything below, so pin edges known to exist.
  test("finds the cross-package edges known to exist", () => {
    expect(reachOfJob("test-web").has("convex")).toBe(true);
    expect(reachOfJob("test-web").has("electron")).toBe(true);
    expect(reachOfJob("test-convex").has("web")).toBe(true);
    expect(reachOfJob("test-cli").has("extension")).toBe(true);
    expect(reachOfJob("test-cli").has("web")).toBe(true);
  }, 120_000);

  // Paths spelled as segments, join(dir, "..", "..", "cli", "src"), reach as
  // far as a joined "../cli/" does.
  test("finds a reach spelled as path segments", () => {
    const desktop = crossingOf("test-web").find(({ file }) => file.endsWith("packages/web/lib/desktop.test.ts"));
    expect(desktop?.areas.map(([area]) => area)).toEqual(expect.arrayContaining(["cli", "extension"]));
  }, 120_000);

  test("reads spelled as segments, from the file or from the repo root, count as reach", () => {
    const read = (path: string) => `import { readFileSync } from "node:fs";\nreadFileSync(${path});`;
    const areas = (file: string, text: string, own: string) => literalReach(file, text, own).map(([area]) => area);
    expect(areas("packages/web/lib/desktop.test.ts", read(`join(import.meta.dir, "..", "..", "cli", "src", "observe.ts")`), "web")).toEqual(["cli"]);
    expect(areas("packages/evals/src/x.test.ts", read(`join(ROOT, "packages", "web", "scripts", "sim.ts")`), "evals")).toEqual(["web"]);
    // From product code a rooted path is usually someone else's checkout.
    expect(areas("packages/evals/src/x.ts", read(`join(ROOT, "packages", "web", "scripts", "sim.ts")`), "evals")).toEqual([]);
  });

  test("every area a job's files reach is that job's or reached only by files that always run", () => {
    for (const job of Object.keys(JOB_TEST_ROOTS)) {
      const covered = new Set(crossingOf(job).flatMap(({ areas }) => areas.map(([area]) => area)));
      for (const [area, chain] of reachOfJob(job)) {
        if (area === "unmapped" || JOB_AREAS[job].includes(area)) continue;
        expect(covered.has(area), `${job} reaches ${area} with no crossing test: ${chain.join(" -> ")}`).toBe(true);
      }
    }
  }, 120_000);
});

describe("always-run set", () => {
  const always = () =>
    once("always", () => new Set(SUITES.flatMap((suite) => alwaysRunFiles(suite).map((file) => join(suite.dir, file)))));

  test("holds every crossing test", () => {
    for (const job of Object.keys(JOB_TEST_ROOTS)) {
      const missing = crossingOf(job).map(({ file }) => file).filter((file) => !always().has(file));
      expect(missing, job).toEqual([]);
    }
  }, 120_000);

  test("holds every guard and ratchet test a package job runs", () => {
    for (const job of Object.keys(JOB_TEST_ROOTS)) {
      const missing = jobTestFiles(job)
        .filter((file) => TREE_WIDE_TEST.test(file))
        .map((file) => file.slice(ROOT.length + 1))
        .filter((file) => !always().has(file));
      expect(missing, job).toEqual([]);
    }
  }, 120_000);

  // Each crossing test runs on every change. When one area accounts for many
  // of a job's crossing tests, gating the job on that area is cheaper than
  // running them all every time: add the area to JOB_AREAS.
  test("stays small enough that gating is still worth it", () => {
    for (const job of Object.keys(JOB_TEST_ROOTS)) {
      const crossing = crossingOf(job);
      const byArea = new Map<string, number>();
      for (const { areas } of crossing) for (const [area] of areas) byArea.set(area, (byArea.get(area) ?? 0) + 1);
      for (const [area, count] of byArea) {
        expect(count, `${job}: ${count} test files reach ${area}; add "${area}" to its JOB_AREAS`).toBeLessThanOrEqual(40);
      }
    }
  }, 120_000);
});
