import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appDeepLink,
  appInstallLine,
  declaredApp,
  desktopAppPaths,
  desktopUserDataDir,
  formatInstalledApps,
  missingDesktopMessage,
  openerCommand,
  parseInstalledApps,
  parsePageTarget,
  runPublishApps,
  runPublishInstall,
  runPublishUninstall,
  type AppsEnv,
  type OpenerCommand,
} from "./publishApps";
import { buildPublishPayload, printPublishResult } from "./publish";

const SITE = "https://codecast.sh";

describe("parsePageTarget", () => {
  it("reads a bare slug", () => {
    expect(parsePageTarget("k3j2h4")).toEqual({ slug: "k3j2h4", gate: {} });
  });
  it("reads both URL shapes and keeps only gate keys", () => {
    expect(parsePageTarget("https://codecast.sh/a/k3j2h4?k=abc&m=tok&live=1#o=owner")).toEqual({ slug: "k3j2h4", gate: { k: "abc", m: "tok" } });
    expect(parsePageTarget("https://a.codecast.sh/k3j2h4?e=em")).toEqual({ slug: "k3j2h4", gate: { e: "em" } });
  });
  it("leaves paths to the caller", () => {
    expect(parsePageTarget("dist/index.html")).toBeNull();
    expect(parsePageTarget("./app")).toBeNull();
  });
});

describe("appDeepLink", () => {
  it("carries gate keys on install, in a fixed order", () => {
    expect(appDeepLink("install", "k3j2h4", { m: "t", k: "a b" })).toBe("codecast://install/k3j2h4?k=a+b&m=t");
    expect(appDeepLink("install", "k3j2h4")).toBe("codecast://install/k3j2h4");
  });
  it("never puts keys on uninstall", () => {
    expect(appDeepLink("uninstall", "k3j2h4", { k: "a" })).toBe("codecast://uninstall/k3j2h4");
  });
});

describe("openerCommand", () => {
  const url = "codecast://install/s?k=a&m=b";
  it("uses open on macOS and xdg-open on Linux", () => {
    expect(openerCommand("darwin", url)).toEqual({ cmd: "open", args: [url] });
    expect(openerCommand("linux", url)).toEqual({ cmd: "xdg-open", args: [url] });
  });
  it("uses start with an empty title on Windows, the URL quoted so & stays inside it", () => {
    expect(openerCommand("win32", url)).toEqual({ cmd: "cmd.exe", args: ["/d", "/s", "/c", `start "" "${url}"`], verbatim: true });
  });
});

describe("desktop paths", () => {
  it("finds settings in Electron's userData per OS", () => {
    expect(desktopUserDataDir("darwin", {}, "/Users/ada")).toBe("/Users/ada/Library/Application Support/Codecast");
    expect(desktopUserDataDir("win32", { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" }, "C:\\Users\\ada")).toBe(path.join("C:\\Users\\ada\\AppData\\Roaming", "Codecast"));
    expect(desktopUserDataDir("linux", {}, "/home/ada")).toBe("/home/ada/.config/Codecast");
    expect(desktopUserDataDir("darwin", { CODECAST_USER_DATA: "/tmp/ud" }, "/Users/ada")).toBe("/tmp/ud");
  });
  it("knows where the app lives, and that Linux has none", () => {
    expect(desktopAppPaths("darwin", {}, "/Users/ada")).toEqual(["/Applications/Codecast.app", "/Users/ada/Applications/Codecast.app"]);
    expect(desktopAppPaths("win32", { LOCALAPPDATA: "L" }, "H")).toEqual([path.join("L", "Programs", "Codecast", "Codecast.exe")]);
    expect(desktopAppPaths("linux", {}, "/home/ada")).toEqual([]);
  });
  it("names the download when the app is missing", () => {
    expect(missingDesktopMessage({ platform: "darwin", env: {}, home: "/h", exists: () => false }, SITE)).toContain(`${SITE}/download`);
    expect(missingDesktopMessage({ platform: "linux", env: {}, home: "/h", exists: () => true }, SITE)).toContain("macOS and Windows");
    expect(missingDesktopMessage({ platform: "darwin", env: {}, home: "/h", exists: (p) => p === "/Applications/Codecast.app" }, SITE)).toBeNull();
  });
});

describe("parseInstalledApps", () => {
  it("reads installedApps newest first and drops the gate", () => {
    const rows = parseInstalledApps(JSON.stringify({
      env: "prod",
      installedApps: {
        old: { slug: "old", name: "Old", installedAt: 1, grantedVersion: 2, grants: ["notifications"], gate: { k: "secret" } },
        new: { slug: "new", name: "Vitals", installedAt: 5, grants: ["menu-bar", 7] },
      },
    }));
    expect(rows).toEqual([
      { slug: "new", name: "Vitals", installedAt: 5, grantedVersion: null, grants: ["menu-bar"] },
      { slug: "old", name: "Old", installedAt: 1, grantedVersion: 2, grants: ["notifications"] },
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret");
  });
  it("reads nothing from missing, broken or app-less settings", () => {
    expect(parseInstalledApps(null)).toEqual([]);
    expect(parseInstalledApps("{half")).toEqual([]);
    expect(parseInstalledApps(JSON.stringify({ env: "prod" }))).toEqual([]);
  });
  it("formats a table, and an empty state that says how to install", () => {
    expect(formatInstalledApps([], SITE)[0]).toContain("cast publish install");
    const lines = formatInstalledApps([{ slug: "s1", name: "Vitals", installedAt: 1, grantedVersion: 3, grants: ["notifications", "menu-bar"] }], SITE);
    expect(lines[0]).toMatch(/^SLUG\s+NAME\s+GRANTED\s+GRANTS\s+URL$/);
    expect(lines[1]).toContain("v3");
    expect(lines[1]).toContain(`${SITE}/a/s1`);
  });
});

describe("commands", () => {
  let dir: string;
  let ran: OpenerCommand[];
  let out: string[];
  let logSpy: ReturnType<typeof spyOn>;
  const env = (over: Partial<AppsEnv> = {}): AppsEnv => ({
    platform: "darwin",
    env: { CODECAST_USER_DATA: dir },
    home: "/nowhere",
    exists: (p) => p === "/Applications/Codecast.app",
    run: async (c) => void ran.push(c),
    ...over,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-apps-"));
    ran = [];
    out = [];
    logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  });
  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("install opens the deep link through the opener and never prints the keys", async () => {
    await runPublishInstall({ slug: "s1", title: "Vitals", gate: { k: "secret" } }, SITE, true, env());
    expect(ran).toEqual([{ cmd: "open", args: ["codecast://install/s1?k=secret"] }]);
    expect(JSON.parse(out.join("\n"))).toEqual({ ok: true, slug: "s1", action: "install", sheet_opened: true, gate_keys: ["k"] });
  });

  it("uninstall opens the link only for an installed app", async () => {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ installedApps: { s1: { name: "Vitals", installedAt: 1, grants: [] } } }));
    await runPublishUninstall("s1", SITE, true, env());
    expect(ran).toEqual([{ cmd: "open", args: ["codecast://uninstall/s1"] }]);

    const exit = spyOn(process, "exit").mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
    try {
      await expect(runPublishUninstall("nope", SITE, true, env())).rejects.toThrow("exit 1");
    } finally {
      exit.mockRestore();
    }
    expect(ran).toHaveLength(1);
    expect(out.at(-1)).toContain("not installed");
  });

  it("apps lists the registry with its path", () => {
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ installedApps: { s1: { name: "Vitals", installedAt: 1, grantedVersion: 4, grants: ["login"] } } }));
    runPublishApps(SITE, true, env());
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.registry).toBe(path.join(dir, "settings.json"));
    expect(parsed.apps).toEqual([{ slug: "s1", name: "Vitals", installedAt: 1, grantedVersion: 4, grants: ["login"] }]);
  });
});

describe("publish output for a page with an app block", () => {
  let out: string[];
  let logSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    out = [];
    logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  });
  afterEach(() => logSpy.mockRestore());

  it("names the install command and the permissions", () => {
    expect(appInstallLine("s1", { permissions: ["menu-bar", "notifications"] })).toBe("install with `cast publish install s1`; asks for notifications, menu bar");
    expect(appInstallLine("s1", {})).toBe("install with `cast publish install s1`; asks for nothing beyond its window");
  });

  it("reads the block from a single-file page and prints one app line", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "publish-app-line-"));
    try {
      const file = path.join(tmp, "vitals.html");
      fs.writeFileSync(file, `<title>Vitals</title><script type="application/cast-data+json">{"app":{"name":"Vitals","permissions":["menu-bar"]}}</script>`);
      const app = declaredApp(buildPublishPayload(file).data);
      expect(app).toEqual({ name: "Vitals", permissions: ["menu-bar"] });
      printPublishResult({ url: `${SITE}/a/s1`, version: 1 }, "Vitals", undefined, false, app);
      const lines = out.filter((l) => l.includes("cast publish install s1"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("menu bar");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints no app line without a block", () => {
    expect(declaredApp(null)).toBeNull();
    expect(declaredApp({ queries: {} })).toBeNull();
    printPublishResult({ url: `${SITE}/a/s1`, version: 1 }, "Plain", undefined, false, null);
    expect(out.some((l) => l.includes("cast publish install"))).toBe(false);
  });
});
