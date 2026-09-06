import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

describe.skipIf(process.platform !== "darwin")("macOS browser app preparation", () => {
  let base: string;
  let helper: string;
  let template: string;
  let sequence = 0;
  const icon = path.join(import.meta.dir, "assets/cast-agent-chrome.png");
  const checked = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `${command}: ${result.status}`);
    return result.stdout.trim();
  };
  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-branding-test-")));
    helper = path.join(base, "browser-icon");
    checked("/usr/bin/clang", ["-fobjc-arc", "-framework", "AppKit", path.join(import.meta.dir, "../../native/browser-icon.m"), "-o", helper]);
    const code = path.join(base, "fixture.c");
    fs.writeFileSync(code, "#include <unistd.h>\nint main(int argc, char **argv) { if (argc > 1) pause(); return 0; }\n");
    template = path.join(base, "fixture");
    checked("/usr/bin/clang", [code, "-o", template]);
  }, 30_000);
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  function fixture() {
    const dir = path.join(base, `case ${++sequence}`);
    const source = path.join(dir, "Source's Apps/Google Chrome.app");
    const cache = path.join(dir, "browser applications");
    fs.mkdirSync(path.join(source, "Contents/MacOS"), { recursive: true });
    fs.mkdirSync(path.join(source, "Contents/Resources"), { recursive: true });
    fs.writeFileSync(path.join(source, "Contents/Resources/identity.txt"), "original");
    fs.copyFileSync(template, path.join(source, "Contents/MacOS/Google Chrome"));
    const version = (value: string) => {
      fs.writeFileSync(path.join(source, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.google.Chrome</string><key>CFBundleExecutable</key><string>Google Chrome</string><key>CFBundleVersion</key><string>${value}</string><key>CFBundleShortVersionString</key><string>${value}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
      checked("/usr/bin/codesign", ["--force", "--sign", "-", source]);
    };
    version("1.0");
    const prepare = (revision = "1") => checked(helper, [source, cache, icon, revision]);
    return { source, cache, version, prepare };
  }

  test("fresh install keeps executable and plist intact and reuses its copy", () => {
    const f = fixture();
    const app = f.prepare();
    expect(path.basename(app)).toBe("Cast Agent Chrome.app");
    for (const relative of ["Contents/Info.plist", "Contents/MacOS/Google Chrome"]) {
      expect(fs.readFileSync(path.join(app, relative))).toEqual(fs.readFileSync(path.join(f.source, relative)));
    }
    expect(checked("/usr/bin/xattr", [app])).toContain("com.apple.FinderInfo");
    expect(f.prepare()).toBe(app);
    expect(fs.readdirSync(f.cache).filter((name) => name.startsWith("version-"))).toHaveLength(1);
  });

  test("updates Chrome and artwork and removes inactive obsolete copies", () => {
    const f = fixture();
    const first = f.prepare();
    f.version("2.0");
    const second = f.prepare();
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(false);
    const third = f.prepare("2");
    expect(third).not.toBe(second);
    expect(fs.existsSync(second)).toBe(false);
  });

  test("keeps an older copy while its executable is running", async () => {
    const f = fixture();
    const first = f.prepare();
    const child = spawn(path.join(first, "Contents/MacOS/Google Chrome"), ["wait"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    try {
      f.version("2.0");
      const second = f.prepare();
      expect(second).not.toBe(first);
      expect(fs.existsSync(first)).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    f.prepare();
    expect(fs.existsSync(first)).toBe(false);
  });

  test("recovers an interrupted staging copy and a missing cached executable", () => {
    const f = fixture();
    const interrupted = path.join(f.cache, ".prepare-abandoned");
    fs.mkdirSync(interrupted, { recursive: true });
    fs.writeFileSync(path.join(interrupted, "partial"), "unfinished");
    const first = f.prepare();
    expect(fs.existsSync(interrupted)).toBe(false);
    fs.unlinkSync(path.join(first, "Contents/MacOS/Google Chrome"));
    const second = f.prepare();
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(false);
  });

  test("failed setup keeps the last complete copy", () => {
    const f = fixture();
    const first = f.prepare();
    const result = spawnSync(helper, [f.source, f.cache, path.join(base, "missing.png"), "2"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(first)).toBe(true);
    expect(f.prepare()).toBe(first);
  });

  test("replaces a copy with altered signed resources and rejects a damaged source", () => {
    const f = fixture();
    const first = f.prepare();
    fs.writeFileSync(path.join(first, "Contents/Resources/identity.txt"), "changed");
    const second = f.prepare();
    expect(second).not.toBe(first);
    expect(fs.readFileSync(path.join(second, "Contents/Resources/identity.txt"), "utf8")).toBe("original");
    fs.writeFileSync(path.join(f.source, "Contents/Resources/identity.txt"), "changed");
    const result = spawnSync(helper, [f.source, f.cache, icon, "2"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(second)).toBe(true);
  });

  test("simultaneous preparation produces one complete app", async () => {
    const f = fixture();
    const prepare = () => new Promise<string>((resolve, reject) => {
      const child = spawn(helper, [f.source, f.cache, icon, "1"]);
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    });
    const apps = await Promise.all([prepare(), prepare(), prepare()]);
    expect(new Set(apps).size).toBe(1);
    expect(fs.readdirSync(f.cache).filter((name) => name.startsWith("version-"))).toHaveLength(1);
  });
});
