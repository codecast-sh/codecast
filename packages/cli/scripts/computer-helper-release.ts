/**
 * The release half of the `cast computer` helper (ct-49524).
 *
 * The helper is a signed `codecast computer.app` bundle that rides inside the
 * darwin CLI binaries as a tar, embedded by `build-with-native.ts` as a bundled
 * file asset. Two facts about it have to be true of a release and neither is
 * visible in the working tree:
 *
 *   1. Both darwin artifacts carry the SAME helper, and its sha256 is recorded
 *      in the artifact manifest as part of each darwin artifact's identity.
 *      `build` makes that possible by compiling and signing the bundle once,
 *      before the five compile targets run.
 *   2. The bundle inside the shipped binary still passes `codesign --verify
 *      --strict` and `spctl --assess`, and the non-darwin binaries carry no
 *      helper at all. `verify` proves both against the built artifacts.
 *
 * A tar is not reproducible (it records mtimes), so "build once" is not an
 * optimisation here — it is the only way one hash can identify the helper.
 *
 * `verify` also proves one fact that is not about the helper but has the same
 * shape — only a built artifact can show it, and only by running it: the
 * compiled binary is still code split, so the lazy command groups cost nothing
 * until their verb runs (ct-49751). It lives here because this is already the
 * step that runs the freshly built darwin binary.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMPUTER_HELPER_BUNDLE_ID, COMPUTER_HELPER_BUNDLE_NAME, buildComputerHelper } from "./build-with-native.js";
import { gradeAssessment } from "../src/computer/helperApp.js";

/**
 * The tar member name that only exists when the bundle is actually embedded.
 * The CLI source never spells this path out (`helperApp.ts` builds it with
 * `path.join`), so finding it in a binary means the asset is in there. That is
 * what lets `verify` prove the LINUX and WINDOWS artifacts carry no helper —
 * they cannot be executed on the macOS release runner, so there is nothing to
 * ask them. It is only trustworthy because the same check must PASS on darwin:
 * if bun ever starts compressing embedded assets, the darwin assertion fails
 * loudly rather than the linux one passing for the wrong reason.
 */
const EMBEDDED_MARKER = `${COMPUTER_HELPER_BUNDLE_NAME}.app/Contents/MacOS/`;

const HELPER_TAR_NAME = "computer-helper.tar";
const HELPER_JSON_NAME = "computer-helper.json";
const DARWIN_ARTIFACTS = ["codecast-darwin-arm64", "codecast-darwin-x64"];
const OTHER_ARTIFACTS = ["codecast-linux-arm64", "codecast-linux-x64", "codecast-windows-x64.exe"];

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(command: string, argv: string[]): string {
  const result = spawnSync(command, argv, { encoding: "utf8", timeout: 300_000 });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed (${result.status ?? result.signal})\n${output}`);
  return output;
}

/** Compile and sign the bundle once, into `output`. Returns its sha256. */
export function buildHelperPayload(output: string): { sha256: string; size: number } {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-helper-"));
  try {
    const size = buildComputerHelper({ stage, output });
    if (size === 0) throw new Error("swift is not on PATH, so this build would ship a macOS CLI with no cast computer helper. Install the Xcode command line tools, or set CODECAST_SKIP_COMPUTER_HELPER=1 to ship without it.");
    return { sha256: sha256File(output), size };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export interface HelperIdentityExpectations {
  /** `Authority=` on the bundle's signature, e.g. the Developer ID cert. */
  identity?: string;
  /** `TeamIdentifier=` on the bundle's signature. */
  team?: string;
  /** `CFBundleShortVersionString`, which tracks the CLI version. */
  version?: string;
  /**
   * Accept an ad-hoc signature. Only for a CODECAST_SKIP_SIGN=1 build, which
   * ships a helper whose TCC grant resets on every rebuild — fine for a local
   * build, never for a release, so the flag has to be asked for.
   */
  allowAdhoc?: boolean;
}

/**
 * Unpack the payload and assert the bundle inside is the one this release
 * claims to ship: right path, right bundle id, right version, and a signature
 * macOS itself still accepts.
 */
export function verifyHelperBundle(tar: string, expect: HelperIdentityExpectations = {}): { version: string; authority: string } {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-verify-"));
  try {
    run("/usr/bin/tar", ["-xf", tar, "-C", stage]);
    const entries = fs.readdirSync(stage);
    // The basename is load-bearing: it is the last component of the fixed
    // materialization path, and TCC keys the grant to that resolved path.
    if (entries.length !== 1 || entries[0] !== `${COMPUTER_HELPER_BUNDLE_NAME}.app`) {
      throw new Error(`the helper tar must hold exactly "${COMPUTER_HELPER_BUNDLE_NAME}.app", found: ${entries.join(", ") || "nothing"}`);
    }
    const app = path.join(stage, entries[0]);
    const plist = (key: string) => run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(app, "Contents/Info.plist")]).trim();
    const bundleId = plist("CFBundleIdentifier");
    const version = plist("CFBundleShortVersionString");
    if (bundleId !== COMPUTER_HELPER_BUNDLE_ID) throw new Error(`helper bundle id is ${bundleId}, expected ${COMPUTER_HELPER_BUNDLE_ID}`);
    if (expect.version && version !== expect.version) throw new Error(`helper version is ${version}, expected ${expect.version}`);

    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", app]);
    const info = run("/usr/bin/codesign", ["-dvv", app]);
    const field = (name: string) => info.split("\n").find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? "";
    const adhoc = field("Signature") === "adhoc";
    if (adhoc && !expect.allowAdhoc) throw new Error("the helper is ad-hoc signed; a release helper must carry the Developer ID certificate, or its TCC grant resets on every update");
    if (!adhoc) {
      // Graded by the same function the CLI uses before it swaps a helper into
      // place, so a release can never pass a check the running CLI would fail.
      const assess = spawnSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", app], { encoding: "utf8", timeout: 300_000 });
      const graded = gradeAssessment(assess.status, `${assess.stdout ?? ""}${assess.stderr ?? ""}`);
      if (!graded.ok) throw new Error(`macOS rejected the helper bundle: ${graded.reason}`);
    }
    const authority = adhoc ? "ad-hoc" : field("Authority");
    if (field("Identifier") !== COMPUTER_HELPER_BUNDLE_ID) throw new Error(`helper signing identifier is ${field("Identifier")}, expected ${COMPUTER_HELPER_BUNDLE_ID}`);
    if (expect.identity && authority !== expect.identity) throw new Error(`helper is signed by ${authority || "nobody"}, expected ${expect.identity}`);
    if (expect.team && field("TeamIdentifier") !== expect.team) throw new Error(`helper team is ${field("TeamIdentifier")}, expected ${expect.team}`);
    return { version, authority };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function carriesHelper(binary: string): boolean {
  return fs.readFileSync(binary).includes(EMBEDDED_MARKER);
}

/** Ask a compiled binary what helper it carries. Returns null for "none". */
export function embeddedHelperSha256(binary: string): string | null {
  const result = spawnSync(binary, ["_computer-helper-tar"], { encoding: "utf8", timeout: 120_000, env: { ...process.env, CODECAST_NO_AUTO_UPDATE: "1" } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} _computer-helper-tar failed (${result.status ?? result.signal})\n${result.stderr ?? ""}`);
  const answer = result.stdout.trim();
  if (answer === "none") return null;
  if (!/^[0-9a-f]{64}$/.test(answer)) throw new Error(`${binary} _computer-helper-tar printed ${JSON.stringify(answer)}`);
  return answer;
}

/**
 * Bytes of JavaScript the artifact parses before it picks a verb.
 *
 * `bun build --compile --splitting` keeps every `await import()` in its own
 * chunk; without `--splitting` bun concatenates them all into the entry module
 * and the binary parses the whole CLI to print `cast --help`. Measured on bun
 * 1.3.14, darwin-arm64, on the release shape: 1,499 bytes split against
 * 4,312,289 unsplit, and `cast --help` about 165 -> 110 ms CPU (median of 11,
 * `cast bench boot --binary`, on identically signed artifacts).
 */
export function bootBytes(binary: string): number {
  const result = spawnSync(binary, ["_boot-bytes"], { encoding: "utf8", timeout: 120_000, env: { ...process.env, CODECAST_NO_AUTO_UPDATE: "1" } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} _boot-bytes failed (${result.status ?? result.signal})\n${result.stderr ?? ""}`);
  const answer = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(answer) || answer <= 0) throw new Error(`${binary} _boot-bytes printed ${JSON.stringify(result.stdout.trim())}`);
  return answer;
}

/**
 * The ceiling that separates a split build from an unsplit one, with room to
 * spare on both sides: the module holds fastPath.ts and nothing else, and the
 * unsplit figure is three orders of magnitude above this. It fails on the two
 * ways the win can be lost — the compile step stops splitting, or a static
 * import in fastPath.ts drags its graph back in front of every verb.
 */
export const BOOT_BYTES_CEILING = 64 * 1024;

export interface HelperReleaseRecord {
  version: string;
  sha256: string;
  size: number;
  authority: string;
  /** sha256 per artifact; null where the build carries no helper. */
  artifacts: Record<string, string | null>;
  /** What the runnable darwin artifact parses before it picks a verb. */
  bootBytes: number;
}

/**
 * Prove the release's helper claim against the built artifacts, and write the
 * record the manifest step reads.
 */
export function verifyRelease(binariesDir: string, expect: HelperIdentityExpectations = {}): HelperReleaseRecord {
  const tar = path.join(binariesDir, HELPER_TAR_NAME);
  if (!fs.existsSync(tar)) throw new Error(`${tar} is missing — run \`computer-helper-release.ts build\` before building the binaries`);
  const bundle = verifyHelperBundle(tar, expect);
  const sha256 = sha256File(tar);

  const artifacts: Record<string, string | null> = {};
  for (const artifact of DARWIN_ARTIFACTS) {
    const binary = path.join(binariesDir, artifact);
    if (!carriesHelper(binary)) throw new Error(`${artifact} does not carry the cast computer helper`);
    artifacts[artifact] = sha256;
  }
  for (const artifact of OTHER_ARTIFACTS) {
    const binary = path.join(binariesDir, artifact);
    if (carriesHelper(binary)) throw new Error(`${artifact} carries the macOS cast computer helper; only darwin builds may embed it`);
    artifacts[artifact] = null;
  }

  // The marker proves the bytes are in there; only running the binary proves
  // the CLI can still READ them after `bun build --compile`. Just the artifact
  // whose architecture this runner can execute — the other darwin binary is the
  // same bun build of the same payload.
  const native = `codecast-darwin-${process.arch === "x64" ? "x64" : "arm64"}`;
  const reported = embeddedHelperSha256(path.join(binariesDir, native));
  if (reported !== sha256) throw new Error(`${native} reports helper ${reported ?? "none"}, but the release built ${sha256}`);

  const parsed = bootBytes(path.join(binariesDir, native));
  if (parsed > BOOT_BYTES_CEILING) {
    throw new Error(`${native} parses ${parsed} bytes before it picks a verb, over the ${BOOT_BYTES_CEILING} ceiling — the lazy command groups are being parsed eagerly. Either the compile step lost --splitting (build-with-native.ts) or fastPath.ts gained a static import.`);
  }

  const record: HelperReleaseRecord = { version: bundle.version, sha256, size: fs.statSync(tar).size, authority: bundle.authority, artifacts, bootBytes: parsed };
  fs.writeFileSync(path.join(binariesDir, HELPER_JSON_NAME), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (import.meta.main) {
  const [command, target, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const index = rest.indexOf(`--${name}`);
    return index === -1 ? undefined : rest[index + 1];
  };
  if (command === "build") {
    if (!target) throw new Error("usage: computer-helper-release.ts build <output.tar>");
    const { sha256, size } = buildHelperPayload(target);
    console.log(`cast computer helper: ${size} bytes, sha256 ${sha256}`);
  } else if (command === "boot") {
    // The split half of `verify`, on its own, for a build that ships no helper
    // (CODECAST_SKIP_COMPUTER_HELPER=1, or a Mac without swift). The ceiling is
    // the point of the check, so it must not depend on the helper being there.
    if (!target) throw new Error("usage: computer-helper-release.ts boot <binaries-dir>");
    const native = `codecast-darwin-${process.arch === "x64" ? "x64" : "arm64"}`;
    const parsed = bootBytes(path.join(target, native));
    if (parsed > BOOT_BYTES_CEILING) throw new Error(`${native} parses ${parsed} bytes before it picks a verb, over the ${BOOT_BYTES_CEILING} ceiling — the compile step lost --splitting, or fastPath.ts gained a static import.`);
    console.log(`compiled boot: ${parsed} bytes parsed before the verb is picked`);
  } else if (command === "verify") {
    if (!target) throw new Error("usage: computer-helper-release.ts verify <binaries-dir> [--identity <authority>] [--team <id>] [--version <v>] [--allow-adhoc]");
    const record = verifyRelease(target, { identity: flag("identity"), team: flag("team"), version: flag("version"), allowAdhoc: rest.includes("--allow-adhoc") });
    console.log(`cast computer helper ${record.version}: sha256 ${record.sha256}, ${record.authority}`);
    console.log(`compiled boot: ${record.bootBytes} bytes parsed before the verb is picked`);
  } else {
    throw new Error(`unknown command ${JSON.stringify(command ?? "")}; expected build, verify or boot`);
  }
}
