// Pins .github/workflows/finalize-cli-release.yml against the properties that
// make it safe to run: the release is born a draft, nothing publishes it until
// the draft assertion and the required assets check have run, and latest.json
// goes last. None of that is expressible in the YAML itself, and the workflow
// can only be exercised by cutting a real release (ct-49566).
import { describe, expect, test } from "bun:test";

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
