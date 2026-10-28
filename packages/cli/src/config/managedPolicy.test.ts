import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MANAGED_PREFS_ENV,
  applyManagedPolicy,
  effectivePolicy,
  lockedConfigKey,
  policyRefusal,
  policySnippetAvailability,
  POLICY_EXCLUDED_SESSION,
  isManagedExcludedPath,
  resetManagedPolicyCache,
  stripManagedPolicy,
  writeEffectivePolicyFile,
} from "./managedPolicy.js";
import { isPathExcluded } from "../syncScope.js";
import { isSessionRefusal } from "../retryQueue.js";
import { isCloudMirrorEnabled, type Config } from "./types.js";
import { ENROLL_SIGN_IN_COOLDOWN_MS, nextEnrollStep } from "../mdm.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-policy-"));
const saved = { prefs: process.env[MANAGED_PREFS_ENV], dir: process.env.CODECAST_DIR, home: process.env.HOME };
let n = 0;
let dir = "";
let profile = "";

const TEAM: Config["team_policy"] = {
  team_id: "t1",
  team_name: "Acme",
  enrolled: true,
  policy: { browser_control_disabled: true, excluded_paths: ["/srv/team-secret"], auto_update: "on" },
};

function writeProfile(body: unknown): void {
  fs.writeFileSync(profile, JSON.stringify(body));
}

function writeConfig(config: Config): void {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
}

beforeEach(() => {
  dir = path.join(root, `case-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  profile = path.join(dir, "managed.json");
  process.env[MANAGED_PREFS_ENV] = profile;
  process.env.CODECAST_DIR = dir;
  process.env.HOME = path.join(dir, "home");
  resetManagedPolicyCache();
});

afterEach(() => {
  for (const [k, v] of [[MANAGED_PREFS_ENV, saved.prefs], ["CODECAST_DIR", saved.dir], ["HOME", saved.home]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("no profile and no team policy: nothing is managed", () => {
  expect(effectivePolicy({})).toEqual({ values: {}, sources: {} });
  expect(policyRefusal("browser_control_disabled", {})).toBeNull();
});

test("profile and team policy merge, profile first, and each value names its source", () => {
  writeProfile({ PublicSharingDisabled: true, AutoUpdate: false, ExcludedPaths: ["~/clients"], ServerURL: "https://convex.acme.test" });
  const eff = effectivePolicy({ team_policy: TEAM });
  expect(eff.values).toEqual({
    public_sharing_disabled: true,
    browser_control_disabled: true,
    auto_update: "off",
    excluded_paths: ["~/clients", "/srv/team-secret"],
    convex_url: "https://convex.acme.test",
  });
  expect(eff.sources.auto_update).toEqual({ kind: "profile" });
  expect(eff.sources.browser_control_disabled).toEqual({ kind: "team", team_id: "t1", team_name: "Acme" });
  expect(policyRefusal("browser_control_disabled", { team_policy: TEAM })).toBe("Agent browser control is turned off by Acme's admins.");
  expect(policyRefusal("public_sharing_disabled", {})).toBe("Public sharing is turned off by your device's management profile.");
});

test("the team half comes from config.json when no config is passed", () => {
  writeConfig({ team_policy: TEAM });
  expect(policyRefusal("browser_control_disabled")).toContain("Acme");
});

test("the profile is parsed once per file change", () => {
  const then = new Date("2026-10-01T00:00:00Z");
  writeProfile({ BrowserControlDisabled: true });
  fs.utimesSync(profile, then, then);
  expect(policyRefusal("browser_control_disabled", {})).not.toBeNull();
  // Same size and mtime: the cached parse answers, the file is not read again.
  fs.writeFileSync(profile, JSON.stringify({ BrowserControlDisabled: 1 }).padEnd(fs.statSync(profile).size));
  fs.utimesSync(profile, then, then);
  expect(policyRefusal("browser_control_disabled", {})).not.toBeNull();
  // A real change moves the stamp.
  writeProfile({ BrowserControlDisabled: false });
  expect(policyRefusal("browser_control_disabled", {})).toBeNull();
  fs.rmSync(profile);
  expect(effectivePolicy({}).values).toEqual({});
});

test.skipIf(process.platform !== "darwin")("a plist profile reads through plutil, even beside values JSON cannot hold", () => {
  const plist = path.join(dir, "sh.codecast.plist");
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>ComputerControlDisabled</key><true/>
  <key>ExcludedPaths</key><array><string>/Volumes/Clients</string></array>
  <key>PayloadInstalled</key><date>2026-10-26T10:00:00Z</date>
</dict></plist>`);
  process.env[MANAGED_PREFS_ENV] = plist;
  expect(effectivePolicy({}).values).toEqual({ computer_control_disabled: true, excluded_paths: ["/Volumes/Clients"] });
}, 30_000);

test("the overlay shows managed values to readers and never reaches config.json", () => {
  writeProfile({ ServerURL: "https://convex.acme.test", ExcludedPaths: ["~/clients"], CloudHostsDisabled: true });
  const raw: Config = { convex_url: "https://convex.codecast.sh", excluded_paths: "/tmp/mine", auto_update: false, team_policy: TEAM };
  const read = applyManagedPolicy(structuredClone(raw));
  expect(read.convex_url).toBe("https://convex.acme.test");
  expect(read.auto_update).toBe(true);
  expect(read.desktop_auto_update).toBe(true);
  expect(read.excluded_paths).toBe(`/tmp/mine,${path.join(process.env.HOME!, "clients")},/srv/team-secret`);
  expect(isCloudMirrorEnabled(read)).toBe(false);

  // A read-modify-write that touched something else writes the file back as it was.
  read.team_id = "t2";
  expect(stripManagedPolicy(read)).toEqual({ ...raw, team_id: "t2" });
  // A person's own excluded path survives; the managed ones are dropped from the write.
  read.excluded_paths += ",/tmp/also";
  expect(stripManagedPolicy(read).excluded_paths).toBe("/tmp/mine,/tmp/also");
});

test("a locked key refuses the write and says who manages it", () => {
  writeProfile({ WebURL: "https://codecast.acme.test" });
  const eff = effectivePolicy({ team_policy: TEAM });
  expect(lockedConfigKey("web_url", eff)?.message).toBe("Web URL is set by your device's management profile.");
  expect(lockedConfigKey("auto_update", eff)?.source).toEqual({ kind: "team", team_id: "t1", team_name: "Acme" });
  expect(lockedConfigKey("convex_url", eff)).toBeNull();
  expect(lockedConfigKey("excluded_paths", eff)).toBeNull();
  expect(lockedConfigKey("cloud_mirror_enabled", eff)).toBeNull();
});

test("policy folders are excluded with ~ expanded, whatever the person's own list says", () => {
  writeProfile({ ExcludedPaths: ["~/clients"] });
  const home = process.env.HOME!;
  expect(isPathExcluded(path.join(home, "clients"))).toBe(true);
  expect(isPathExcluded(path.join(home, "clients", "acme"), "")).toBe(true);
  expect(isPathExcluded(path.join(home, "clients-two"))).toBe(false);
  expect(isPathExcluded(path.join(home, "src"), "/tmp/other")).toBe(false);
  writeConfig({ team_policy: TEAM });
  expect(isPathExcluded("/srv/team-secret/app")).toBe(true);
  expect(isManagedExcludedPath("/srv/team-secret/app")).toBe(true);
  expect(isManagedExcludedPath("/srv/team-secret-two")).toBe(false);
  // The create backstop's error is a refusal for good, not a retry.
  expect(isSessionRefusal(`Error: ${POLICY_EXCLUDED_SESSION}`)).toBe(true);
});

test("snippets follow their restriction off, and back on only when the policy turned them off", () => {
  const on = effectivePolicy({ team_policy: TEAM });
  expect(policySnippetAvailability(on, {})).toEqual({ browser: false });
  const off = effectivePolicy({});
  expect(policySnippetAvailability(off, { browser: false, chat: false })).toEqual({ browser: true });
  expect(policySnippetAvailability(off, {})).toEqual({});
});

test("the desktop app's file holds the effective policy without the enrollment token", () => {
  writeProfile({ AutoUpdate: false, EnrollmentToken: "cc_enr_0123456789abcdefghij" });
  expect(writeEffectivePolicyFile()).toBe(true);
  expect(writeEffectivePolicyFile()).toBe(false);
  const file = JSON.parse(fs.readFileSync(path.join(dir, "managed-policy.json"), "utf-8"));
  expect(file).toEqual({ values: { auto_update: "off" }, sources: { auto_update: { kind: "profile" } } });
});

test("enroll is a no-op once enrolled and signed in", () => {
  const token = "cc_enr_0123456789abcdefghij";
  expect(nextEnrollStep({}, {})).toEqual({ kind: "unmanaged" });
  expect(nextEnrollStep({}, { enrollment_token: "nope" })).toEqual({ kind: "invalid_token" });
  expect(nextEnrollStep({}, { enrollment_token: token })).toEqual({ kind: "enroll", token, signIn: true });
  const signedIn: Config = { auth_token: "x", user_id: "u" };
  expect(nextEnrollStep(signedIn, { enrollment_token: token })).toEqual({ kind: "enroll", token, signIn: false });
  const enrolled = { ...signedIn, managed_enrollment: { enrollment_id: "e", team_id: "t", team_name: "Acme", token_prefix: token.slice(0, 16), at: "" } };
  expect(nextEnrollStep(enrolled, { enrollment_token: token })).toEqual({ kind: "done" });
  // A sign-in page already opened is left to the person until the cooldown ends.
  const asked = { managed_enrollment: { ...enrolled.managed_enrollment, sign_in_at: "2026-10-26T10:00:00Z" } };
  const at = Date.parse("2026-10-26T10:00:00Z");
  expect(nextEnrollStep(asked, { enrollment_token: token }, at + 60_000)).toEqual({ kind: "waiting" });
  expect(nextEnrollStep(asked, { enrollment_token: token }, at + 60_000, true).kind).toBe("enroll");
  expect(nextEnrollStep(asked, { enrollment_token: token }, at + ENROLL_SIGN_IN_COOLDOWN_MS + 1)).toEqual({ kind: "enroll", token, signIn: true });
  // A rotated token enrolls again.
  expect(nextEnrollStep(enrolled, { enrollment_token: "cc_enr_ffffffffffffffffffff" }).kind).toBe("enroll");
});

test("cast mdm status --json reports a fixture profile", () => {
  writeProfile({ BrowserControlDisabled: true, EnrollmentToken: "cc_enr_0123456789abcdefghij" });
  writeConfig({ team_policy: TEAM });
  const res = spawnSync(process.execPath, [path.join(import.meta.dir, "..", "index.ts"), "mdm", "status", "--json"], {
    encoding: "utf-8",
    env: { ...process.env, CODECAST_NO_AUTO_UPDATE: "1", NO_COLOR: "1" },
    timeout: 60_000,
  });
  expect(res.status).toBe(0);
  const status = JSON.parse(res.stdout.slice(res.stdout.indexOf("{")));
  expect(status.profile).toEqual({ paths: [{ path: profile, installed: true }], installed: true });
  expect(status.team).toEqual({ team_id: "t1", team_name: "Acme", enrolled: true });
  expect(status.signed_in).toBe(false);
  expect(status.managed_install).toBe(false);
  expect(status.policy).toContainEqual({ key: "browser_control_disabled", name: "Block agent browser control", value: true, source: "device profile" });
  expect(status.policy).toContainEqual({ key: "enrollment_token", name: "Enrollment token", value: "(set)", source: "device profile" });
  expect(status.policy).toContainEqual({ key: "excluded_paths", name: "Never sync these folders", value: ["/srv/team-secret"], source: "team Acme" });
}, 70_000);
