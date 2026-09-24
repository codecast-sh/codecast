import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { macosMeetsMinimum, shouldApplyWhileRunning, shouldAttemptDesktopUpdate, stagingPaths, swapInBundle, waitForAppSwap, wantsReinstall } from "./desktopUpdate";

// Gate at the very top of checkForDesktopUpdate. The dev-mode skip exists so a
// developer's source checkout (cast/daemon under `bun src/…`) doesn't auto-swap
// the installed app — but an explicit force must still work from a dev env,
// otherwise a dev machine can never update at all (the bug that left the in-app
// banner stuck on "Updating…" forever).
describe("shouldAttemptDesktopUpdate", () => {
  it("only runs on macOS", () => {
    expect(shouldAttemptDesktopUpdate("linux", false, false)).toBe(false);
    expect(shouldAttemptDesktopUpdate("win32", false, true)).toBe(false);
    expect(shouldAttemptDesktopUpdate("darwin", false, false)).toBe(true);
  });

  it("skips automatic checks in dev mode", () => {
    expect(shouldAttemptDesktopUpdate("darwin", true, false)).toBe(false);
  });

  it("an explicit force runs even in dev mode (the unblock)", () => {
    expect(shouldAttemptDesktopUpdate("darwin", true, true)).toBe(true);
  });

  it("runs normally when not in dev mode", () => {
    expect(shouldAttemptDesktopUpdate("darwin", false, true)).toBe(true);
    expect(shouldAttemptDesktopUpdate("darwin", false, false)).toBe(true);
  });
});

// The trigger that makes the rollout reach always-open clients: when the
// installed app is below the server-pinned floor, the daemon applies WHILE the
// app is running instead of deferring forever. The apply mechanism itself
// (quit + swap + relaunch) is the existing `--force` path; this guards only the
// decision.
describe("shouldApplyWhileRunning", () => {
  it("never applies while running without force or a floor", () => {
    expect(shouldApplyWhileRunning("1.1.76", {})).toBe(false);
    expect(shouldApplyWhileRunning("1.1.76", { minVersion: null })).toBe(false);
    expect(shouldApplyWhileRunning("1.1.76", { minVersion: undefined })).toBe(false);
  });

  it("manual --force always applies, regardless of versions", () => {
    expect(shouldApplyWhileRunning("9.9.9", { force: true })).toBe(true);
    expect(shouldApplyWhileRunning("1.1.76", { force: true, minVersion: "1.1.78" })).toBe(true);
  });

  it("applies when the installed app is below the pinned floor", () => {
    expect(shouldApplyWhileRunning("1.1.76", { minVersion: "1.1.78" })).toBe(true);
    expect(shouldApplyWhileRunning("1.0.99", { minVersion: "1.1.0" })).toBe(true);
  });

  it("does NOT apply once at or above the floor (no relaunch loop)", () => {
    expect(shouldApplyWhileRunning("1.1.78", { minVersion: "1.1.78" })).toBe(false);
    expect(shouldApplyWhileRunning("1.2.0", { minVersion: "1.1.78" })).toBe(false);
  });
});

// The swap replaces the working app, so a build this Mac cannot open must never
// be installed: Electron 44 needs macOS 13, and a Mac on 12 keeps what it has.
describe("macosMeetsMinimum", () => {
  it("refuses a bundle that needs a newer macOS", () => {
    expect(macosMeetsMinimum("12.7.6", "13.0")).toBe(false);
  });

  it("installs on the minimum and above, whatever the precision", () => {
    expect(macosMeetsMinimum("13.0", "13.0")).toBe(true);
    expect(macosMeetsMinimum("13", "13.0")).toBe(true);
    expect(macosMeetsMinimum("26.2", "13.0")).toBe(true);
  });

  it("installs when either version is unknown, as every earlier release did", () => {
    expect(macosMeetsMinimum(null, "13.0")).toBe(true);
    expect(macosMeetsMinimum("12.7", null)).toBe(true);
  });
});

// A forced run reinstalls a current app only when the caller meant a fresh
// copy. The web's below-floor gate broadcasts one forced command to every
// daemon of the user, so a Mac that is already current must be left alone.
describe("wantsReinstall", () => {
  it("cast desktop-update --force reinstalls", () => {
    expect(wantsReinstall({ force: true })).toBe(true);
  });

  it("the daemon command from the web never reinstalls a current app", () => {
    expect(wantsReinstall({ force: true, reinstall: false })).toBe(false);
  });

  it("a routine run never reinstalls", () => {
    expect(wantsReinstall({})).toBe(false);
    expect(wantsReinstall({ reinstall: true })).toBe(false);
  });
});

// The app's quit helper (electron main.js spawnUpdateSwap) and the daemon's
// forced swap both run the moment the app exits. They shared one staging
// folder, and a helper rename during the daemon's copy installed a half-copied
// bundle: "Codecast is damaged" (2026-09-24).
describe("swap beside the app's own quit helper", () => {
  const bundle = (dir: string, name: string, tag: string) => {
    const app = path.join(dir, name);
    for (let i = 0; i < 400; i++) {
      const f = path.join(app, "Contents", "Resources", `f${i % 20}`, `file${i}.txt`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `${tag}:${i}:`.padEnd(4096, "x"));
    }
    return app;
  };
  const complete = (app: string, tag: string) => {
    for (let i = 0; i < 400; i++) {
      const f = path.join(app, "Contents", "Resources", `f${i % 20}`, `file${i}.txt`);
      if (!fs.existsSync(f) || !fs.readFileSync(f, "utf8").startsWith(`${tag}:${i}:`)) return false;
    }
    return true;
  };
  // The helper script from main.js, verbatim apart from its pid wait.
  const appHelper = (appPath: string, delayS: number) => {
    const { appIncoming, appOld } = stagingPaths(appPath);
    const q = (p: string) => `'${p}'`;
    const script = [`sleep ${delayS}`, `rm -rf ${q(appOld)}`,
      `mv ${q(appPath)} ${q(appOld)} && mv ${q(appIncoming)} ${q(appPath)} || { mv ${q(appOld)} ${q(appPath)} 2>/dev/null; exit 1; }`,
      `rm -rf ${q(appOld)}`].join("\n");
    return new Promise<void>((resolve) => spawn("/bin/sh", ["-c", script], { stdio: "ignore" }).on("exit", () => resolve()));
  };

  it("stages under names the app's updater never uses", () => {
    const p = stagingPaths("/Applications/Codecast.app");
    expect(new Set([p.incoming, p.old, p.appIncoming, p.appOld]).size).toBe(4);
  });

  it.if(process.platform === "darwin")("ends with a whole bundle whenever the helper lands", async () => {
    for (const delay of [0, 0.05, 0.15, 0.3]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-swap-"));
      const appPath = bundle(dir, "Codecast.app", "old");
      bundle(dir, ".Codecast.app.incoming", "new"); // the app staged it
      const fresh = bundle(dir, "fresh.app", "new"); // the daemon's verified copy
      const helper = appHelper(appPath, delay);
      await waitForAppSwap(appPath, { pollMs: 20 });
      if (!complete(appPath, "new")) swapInBundle(fresh, appPath);
      await helper;
      expect(complete(appPath, "new")).toBe(true);
      expect(fs.readdirSync(dir).sort()).toEqual(["Codecast.app", "fresh.app"]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("clears a staged bundle no helper will ever move", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-swap-"));
    const appPath = bundle(dir, "Codecast.app", "old");
    bundle(dir, ".Codecast.app.incoming", "new");
    expect(await waitForAppSwap(appPath, { timeoutMs: 100, pollMs: 20 })).toBe(false);
    expect(fs.existsSync(stagingPaths(appPath).appIncoming)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
