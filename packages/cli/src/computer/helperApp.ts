/**
 * The signed helper app, materialized at ONE path that never moves.
 *
 * macOS keys a TCC grant to the resolved path AND the code-signing designated
 * requirement, together — the lesson `stableClaudeBinary.ts` and
 * `scripts/build-binaries.sh` were both written for. So the bundle this module
 * writes lives at `~/.codecast/computer/codecast computer.app` forever: no
 * version, no content hash, no channel in the path. The human grants
 * Accessibility and Screen Recording once, to `sh.codecast.computer`, and the
 * grant survives every codecast release.
 *
 * That is why this is NOT `browser/appIdentity.ts`'s content-hashed directory,
 * which is right for the icon helper (no TCC grant at all) and wrong here. The
 * content hash still exists — as an install STAMP, never as a path component.
 *
 * Updating therefore means replacing the bundle's contents in place, which is
 * two renames: live → old/<uuid>, staged → live. Both are within one
 * filesystem, so each is atomic, but the window BETWEEN them is a real crash
 * site: a kill there leaves no bundle at the fixed path at all. A journal
 * written before the first rename makes that window repairable, and
 * `repairHalfSwap` runs at the start of every materialization.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "../proc.js";
import { acquireFileLock } from "../lockFile.js";
import { ComputerError } from "./errors.js";
import { computerHelperTar } from "./helperPayload.js";

/** The one path, forever. A test asserts this string; a future refactor that
 *  templates a version or a hash into it fails there rather than silently
 *  costing every user a regrant. */
export const HELPER_APP_BASENAME = "codecast computer.app";
export const HELPER_EXECUTABLE_NAME = "codecast-computer";
export const HELPER_BUNDLE_ID = "sh.codecast.computer";

export function computerHome(): string {
  const root = process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast");
  return path.join(root, "computer");
}

export function helperAppPath(): string {
  return path.join(computerHome(), HELPER_APP_BASENAME);
}

export function helperExecutablePath(appPath = helperAppPath()): string {
  return path.join(appPath, "Contents", "MacOS", HELPER_EXECUTABLE_NAME);
}

function stampPath(): string {
  return path.join(computerHome(), "installed.json");
}

function journalPath(): string {
  return path.join(computerHome(), "swap.json");
}

export interface InstallStamp {
  sha256: string;
  version: string;
  installedAt: number;
}

export function readInstallStamp(): InstallStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath(), "utf-8")) as Partial<InstallStamp>;
    if (typeof parsed.sha256 !== "string" || !parsed.sha256) return null;
    return {
      sha256: parsed.sha256,
      version: typeof parsed.version === "string" ? parsed.version : "",
      installedAt: typeof parsed.installedAt === "number" ? parsed.installedAt : 0,
    };
  } catch {
    return null;
  }
}

function looksLikeBundle(appPath: string): boolean {
  try {
    return fs.statSync(helperExecutablePath(appPath)).isFile();
  } catch {
    return false;
  }
}

/** Every codecast process that swaps or launches the bundle holds this, so no
 *  process can observe the fixed path missing or half-populated. It is taken
 *  exclusively rather than shared: `flock` needs FFI, launches already
 *  serialize on their own start lock, and exclusive is a superset of the
 *  guarantee the design asks for. */
export async function withPrepareLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const release = await acquireFileLock(path.join(computerHome(), "prepare.lock"), {
    waitMs: 120_000,
    describe: "cast computer",
  });
  try {
    return await fn();
  } finally {
    release();
  }
}

type SwapJournal = { stagingDir: string; stagedApp: string; oldApp: string; pid: number; startedAt: number };

function readJournal(): SwapJournal | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath(), "utf-8")) as Partial<SwapJournal>;
    if (typeof parsed.stagedApp !== "string" || typeof parsed.oldApp !== "string") return null;
    return {
      stagingDir: typeof parsed.stagingDir === "string" ? parsed.stagingDir : path.dirname(parsed.stagedApp),
      stagedApp: parsed.stagedApp,
      oldApp: parsed.oldApp,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

function rmQuiet(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export type RepairOutcome = "none" | "completed" | "rolled-back" | "abandoned";

/**
 * Repair a bundle swap that was killed between its two renames.
 *
 * Four states, and each has one right answer:
 *  - no journal: nothing was in flight.
 *  - journal and a bundle at the fixed path: the second rename landed and the
 *    kill came after it. Drop the journal; a stamp that never got written just
 *    makes the next materialization redo the swap, which is correct.
 *  - journal, nothing at the fixed path, a complete staged bundle: finish the
 *    swap forward. The staged copy is the one that already passed verification.
 *  - journal, nothing at the fixed path, no usable staged bundle: put the old
 *    bundle back and drop the stamp, so the next run materializes again.
 *
 * Rolling forward beats rolling back because the staged copy is verified;
 * rolling back beats leaving the user with no helper at all. Callers hold the
 * prepare lock.
 */
export function repairHalfSwap(): RepairOutcome {
  const journal = readJournal();
  if (!journal) return "none";
  const live = helperAppPath();
  const finish = (outcome: RepairOutcome) => {
    rmQuiet(journalPath());
    rmQuiet(journal.stagingDir);
    return outcome;
  };
  if (fs.existsSync(live)) return finish("completed");
  if (looksLikeBundle(journal.stagedApp)) {
    fs.renameSync(journal.stagedApp, live);
    // The stamp is deliberately NOT written here: this process never saw the
    // payload that produced the staged bundle, so it cannot claim a hash for
    // it. A missing stamp costs one extra materialization, a wrong stamp costs
    // a wrong bundle forever.
    rmQuiet(stampPath());
    return finish("completed");
  }
  if (looksLikeBundle(journal.oldApp)) {
    fs.renameSync(journal.oldApp, live);
    rmQuiet(stampPath());
    return finish("rolled-back");
  }
  rmQuiet(stampPath());
  return finish("abandoned");
}

export type HelperSignature = "developer-id" | "adhoc" | "invalid";

/**
 * Grade `spctl --assess`'s verdict on the helper bundle.
 *
 * Measured on 2026-09-07 (ct-49524): a bundle signed with codecast's Developer
 * ID certificate but NOT notarized is rejected, exit 3, `source=Unnotarized
 * Developer ID`. codecast notarizes nothing — not the CLI binaries, not this
 * helper — so failing on any rejection would fail every release and tell every
 * user their correctly signed helper is broken.
 *
 * Notarization is the rule Gatekeeper applies to something a human opens from a
 * quarantined download. This bundle is written by codecast itself, carries no
 * quarantine attribute and is started by exec, so that rule never gates it, and
 * `codesign --verify --strict` plus the Developer ID leaf is the property that
 * actually matters. The rest of spctl's verdict is still worth having: a
 * revoked, damaged or foreign signature reports a different source, and that is
 * a real failure.
 */
export function gradeAssessment(status: number | null, output: string): { ok: boolean; reason: string } {
  if (status === 0) return { ok: true, reason: "accepted" };
  const unnotarized = /^source=Unnotarized Developer ID$/m.test(output);
  const ours = /^origin=Developer ID Application:/m.test(output);
  if (unnotarized && ours) return { ok: true, reason: "Developer ID signed, not notarized" };
  return { ok: false, reason: output.trim() || "spctl --assess failed" };
}

/** codesign's own verdict on a bundle. `adhoc` is a from-source build: it
 *  works, and its TCC grant resets on every rebuild, which is what `cast
 *  doctor` warns about rather than treating as fine. */
export function inspectSignature(appPath: string): { signature: HelperSignature; detail: string; authority: string } {
  const verify = spawnSync("/usr/bin/codesign", ["--verify", "--strict", appPath], { encoding: "utf8", timeout: 60_000 });
  if (verify.status !== 0) {
    return { signature: "invalid", detail: (verify.stderr || verify.stdout || "codesign --verify failed").trim(), authority: "" };
  }
  const info = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8", timeout: 60_000 });
  const text = `${info.stderr ?? ""}${info.stdout ?? ""}`;
  // The leaf certificate, which is the half of the TCC key that a signing
  // identity change resets. `cast doctor` names it so a human can tell a
  // release helper from a from-source one at a glance (ct-49524).
  const authority = text.split("\n").find((line) => line.startsWith("Authority="))?.slice("Authority=".length).trim() ?? "";
  if (/Signature\s*=\s*adhoc/i.test(text)) return { signature: "adhoc", detail: "ad-hoc signed", authority: "ad-hoc" };
  // -vv: the grader reads `source=` and `origin=`, which spctl prints only when
  // asked to be verbose.
  const assess = spawnSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", appPath], { encoding: "utf8", timeout: 60_000 });
  const graded = gradeAssessment(assess.status, `${assess.stdout ?? ""}${assess.stderr ?? ""}`);
  if (!graded.ok) return { signature: "invalid", detail: graded.reason, authority };
  return { signature: "developer-id", detail: "Developer ID signed", authority };
}

function chmodTree(root: string): void {
  const walk = (dir: string) => {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else fs.chmodSync(full, path.basename(dir) === "MacOS" ? 0o700 : 0o600);
    }
  };
  walk(root);
}

export interface SwapOptions {
  /** Hash of the payload the staged bundle came from, for the install stamp. */
  sha256: string;
  version?: string;
  /**
   * Test seam: throwing here reproduces a kill in the window between the two
   * renames, which is the only moment the fixed path holds no bundle. It has
   * no production caller — the window is real, so the repair that closes it
   * has to be exercised against the real swap rather than a re-creation of it.
   */
  betweenRenames?: () => void;
}

/**
 * The two-rename swap, with the journal that makes its window repairable.
 *
 * Order matters: the journal is written BEFORE the first rename, so a kill at
 * any point after it leaves a record naming both halves. Renaming (rather than
 * deleting) the live bundle is what lets a helper from the previous release
 * keep running off its own bytes.
 */
export function swapIntoPlace(stagedApp: string, stagingDir: string, opts: SwapOptions): void {
  const root = computerHome();
  const live = helperAppPath();
  const oldDir = path.join(root, "old");
  fs.mkdirSync(oldDir, { recursive: true, mode: 0o700 });
  const oldApp = path.join(oldDir, randomUUID());
  const journal: SwapJournal = { stagingDir, stagedApp, oldApp, pid: process.pid, startedAt: Date.now() };
  fs.writeFileSync(journalPath(), JSON.stringify(journal), { mode: 0o600 });
  if (fs.existsSync(live)) fs.renameSync(live, oldApp);
  opts.betweenRenames?.();
  fs.renameSync(stagedApp, live);
  fs.writeFileSync(stampPath(), JSON.stringify({ sha256: opts.sha256, version: opts.version ?? "", installedAt: Date.now() }), { mode: 0o600 });
  rmQuiet(journalPath());
}

export interface MaterializeResult {
  appPath: string;
  executablePath: string;
  /** A swap ran (a first install or an update), rather than the stamp
   *  matching and the whole thing costing one small read. */
  installed: boolean;
  /** The bundle came from the fixed path rather than from this CLI's payload,
   *  because this CLI carries none. The launcher uses it to drop the
   *  providerVersion expectation: a CLI that cannot produce a helper has no
   *  release identity to hold the installed one to. */
  adopted: boolean;
}

/**
 * Put the embedded helper at the fixed path, replacing whatever is there when
 * the payload changed. Callers hold the prepare lock.
 */
export function materializeHelperApp(opts: { version?: string } = {}): MaterializeResult {
  if (process.platform !== "darwin") {
    throw new ComputerError("unsupported_capability", "cast computer runs on macOS only");
  }
  const payload = computerHelperTar();
  if (!payload) {
    // Why: this used to throw before it ever looked at the fixed path, so a
    // machine with a valid, signed and already GRANTED helper installed could
    // not run one verb from a CLI built from source — and the granted half of
    // the CLI's own end to end suite could not run at all, because staging
    // bytes into a tracked file was the only way in (ct-49672). There is
    // nothing to install here, but there may well be something to use.
    const adopted = adoptInstalledHelper();
    if (adopted) return adopted;
    throw new ComputerError(
      "accessibility_error",
      "the codecast computer helper is not built into this CLI, and none is installed — install a macOS release build of codecast",
    );
  }
  const root = computerHome();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  repairHalfSwap();

  const live = helperAppPath();
  const hash = createHash("sha256").update(payload).digest("hex");
  const stamp = readInstallStamp();
  if (stamp?.sha256 === hash && looksLikeBundle(live)) {
    return { appPath: live, executablePath: helperExecutablePath(live), installed: false, adopted: false };
  }

  const stagingDir = path.join(root, `.staging-${randomUUID()}`);
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  try {
    const tarPath = path.join(stagingDir, "helper.tar");
    fs.writeFileSync(tarPath, payload, { mode: 0o600 });
    const extract = spawnSync("/usr/bin/tar", ["-xf", tarPath, "-C", stagingDir], { encoding: "utf8", timeout: 120_000 });
    if (extract.status !== 0) {
      throw new ComputerError("accessibility_error", `could not unpack the computer helper: ${(extract.stderr || "tar failed").trim()}`);
    }
    fs.rmSync(tarPath, { force: true });
    const stagedApp = path.join(stagingDir, HELPER_APP_BASENAME);
    if (!looksLikeBundle(stagedApp)) {
      throw new ComputerError("accessibility_error", `the embedded computer helper does not contain ${HELPER_APP_BASENAME}/Contents/MacOS/${HELPER_EXECUTABLE_NAME}`);
    }
    chmodTree(stagedApp);

    // Verify the STAGED copy, before the swap. A verified old helper is
    // strictly better than an unverified new one, so a failure here aborts and
    // leaves the previous bundle in place.
    const verdict = inspectSignature(stagedApp);
    if (verdict.signature === "invalid") {
      throw new ComputerError("accessibility_error", `the computer helper failed signature verification (${verdict.detail}); reinstall codecast`);
    }
    swapIntoPlace(stagedApp, stagingDir, { sha256: hash, version: opts.version });
  } finally {
    rmQuiet(stagingDir);
  }
  sweepOldBundles();
  return { appPath: live, executablePath: helperExecutablePath(live), installed: true, adopted: false };
}

/**
 * Use the bundle already at the fixed path, for a CLI that carries no payload.
 *
 * The install stamp is what decides whether the signature is re-checked. A
 * stamp is the record that some codecast release extracted this bundle,
 * verified it and swapped it in, so re-running codesign and spctl on every verb
 * would buy nothing and cost a spawn each time. Without a stamp the bundle was
 * put there by hand — which is exactly what the end to end tests do — and it
 * gets the same verification a staged bundle gets before a swap, because
 * launching a bundle codesign rejects is the thing that check exists to stop.
 */
function adoptInstalledHelper(): MaterializeResult | null {
  const root = computerHome();
  if (!fs.existsSync(root)) return null;
  repairHalfSwap();
  const live = helperAppPath();
  if (!looksLikeBundle(live)) return null;
  if (!readInstallStamp()) {
    const verdict = inspectSignature(live);
    if (verdict.signature === "invalid") {
      throw new ComputerError(
        "accessibility_error",
        `the installed computer helper failed signature verification (${verdict.detail}); reinstall codecast`,
      );
    }
  }
  return { appPath: live, executablePath: helperExecutablePath(live), installed: false, adopted: true };
}

/**
 * Remove displaced bundles once no helper is running at all.
 *
 * A helper launched from the previous release can still be alive on its idle
 * timer, and unlinking a running executable's bytes is how you get a page-in
 * fault. Which `old/` directory that helper runs from cannot be read from its
 * command line — the argv it was launched with names the FIXED path, and the
 * rename happened afterwards — so the question this can actually answer is
 * "is any helper alive", and that is the one it asks.
 *
 * It fails OPEN, the way `browser-icon.m:22` does: a live helper, or a probe
 * that errored, keeps every directory. Leaving a stale directory on disk is
 * cheap; killing a live helper is not.
 */
export function sweepOldBundles(helperAlive: () => boolean = anyHelperRunning): void {
  const oldDir = path.join(computerHome(), "old");
  let entries: string[];
  try {
    entries = fs.readdirSync(oldDir);
  } catch {
    return;
  }
  if (entries.length === 0 || helperAlive()) return;
  for (const entry of entries) rmQuiet(path.join(oldDir, entry));
}

/** True unless pgrep positively reports no helper. Exit status 1 is "nothing
 *  matched" and is the ONLY answer that proves the field is clear; 0 means one
 *  is running, and anything else means the probe itself failed, which reads as
 *  "assume one is". */
function anyHelperRunning(): boolean {
  const probe = spawnSync("/usr/bin/pgrep", ["-f", "--", `${HELPER_EXECUTABLE_NAME} --agent`], { encoding: "utf8", timeout: 10_000 });
  return probe.status !== 1;
}

export interface HelperAvailability {
  /** The build carries an embedded payload at all. */
  embedded: boolean;
  /** A bundle exists at the fixed path. */
  materialized: boolean;
  appPath: string;
  /**
   * The bundle RESOLVES to the fixed path — no symlink pointing somewhere
   * versioned. TCC keys the grant to the resolved path, so a redirect here is
   * the same failure as a hashed directory: every update reads as a new app.
   */
  atFixedPath: boolean;
  signature: HelperSignature | null;
  signatureDetail: string;
  /** The leaf certificate the materialized bundle is signed by, e.g.
   *  `Developer ID Application: …` or `ad-hoc`. Empty when unreadable. */
  authority: string;
  /** CLI version recorded by the install stamp — which helper is on disk. It
   *  lags this CLI between an update and the next `cast computer` run, and
   *  `cast doctor` says so rather than looking wrong. */
  installedVersion: string | null;
  /** A bundle swap was interrupted and has not been repaired yet. Reported
   *  rather than fixed here: reading the state must not move files. */
  pendingSwap: boolean;
}

/** What `cast doctor` needs, without materializing anything. */
export function helperAvailability(): HelperAvailability {
  const appPath = helperAppPath();
  const materialized = looksLikeBundle(appPath);
  // Resolve the parent separately: `~/.codecast` itself is often a symlink
  // into a dotfiles repo, and that is fine — what must not happen is the
  // BUNDLE resolving somewhere else.
  let atFixedPath = true;
  if (materialized) {
    try {
      atFixedPath = fs.realpathSync(appPath) === path.join(fs.realpathSync(computerHome()), HELPER_APP_BASENAME);
    } catch {
      atFixedPath = false;
    }
  }
  const verdict = materialized && process.platform === "darwin" ? inspectSignature(appPath) : null;
  return {
    embedded: computerHelperTar() !== null,
    materialized,
    appPath,
    atFixedPath,
    pendingSwap: readJournal() !== null,
    signature: verdict?.signature ?? null,
    signatureDetail: verdict?.detail ?? "",
    authority: verdict?.authority ?? "",
    installedVersion: readInstallStamp()?.version ?? null,
  };
}
