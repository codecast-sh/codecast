import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRequiredReleaseAssetNames } from "./verify-release-required-assets.ts";

const WORKFLOW_PATH = new URL(
  "../../.github/workflows/finalize-cli-release.yml",
  import.meta.url,
);
// Bun's YAML parser: no dependency, and the same runtime CI pins.
const workflow = Bun.YAML.parse(await Bun.file(WORKFLOW_PATH).text()) as {
  jobs: Record<string, any>;
  concurrency: { group: string; "cancel-in-progress": boolean };
};

const steps: any[] = workflow.jobs.finalize.steps;
const names: string[] = steps.map((step) => step.name ?? step.uses);
const at = (name: string) => {
  const index = names.indexOf(name);
  expect(index, `step "${name}"`).toBeGreaterThan(-1);
  return index;
};
const step = (name: string) => steps[at(name)];
/** Every shell body in the job, so a check cannot be smuggled into another step. */
const runs: { name: string; run: string }[] = steps
  .filter((s) => typeof s.run === "string")
  .map((s) => ({ name: s.name ?? s.uses, run: s.run as string }));

const DRAFT_ASSERTION = "Verify the release is still a draft";
const ASSET_CHECK = "Verify every required release asset is present";
const PUBLISH = "Publish the GitHub release";
const LATEST_JSON = "Publish latest.json last";

describe("the job as a whole", () => {
  test("serializes against every other release run", () => {
    expect(workflow.concurrency.group).toBe("cli-release");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("every shell step fails on an unset variable and a broken pipe", () => {
    for (const { name, run } of runs) {
      if (!run.includes("\n")) continue; // single command steps have no prologue
      expect(run.startsWith("set -euo pipefail\n"), `${name} prologue`).toBe(true);
    }
  });
});

describe("the release is born a draft", () => {
  const create = step("Create or verify GitHub release");

  test("gh release create asks for a draft", () => {
    expect(create.run).toContain("gh release create");
    expect(create.run).toMatch(/gh release create "\$tag" "\$\{files\[@\]\}" \\\n\s*--draft\b/);
  });

  test("it publishes whether this run created the draft, for the assertion to read", () => {
    expect(create.id).toBe("github_release");
    expect(create.run).toContain('echo "created_draft=$created_draft" >> "$GITHUB_OUTPUT"');
    expect(step(DRAFT_ASSERTION).env.CREATED_DRAFT).toBe(
      "${{ steps.github_release.outputs.created_draft }}",
    );
  });

  test("every artifact list in the job opens with the five required assets", () => {
    const required = getRequiredReleaseAssetNames();
    // The R2 staging steps also carry release.json, which is an object in the
    // bucket and never a GitHub release asset.
    const alsoAllowed = ["release.json"];
    const lists = runs.filter(({ run }) => run.includes("artifacts=("));
    expect(lists.length).toBeGreaterThan(0);
    for (const { name, run } of lists) {
      const body = run.slice(run.indexOf("artifacts=(") + "artifacts=(".length);
      const listed = body
        .slice(0, body.indexOf(")"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      expect(listed.slice(0, required.length), `${name} artifact list`).toEqual(required);
      expect(listed.slice(required.length), `${name} extra artifacts`).toEqual(
        listed.slice(required.length).filter((extra) => alsoAllowed.includes(extra)),
      );
    }
  });
});

describe("nothing publishes the release before the checks", () => {
  test("only the publish step clears the draft flag", () => {
    const publishers = runs.filter(({ run }) => run.includes("--draft=false"));
    expect(publishers.map(({ name }) => name)).toEqual([PUBLISH]);
  });

  test("the draft assertion reads the draft-aware list and refuses a foreign publish", () => {
    const assertion = step(DRAFT_ASSERTION);
    expect(assertion.run).toContain('gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100"');
    expect(assertion.run).toContain("select(.tag_name == $tag)");
    expect(assertion.run).toContain('elif [[ "$CREATED_DRAFT" == "true" ]]; then');
    expect(assertion.run).toContain("published by something else");
  });

  test("the asset check runs the tested script, not an inline reimplementation", () => {
    expect(step(ASSET_CHECK).run.trim()).toBe(
      'bun scripts/ci/verify-release-required-assets.ts "v$RELEASE_VERSION"',
    );
    expect(step(ASSET_CHECK).env.GH_TOKEN).toBe("${{ github.token }}");
  });

  test("the publish step converges and is not a prerelease", () => {
    const publish = step(PUBLISH).run;
    expect(publish).toContain("did not converge to a published release");
    expect(publish).toContain("unexpectedly became a prerelease");
  });
});

describe("step order", () => {
  test("draft assertion, then assets, then publish, then latest.json", () => {
    expect(at("Create or verify GitHub release")).toBeLessThan(at(DRAFT_ASSERTION));
    expect(at(DRAFT_ASSERTION)).toBeLessThan(at(ASSET_CHECK));
    expect(at(ASSET_CHECK)).toBeLessThan(at(PUBLISH));
    expect(at(PUBLISH)).toBeLessThan(at(LATEST_JSON));
  });

  test("latest.json is written by one step, after the version commit and the tag", () => {
    const writers = runs.filter(({ run }) => run.includes('"s3://$R2_BUCKET/latest.json"'));
    expect(writers.map(({ name }) => name)).toEqual([LATEST_JSON]);
    expect(at("Revalidate main and atomically publish version commit and tag")).toBeLessThan(
      at(LATEST_JSON),
    );
  });

  test("the public manifest is verified after it is written", () => {
    expect(at(LATEST_JSON)).toBeLessThan(at("Verify the exact public manifest and referenced bytes"));
  });
});

async function runPublicRelease(options: { corruptImmutable?: boolean; failAliasCopy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cli-publication-"));
  const source = "a".repeat(40);
  const prefix = `cli/releases/v1.2.4/${source}`;
  const local = join(root, "cli-release");
  const bin = join(root, "bin");
  const authoritative = join(root, "authoritative-latest.json");
  mkdirSync(local);
  mkdirSync(bin);
  const artifacts = Object.fromEntries(getRequiredReleaseAssetNames().map((name) => {
    const bytes = `verified ${name}`;
    writeFileSync(join(local, name), bytes);
    return [name, { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }];
  }));
  const expected = JSON.stringify({ version: "1.2.4", source_commit: source, artifacts });
  writeFileSync(join(root, "release-expected.json"), expected);
  writeFileSync(join(local, "release.json"), expected);
  writeFileSync(join(root, "cli-release-prefix"), prefix);
  writeFileSync(authoritative, JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "aws"), `#!/bin/bash
set -euo pipefail
if [[ "$1" == "s3api" ]]; then
  [[ "$ALIAS_COPY_FAIL" == "0" ]]
elif [[ "$1" == "s3" && "$2" == "cp" ]]; then
  if [[ "$3" == s3://* ]]; then
    cp "$AUTHORITATIVE_MANIFEST" "$4"
  else
    cp "$3" "$AUTHORITATIVE_MANIFEST"
  fi
else
  exit 2
fi
`, { mode: 0o755 });
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.push(pathname);
      if (pathname === "/latest.json") return new Response(Bun.file(authoritative));
      if (pathname.startsWith(`/${prefix}/`)) {
        const name = pathname.slice(prefix.length + 2);
        if (options.corruptImmutable && name === "codecast-windows-x64.exe") {
          return new Response("corrupted immutable bytes");
        }
        return new Response(Bun.file(join(local, name)));
      }
      return new Response("stale legacy alias bytes");
    },
  });
  const selected = steps.filter((s) => [
    "Verify immutable public release bytes",
    LATEST_JSON,
    "Verify the exact public manifest and referenced bytes",
  ].includes(s.name) || s.name?.includes("legacy stable aliases"));
  const results: { name: string; code: number; stdout: string; stderr: string }[] = [];
  let failed = false;
  try {
    for (const s of selected) {
      const run = s.run.replaceAll("/tmp/", `${root}/`)
        .replaceAll("https://dl.codecast.sh", `http://127.0.0.1:${server.port}`);
      const child = Bun.spawn(["bash", "-c", run], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RELEASE_VERSION: "1.2.4",
          PREVIOUS_VERSION: "1.2.3",
          SOURCE_COMMIT: source,
          R2_BUCKET: "fixture",
          R2_ENDPOINT: "http://unused.invalid",
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          AUTHORITATIVE_MANIFEST: authoritative,
          ALIAS_COPY_FAIL: options.failAliasCopy ? "1" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      results.push({ name: s.name, code, stdout, stderr });
      if (code !== 0 && !s["continue-on-error"]) {
        failed = true;
        break;
      }
    }
    return { failed, results, requests, manifest: JSON.parse(readFileSync(authoritative, "utf8")) };
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("public release publication", () => {
  test("publishes verified immutable bytes when legacy URLs stay stale", async () => {
    const result = await runPublicRelease();
    expect(result.failed, JSON.stringify(result.results)).toBe(false);
    expect(result.manifest.version).toBe("1.2.4");
    expect(result.manifest.sourceCommit).toBe("a".repeat(40));
    for (const binary of Object.values(result.manifest.binaries) as { url: string; sha256: string }[]) {
      expect(binary.url).toContain(`/cli/releases/v1.2.4/${"a".repeat(40)}/`);
      expect(binary.sha256).toHaveLength(64);
    }
    expect(result.requests.every((url) => url === "/latest.json" || url.startsWith("/cli/releases/"))).toBe(true);
  }, 30_000);

  test("keeps the predecessor manifest when immutable bytes do not match", async () => {
    const result = await runPublicRelease({ corruptImmutable: true });
    expect(result.failed).toBe(true);
    expect(result.manifest.version).toBe("1.2.3");
    expect(result.results.at(-1)?.stdout).toContain("immutable public checksum did not converge");
  }, 30_000);

  test("a legacy alias copy failure cannot undo a verified publication", async () => {
    const result = await runPublicRelease({ failAliasCopy: true });
    expect(result.failed, JSON.stringify(result.results)).toBe(false);
    expect(result.manifest.version).toBe("1.2.4");
    const alias = steps.find((s) => s.name?.includes("legacy stable aliases"));
    expect(alias["continue-on-error"]).toBe(true);
    expect(alias["timeout-minutes"]).toBeLessThanOrEqual(3);
    expect(at(alias.name)).toBeGreaterThan(at("Verify the exact public manifest and referenced bytes"));
    expect(result.results.at(-1)?.code).not.toBe(0);
  }, 30_000);
});
