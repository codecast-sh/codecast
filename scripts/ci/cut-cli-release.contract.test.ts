// Pins the two release workflows against the properties that make the `cast
// computer` helper safe to ship (ct-49524).
//
// The helper is a separately signed app bundle that lives INSIDE the darwin CLI
// binaries. Nothing in the working tree shows it is there — the payload file is
// empty in a checkout — and the workflows can only be exercised by cutting a
// real release. So the invariants are pinned here: the helper is built once
// before the binaries, verified against the signing certificate the repo
// secrets hold, recorded in the manifest as part of each darwin artifact's
// identity, and refused by finalize when that record is missing, foreign, or
// disagrees between the two darwin builds.
import { describe, expect, test } from "bun:test";

type Workflow = { jobs: Record<string, { steps: any[] }> };
const read = async (file: string) =>
  Bun.YAML.parse(await Bun.file(new URL(`../../.github/workflows/${file}`, import.meta.url)).text()) as Workflow;

// Bun's YAML parser: no dependency, and the same runtime CI pins.
const cut = await read("cut-cli-release.yml");
const finalize = await read("finalize-cli-release.yml");
const script = (file: string) => Bun.file(new URL(`../../packages/cli/scripts/${file}`, import.meta.url)).text();
const binaries = await script("build-binaries.sh");
const deploy = await script("deploy.sh");

const steps = cut.jobs.build.steps;
const names: string[] = steps.map((step) => step.name ?? step.uses);
const at = (name: string) => {
  const index = names.indexOf(name);
  expect(index, `step "${name}"`).toBeGreaterThan(-1);
  return index;
};
const step = (name: string) => steps[at(name)];

const BUILD = "Build and sign the binaries";
const VERIFY_CLI = "Verify the signatures and embedded version";
const VERIFY_HELPER = "Verify the embedded cast computer helper";
const MANIFEST = "Write the artifact manifest";
const DISPATCH = "Dispatch the finalize workflow";

describe("the builder verifies the helper it embedded", () => {
  test("it runs the tested script, not an inline reimplementation", () => {
    // codesign, spctl and the tar unpack live in the script, where they are
    // graded by the same function the CLI uses before it swaps a helper in.
    const run = step(VERIFY_HELPER).run;
    expect(run).toContain("bun scripts/computer-helper-release.ts verify ../web/binaries");
    expect(run).not.toContain("codesign");
    expect(run).not.toContain("spctl");
  });

  test("it holds the helper to the certificate the repo secrets carry", () => {
    const run = step(VERIFY_HELPER).run;
    expect(run).toContain('--identity "$CODECAST_SIGN_IDENTITY"');
    expect(run).toContain('--team "$SIGN_TEAM_ID"');
    expect(run).toContain('--version "$RELEASE_VERSION"');
    // The same identity the darwin CLI binaries are signed under, so a rotated
    // certificate cannot leave the helper signed by the old one.
    expect(step(VERIFY_CLI).run).toContain("Authority=$CODECAST_SIGN_IDENTITY");
  });

  test("it runs on the built artifacts, before anything records or ships them", () => {
    expect(at(BUILD)).toBeLessThan(at(VERIFY_HELPER));
    expect(at(VERIFY_HELPER)).toBeLessThan(at(MANIFEST));
    expect(at(MANIFEST)).toBeLessThan(at(DISPATCH));
  });
});

describe("both release paths build the helper once", () => {
  test("the workflow builds through the shared script, so CI and the laptop ship the same helper", () => {
    expect(step(BUILD).run).toContain("./scripts/build-binaries.sh");
    expect(deploy).toContain("./scripts/build-binaries.sh");
  });

  test("one build, before the compile targets, handed to every target by env", () => {
    // A tar records mtimes, so a per-target build would give darwin-arm64 and
    // darwin-x64 different helpers and no single hash could identify one.
    const build = binaries.indexOf("computer-helper-release.ts build");
    const loop = binaries.indexOf('for target in "${targets[@]}"');
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(loop);
    expect(binaries).toContain("export CODECAST_COMPUTER_HELPER_TAR=");
  });

  test("the same script verifies the result after the darwin binaries are signed", () => {
    expect(binaries.indexOf("Signing macOS binaries")).toBeLessThan(binaries.indexOf("computer-helper-release.ts verify"));
  });
});

describe("the manifest carries the helper as part of the darwin artifacts", () => {
  const run = step(MANIFEST).run;

  test("the hash comes from the verify step's record, not a fresh hash of a file", () => {
    expect(run).toContain(`'.artifacts[$artifact] // "none"' computer-helper.json`);
  });

  test("only an artifact that carries a helper gets the field", () => {
    expect(run).toContain('(if $helper == "none" then {} else {computer_helper_sha256: $helper} end)');
  });

  test("the record reaches finalize inside the dispatched manifest", () => {
    expect(step(DISPATCH).run).toContain('-f "artifact_manifest=$(cat "$RUNNER_TEMP/release-manifest.json")"');
  });
});

describe("finalize refuses a manifest that misdescribes the helper", () => {
  const validate = (finalize.jobs.finalize.steps as any[]).find((s) =>
    typeof s.run === "string" && s.run.includes("artifact manifest must contain exactly five entries"),
  );

  test("a darwin entry must name a helper", () => {
    expect(validate).toBeDefined();
    expect(validate.run).toContain("codecast-darwin-*)");
    expect(validate.run.replace(/\s+/g, " ")).toContain(
      `'.artifacts[$artifact].computer_helper_sha256 | type == "string" and test("^[0-9a-f]{64}$")'`,
    );
  });

  test("a linux or windows entry must not", () => {
    expect(validate.run).toContain(`'.artifacts[$artifact] | has("computer_helper_sha256") | not'`);
  });

  test("one helper per release: both darwin entries must agree", () => {
    expect(validate.run).toContain("the two darwin artifacts carry different cast computer helpers");
  });
});
