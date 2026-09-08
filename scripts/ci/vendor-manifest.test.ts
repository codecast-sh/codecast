// scripts/vendor-platform.sh is the only thing standing between the vendored
// @platform mirror and the fresh clones that ship it (Railway, the CLI release
// workflow, the desktop build). `--check` compares against the canonical repo
// and so cannot run in CI; `--check-manifest` is what a runner can prove, and
// these tests are what say it proves anything (ct-49675).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const SCRIPT = join(REPO, "scripts/vendor-platform.sh");

/** The script's own environment stripped of every pointer to a canonical repo. */
const NO_CANONICAL_REPO = { ...Bun.env, HOME: "/nonexistent", PLATFORM_SRC: undefined };

async function run(script: string, mode: string, env: Record<string, any> = NO_CANONICAL_REPO) {
  const proc = Bun.spawn(["bash", script, mode], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // `out` is what a human sees in a terminal; `stdout` alone is what a caller
  // pipes, and the notices about skipped packages must stay off it.
  return { code: await proc.exited, out: stdout + stderr, stdout };
}

describe("the committed mirror", () => {
  test("passes --check-manifest with no canonical repo in reach", async () => {
    // The whole point of the mode: a GitHub runner has no ~/src/platform.
    const result = await run(SCRIPT, "--check-manifest");
    expect(result.out).toContain("internally consistent");
    expect(result.code).toBe(0);
  }, 30_000);

  test("--list prints exactly the mirrored packages", async () => {
    const result = await run(SCRIPT, "--list");
    expect(result.code).toBe(0);
    const listed = result.stdout.trim().split("\n");
    expect(listed.length).toBeGreaterThan(0);
    for (const pkg of listed) {
      const name = await Bun.file(join(REPO, "platform/packages", pkg, "package.json")).json();
      expect(name.name, `${pkg} package.json name`).toBe(`@platform/${pkg}`);
    }
  });

  test("refuses a mode it does not know instead of vendoring", async () => {
    // The old script treated every argument except --check as "go vendor", so a
    // typo overwrote the mirror from whatever $PLATFORM_SRC happened to be.
    const result = await run(SCRIPT, "--chekc-manifest");
    expect(result.code).toBe(2);
    expect(result.out).toContain("unknown mode");
  });
});

// A fixture repo laid out like the real one, with the real script copied in so
// it resolves the fixture as its root. Nothing here touches the checkout.
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; script: string }> {
  const root = mkdtempSync(join(tmpdir(), "vendor-manifest-"));
  fixtures.push(root);
  await Bun.write(join(root, "scripts/vendor-platform.sh"), await Bun.file(SCRIPT).text());
  await Bun.write(
    join(root, "packages/app/package.json"),
    JSON.stringify(
      { name: "@codecast/app", dependencies: { "@platform/foo": "file:../../platform/packages/foo" } },
      null,
      2,
    ),
  );
  await Bun.write(
    join(root, "platform/packages/foo/package.json"),
    JSON.stringify({ name: "@platform/foo" }, null, 2),
  );
  await Bun.write(join(root, "platform/packages/foo/src/index.ts"), "export const foo = 1;\n");
  return { root, script: join(root, "scripts/vendor-platform.sh") };
}

describe("--check-manifest", () => {
  test("fails until a manifest exists, then passes", async () => {
    const { script } = await fixture();
    expect((await run(script, "--check-manifest")).out).toContain("is missing");
    expect((await run(script, "--write-manifest")).code).toBe(0);
    expect((await run(script, "--check-manifest")).code).toBe(0);
  });

  test("catches a mirror edited by hand", async () => {
    // The rule the mirror rests on: never edit platform/packages directly.
    // Nothing enforced it before this check.
    const { root, script } = await fixture();
    await run(script, "--write-manifest");
    await Bun.write(join(root, "platform/packages/foo/src/index.ts"), "export const foo = 2;\n");
    const result = await run(script, "--check-manifest");
    expect(result.code).toBe(1);
    expect(result.out).toContain("platform/packages/foo does not match the manifest");
  });

  test("catches a new file dropped into the mirror", async () => {
    const { root, script } = await fixture();
    await run(script, "--write-manifest");
    await Bun.write(join(root, "platform/packages/foo/src/extra.ts"), "export const extra = 1;\n");
    const result = await run(script, "--check-manifest");
    expect(result.code).toBe(1);
    expect(result.out).toContain("platform/packages/foo does not match the manifest");
  });

  test("catches a package adopted without a re-vendor", async () => {
    const { root, script } = await fixture();
    await run(script, "--write-manifest");
    await Bun.write(
      join(root, "packages/app/package.json"),
      JSON.stringify(
        {
          name: "@codecast/app",
          dependencies: {
            "@platform/foo": "file:../../platform/packages/foo",
            "@platform/bar": "file:../../platform/packages/bar",
          },
        },
        null,
        2,
      ),
    );
    const result = await run(script, "--check-manifest");
    expect(result.code).toBe(1);
    expect(result.out).toContain("platform/packages/bar is declared as a dep but not mirrored");
  });

  test("catches a mirrored package nothing depends on", async () => {
    const { root, script } = await fixture();
    await Bun.write(
      join(root, "platform/packages/orphan/package.json"),
      JSON.stringify({ name: "@platform/orphan" }, null, 2),
    );
    await run(script, "--write-manifest");
    const result = await run(script, "--check-manifest");
    expect(result.code).toBe(1);
    expect(result.out).toContain("platform/packages/orphan is mirrored but no workspace package");
  });

  test("catches a dep pointing outside the checkout", async () => {
    // The reason the mirror exists at all: a fresh clone has no ~/src/platform,
    // so a dep resolving out of the tree breaks every build that ships.
    const { root, script } = await fixture();
    await run(script, "--write-manifest");
    await Bun.write(
      join(root, "packages/app/package.json"),
      JSON.stringify(
        { name: "@codecast/app", dependencies: { "@platform/foo": "file:~/src/platform/packages/foo" } },
        null,
        2,
      ),
    );
    const result = await run(script, "--check-manifest");
    expect(result.code).toBe(1);
    expect(result.out).toContain("do not point at file:../../platform/packages/<name>");
  });

  test("reads past an @platform key that declares no path", async () => {
    // peerDependenciesMeta holds an object, not a path, so it is not a dep
    // pointing anywhere and must not read as one.
    const { root, script } = await fixture();
    await Bun.write(
      join(root, "packages/app/package.json"),
      JSON.stringify(
        {
          name: "@codecast/app",
          dependencies: { "@platform/foo": "file:../../platform/packages/foo" },
          peerDependenciesMeta: { "@platform/foo": { optional: true } },
        },
        null,
        2,
      ),
    );
    await run(script, "--write-manifest");
    expect((await run(script, "--check-manifest")).code).toBe(0);
  });

  test("catches a dep whose name and directory disagree", async () => {
    const { root, script } = await fixture();
    await Bun.write(
      join(root, "packages/app/package.json"),
      JSON.stringify(
        { name: "@codecast/app", dependencies: { "@platform/bar": "file:../../platform/packages/foo" } },
        null,
        2,
      ),
    );
    await run(script, "--write-manifest");
    const result = await run(script, "--check-manifest");
    expect(result.code).toBe(1);
    expect(result.out).toContain("@platform deps whose name and directory disagree");
  });

  test("ignores what a per-package bun install leaves behind", async () => {
    // The CI job installs into each mirrored package to run its tests. Those
    // artifacts must never read as drift, or the job fails itself on a re-run.
    const { root, script } = await fixture();
    await run(script, "--write-manifest");
    await Bun.write(join(root, "platform/packages/foo/bun.lock"), "{}\n");
    await Bun.write(join(root, "platform/packages/foo/node_modules/dep/index.js"), "module.exports={}\n");
    await Bun.write(join(root, "platform/packages/foo/dist/index.js"), "export const foo=1\n");
    expect((await run(script, "--check-manifest")).code).toBe(0);
  });
});

// The CI loop asks the script which packages have a suite, because `bun test`
// exits 1 when it matches nothing. Asking with a pattern narrower than bun's own
// is the silent failure: an earlier draft looked for *.test.ts and dropped
// @platform/desktop, whose suite is entirely .test.js, with a skip notice.
describe("--list-with-tests", () => {
  test("names every mirrored package that bun would find tests in", async () => {
    const all = (await run(SCRIPT, "--list")).stdout.trim().split("\n");
    const testable = (await run(SCRIPT, "--list-with-tests")).stdout.trim().split("\n");
    for (const pkg of all) {
      const dir = join(REPO, "platform/packages", pkg);
      const found = new Bun.Glob("**/*.{test,spec}.{js,jsx,ts,tsx}").scanSync({ cwd: dir });
      const hasTests = !found.next().done;
      expect(testable.includes(pkg), `${pkg} hasTests=${hasTests}`).toBe(hasTests);
    }
  }, 30_000);

  test("counts a JavaScript suite, not just a TypeScript one", async () => {
    const { root, script } = await fixture();
    await Bun.write(join(root, "platform/packages/foo/src/thing.test.js"), "test('x', () => {});\n");
    expect((await run(script, "--list-with-tests")).stdout.trim()).toBe("foo");
  });

  test("leaves out a package with no suite, and says so", async () => {
    const { script } = await fixture();
    const result = await run(script, "--list-with-tests");
    expect(result.code).toBe(0);
    expect(result.out).toContain("platform/packages/foo has no tests");
  });

  test("does not count a dependency's tests as the package's own", async () => {
    const { root, script } = await fixture();
    await Bun.write(join(root, "platform/packages/foo/node_modules/dep/x.test.ts"), "test('x',()=>{});\n");
    const result = await run(script, "--list-with-tests");
    expect(result.stdout.trim()).toBe("");
    expect(result.out).toContain("platform/packages/foo has no tests");
  });
});
