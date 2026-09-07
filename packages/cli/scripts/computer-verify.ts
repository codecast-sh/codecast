#!/usr/bin/env bun
/**
 * `cast computer` verification on a real Mac (A7, ct-49523).
 *
 * The design leaves two things to measurement rather than argument, and both
 * need a machine with the helper granted, which no unit test can have. This
 * script is those two procedures, so whoever holds the grant runs them with one
 * command instead of reconstructing them from the design:
 *
 *   bun scripts/computer-verify.ts confirm
 *
 *   confirm-swap   design 17.1 — the TCC grant survives replacing the bundle's
 *                  contents at the fixed path. Builds a second payload, swaps
 *                  it in through the production `swapIntoPlace`, and re-reads
 *                  the grant. A regrant prompt or a not-granted answer means
 *                  the signing identity moved between the two builds.
 *   confirm-route  design 3.4 / 17.2 — the disclaimed spawn reports the
 *                  HELPER's permission state, not one inherited from its
 *                  parent. Runs the probe by all three routes and compares.
 *
 * It also carries the plumbing those procedures need, which is the same
 * plumbing the CI lane and a human setting the feature up need:
 *
 *   build      compile + sign the helper and write its tar (and an unpacked
 *              .app, for CODECAST_COMPUTER_HELPER_APP)
 *   install    put a built tar at the fixed path
 *   status     read the helper's own grants without opening any window
 *   cli        run the from-source CLI with a built payload staged in
 *
 * Everything writes to stdout; the exit code is the verdict.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { buildComputerHelper, COMPUTER_HELPER_PAYLOAD } from "./build-with-native.js";
import {
  HELPER_APP_BASENAME,
  computerHome,
  helperAppPath,
  helperExecutablePath,
  inspectSignature,
  readInstallStamp,
  repairHalfSwap,
  swapIntoPlace,
  withPrepareLock,
} from "../src/computer/helperApp.js";
import { probeHelperPermissions } from "../src/test-helpers/computerPermissionProbe.js";

const CLI_ROOT = path.join(import.meta.dir, "..");
const PROBE_SETTLE_MS = 30_000;

function fail(message: string): never {
  console.error(`x ${message}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(cmd: string, argv: string[]): void {
  const result = spawnSync(cmd, argv, { stdio: "inherit" });
  if (result.status !== 0) fail(`${cmd} failed (${result.status ?? result.signal})`);
}

/** What a TCC grant is keyed to besides the path: who signed the bundle, under
 *  what identifier, and (to prove a swap really swapped) its content hash. */
function signingIdentity(appPath: string): { identifier: string; team: string; cdhash: string } {
  const out = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
  const text = `${out.stderr ?? ""}${out.stdout ?? ""}`;
  const pick = (re: RegExp) => text.match(re)?.[1]?.trim() ?? "";
  return {
    identifier: pick(/^Identifier=(.*)$/m),
    team: pick(/^TeamIdentifier=(.*)$/m) || (/Signature=adhoc/.test(text) ? "adhoc" : ""),
    cdhash: pick(/^CDHash=(.*)$/m),
  };
}

// ------------------------------------------------------------------ build

function build(args: string[]): { tar: string; app: string } {
  const stage = flag(args, "stage") ?? fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-build-"));
  const tar = flag(args, "out") ?? path.join(stage, "helper.tar");
  fs.mkdirSync(path.dirname(tar), { recursive: true });
  const size = buildComputerHelper({ stage, output: tar, version: flag(args, "version") });
  if (size === 0) fail("swift is not on PATH, so there is nothing to verify");

  // Unpack a copy beside the tar: the e2e suites take a bundle path in
  // CODECAST_COMPUTER_HELPER_APP, not a tar.
  const unpacked = path.join(path.dirname(tar), "unpacked");
  fs.rmSync(unpacked, { recursive: true, force: true });
  fs.mkdirSync(unpacked, { recursive: true });
  run("/usr/bin/tar", ["-xf", tar, "-C", unpacked]);
  const app = path.join(unpacked, HELPER_APP_BASENAME);

  const identity = signingIdentity(app);
  const arches = spawnSync("/usr/bin/lipo", ["-archs", helperExecutablePath(app)], { encoding: "utf8" }).stdout?.trim();
  console.log(`built ${tar}`);
  console.log(`  ${size} bytes, sha256 ${sha256(tar)}`);
  console.log(`  app ${app}`);
  console.log(`  identifier ${identity.identifier}, team ${identity.team || "(none)"}, arches ${arches}`);
  return { tar, app };
}

// ---------------------------------------------------------------- install

/**
 * Put a built tar at the fixed path, through the production swap.
 *
 * This exists because `materializeHelperApp` can only unpack the payload
 * EMBEDDED in the running CLI, and a from-source CLI carries an empty one. It
 * reuses `swapIntoPlace`, so the journal, the `old/` displacement and the
 * install stamp are the real ones — only the source of the bytes differs.
 *
 * The signature is reported, never enforced. `materializeHelperApp` aborts here
 * on `spctl --assess`, which rejects every unnotarized Developer ID build
 * (ct-49662); enforcing it too would leave this script unable to install the
 * very bundle the release ships.
 */
async function install(tarPath: string, opts: { version?: string } = {}): Promise<string> {
  if (!fs.existsSync(tarPath)) fail(`no such payload: ${tarPath}`);
  const root = computerHome();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return await withPrepareLock(() => {
    repairHalfSwap();
    const stagingDir = fs.mkdtempSync(path.join(root, ".staging-"));
    fs.chmodSync(stagingDir, 0o700);
    try {
      run("/usr/bin/tar", ["-xf", tarPath, "-C", stagingDir]);
      const staged = path.join(stagingDir, HELPER_APP_BASENAME);
      chmodTree(staged);
      const verdict = inspectSignature(staged);
      console.log(`  signature: ${verdict.signature} (${verdict.detail})`);
      swapIntoPlace(staged, stagingDir, { sha256: sha256(tarPath), version: opts.version });
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    console.log(`installed ${helperAppPath()}`);
    return helperAppPath();
  });
}

/** The mode contract from design 3.3: 0700 directories, 0700 executables,
 *  0600 everything else. */
function chmodTree(root: string): void {
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) chmodTree(full);
    else fs.chmodSync(full, path.basename(root) === "MacOS" ? 0o700 : 0o600);
  }
}

// ----------------------------------------------------------------- status

/**
 * The helper's own grants, by one named route, with no window opened.
 *
 * `cast computer permissions` cannot be used for this twice over: it always goes
 * through `openPermissionSettings`, which puts System Settings and a helper
 * window on the human's screen whenever a grant is missing (ct-49667), and its
 * 5-second poll is shorter than the helper's own answer time (ct-49671).
 */
async function status(route: "disclaimed" | "open" = "disclaimed"): Promise<Record<string, string>> {
  return await probeHelperPermissions(route);
}

/** The third route, for the comparison only: a plain exec from this process,
 *  which is the one the design says can read the PARENT's context. */
function statusByDirectExec(): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-direct-"));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "status.json");
  try {
    spawnSync(helperExecutablePath(), ["--permission-status-file", file], { timeout: PROBE_SETTLE_MS });
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, string>;
    } catch {
      return { accessibility: "no-answer", screenshots: "no-answer" };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------- confirm: bundle swap

/**
 * Design 17.1. Replace the bundle's contents at the fixed path and show the
 * grant still reads granted.
 *
 * Two builds of the same source signed twice produce different bytes (the
 * signature carries a timestamp), so this is a genuine content swap with the
 * path, the bundle id and the signing identity all held constant — which is
 * exactly the shape of a codecast release update.
 */
async function confirmSwap(args: string[]): Promise<boolean> {
  console.log("-- confirm 1: the grant survives a content swap at the same path (design 17.1)\n");
  const before = await status();
  console.log(`  before: accessibility=${before.accessibility}, screenshots=${before.screenshots}`);
  if (before.accessibility !== "granted") {
    console.log("\n  SKIPPED - nothing is granted yet, so there is no grant to survive anything.");
    console.log("  Grant Accessibility to `codecast computer` in System Settings, then rerun.");
    return true;
  }
  const live = helperAppPath();
  const identityBefore = signingIdentity(live);
  const stampBefore = readInstallStamp();
  console.log(`  bundle: ${live}`);
  console.log(`  identity: ${identityBefore.identifier} / team ${identityBefore.team} / cdhash ${identityBefore.cdhash}`);

  const second = flag(args, "with") ?? build(["--out", path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-swap-")), "helper.tar")]).tar;
  if (sha256(second) === stampBefore?.sha256) fail("the second payload is byte-identical to the installed one, so nothing would be swapped");
  console.log(`\n  swapping in ${second} (sha256 ${sha256(second)})`);
  await install(second);

  const identityAfter = signingIdentity(helperAppPath());
  const after = await status();
  console.log(`\n  after:  accessibility=${after.accessibility}, screenshots=${after.screenshots}`);
  console.log(`  identity: ${identityAfter.identifier} / team ${identityAfter.team} / cdhash ${identityAfter.cdhash}`);

  const problems: string[] = [];
  if (helperAppPath() !== live) problems.push("the bundle path moved");
  if (identityAfter.cdhash === identityBefore.cdhash) problems.push("the bundle's contents did not actually change, so nothing was proven");
  if (identityAfter.identifier !== identityBefore.identifier) {
    problems.push(`the bundle identifier changed (${identityBefore.identifier} -> ${identityAfter.identifier})`);
  }
  if (identityAfter.team !== identityBefore.team) {
    problems.push(`the signing team changed (${identityBefore.team} -> ${identityAfter.team}) - a signing regression to fix, not a reason to reopen the fixed path`);
  }
  if (after.accessibility !== "granted") problems.push(`Accessibility now reads ${after.accessibility}`);
  if (before.screenshots === "granted" && after.screenshots !== "granted") problems.push(`Screen Recording now reads ${after.screenshots}`);

  if (problems.length === 0) {
    console.log("\n  PASS - new bytes at the same path, same identity, grant intact.");
    console.log("  Confirm by eye that System Settings shows one `codecast computer` row, not two.");
    return true;
  }
  for (const problem of problems) console.log(`\n  FAIL - ${problem}`);
  return false;
}

// ------------------------------------------------- confirm: probe route

/**
 * Design 3.4 / 17.2. Does the disclaimed spawn read the helper's own TCC state?
 *
 * The comparison is only meaningful on a machine where the helper is granted
 * and the process running this is not, so the script says when that precondition
 * is unmet rather than reporting a green that means nothing.
 */
async function confirmRoute(): Promise<boolean> {
  console.log("-- confirm 2: the disclaimed spawn reports the helper's own permission state (design 3.4)\n");
  const disclaimed = await status("disclaimed");
  const opened = await status("open");
  const direct = statusByDirectExec();
  const show = (name: string, r: Record<string, string>) =>
    console.log(`  ${name.padEnd(18)} accessibility=${r.accessibility}, screenshots=${r.screenshots}`);
  show("disclaimed spawn", disclaimed);
  show("open -n", opened);
  show("direct exec", direct);

  if (disclaimed.accessibility !== "granted" && opened.accessibility !== "granted") {
    console.log("\n  INCONCLUSIVE - the helper is not granted, so every route answers not-granted for the same reason.");
    console.log("  Grant Accessibility to `codecast computer` only (NOT to your terminal), then rerun.");
    return true;
  }
  if (disclaimed.accessibility === opened.accessibility && disclaimed.screenshots === opened.screenshots) {
    console.log("\n  PASS - both routes agree, so the disclaimed spawn is not inheriting. It stays the primary");
    console.log("  route for the helper socket and for the status probe. Record this on ct-49520.");
    return true;
  }
  console.log("\n  FAIL - the routes disagree. If the disclaimed route reads granted while `open -n` does not,");
  console.log("  inheritance is still happening and the STATUS PROBE alone moves to `open -n`");
  console.log("  (CODECAST_COMPUTER_PERMISSION_ROUTE=open); the socket helper stays on the disclaimed spawn.");
  return false;
}

// -------------------------------------------------------------------- cli

/**
 * Run the from-source CLI with a built payload staged into the tracked
 * placeholder, then truncate it again - the same contract
 * `build-with-native.ts` uses.
 *
 * Needed because `materializeHelperApp` reads only the EMBEDDED payload, so a
 * from-source `bun src/index.ts computer ...` can never reach a helper, even
 * when a valid one is already installed at the fixed path (ct-49672).
 */
function cli(tarPath: string, argv: string[]): number {
  if (!fs.existsSync(tarPath)) fail(`no such payload: ${tarPath}`);
  fs.copyFileSync(tarPath, COMPUTER_HELPER_PAYLOAD);
  try {
    return spawnSync(process.execPath, [path.join(CLI_ROOT, "src/index.ts"), ...argv], { stdio: "inherit" }).status ?? 1;
  } finally {
    fs.writeFileSync(COMPUTER_HELPER_PAYLOAD, "");
  }
}

// ------------------------------------------------------------------- main

const [verb = "confirm", ...rest] = process.argv.slice(2);
if (process.platform !== "darwin" && verb !== "help") fail("cast computer runs on macOS only");

switch (verb) {
  case "build":
    build(rest);
    break;
  case "install":
    await install(rest[0] ?? fail("usage: install <helper.tar>"), { version: flag(rest, "version") });
    break;
  case "status":
    console.log(JSON.stringify(await status(flag(rest, "route") as "open" | "disclaimed" | undefined), null, 2));
    break;
  case "cli": {
    const tar = flag(rest, "payload") ?? fail("usage: cli --payload <helper.tar> -- computer <verb> ...");
    const split = rest.indexOf("--");
    process.exit(cli(tar, split >= 0 ? rest.slice(split + 1) : []));
    break;
  }
  case "confirm-swap":
    process.exit((await confirmSwap(rest)) ? 0 : 1);
    break;
  case "confirm-route":
    process.exit((await confirmRoute()) ? 0 : 1);
    break;
  case "confirm": {
    const swap = await confirmSwap(rest);
    console.log("");
    const route = await confirmRoute();
    process.exit(swap && route ? 0 : 1);
    break;
  }
  default:
    console.log(`usage: bun scripts/computer-verify.ts <verb>

  confirm                       both confirm procedures (default)
  confirm-swap [--with <tar>]   design 17.1 - the grant survives a content swap
  confirm-route                 design 3.4  - the disclaimed spawn is not inheriting
  build [--out <tar>] [--stage <dir>] [--version <v>]
  install <helper.tar>
  status [--route disclaimed|open]
  cli --payload <helper.tar> -- computer <verb> ...
`);
    process.exit(verb === "help" ? 0 : 1);
}
