import { systemPathWithout } from "../test-helpers/systemPath.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GH_WRAPPER_MARKER, GH_WRAPPER_REL, ghWrapperInstallSnippet, ghWrapperScript, REAL_GH_REL } from "./ghWrapper";

let dir: string, home: string, castBin: string, realBin: string, work: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-gh-wrapper-")));
  home = path.join(dir, "home");
  castBin = path.join(dir, "cast-bin");
  realBin = path.join(dir, "real-bin");
  work = path.join(dir, "work");
  for (const d of [home, castBin, realBin, work]) fs.mkdirSync(d, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function exe(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** A cast that records git's request and answers like the real helper. */
function fakeCast(body = `printf 'username=x-access-token\\npassword=ghs_fresh\\npassword_expiry_utc=1\\n'`): void {
  exe(path.join(castBin, "cast"), `echo "$*" > "${dir}/cast-argv"; cat > "${dir}/cast-stdin"\n${body}`);
}

/** The real gh: prints what it was given. */
function fakeRealGh(at = path.join(realBin, "gh")): void {
  exe(at, `echo "token=\${GH_TOKEN:-}"; for a in "$@"; do echo "arg=$a"; done; exit 7`);
}

function installWrapper(): string {
  const p = path.join(home, GH_WRAPPER_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, ghWrapperScript(), { mode: 0o755 });
  return p;
}

function runGh(args: string[], env: Record<string, string> = {}) {
  const wrapper = path.join(home, GH_WRAPPER_REL);
  const r = spawnSync(wrapper, args, {
    cwd: work,
    encoding: "utf-8",
    timeout: 20_000,
    env: { HOME: home, PATH: `${path.dirname(wrapper)}:${castBin}:${realBin}:${systemPathWithout("gh")}`, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const castStdin = () => fs.readFileSync(path.join(dir, "cast-stdin"), "utf-8");
const castCalled = () => fs.existsSync(path.join(dir, "cast-stdin"));

describe("ghWrapperScript", () => {
  test("carries its marker in the first bytes, execs the real gh, and holds no token", () => {
    const s = ghWrapperScript();
    expect(s.startsWith("#!/bin/sh\n")).toBe(true);
    expect(s.slice(0, 512)).toContain(GH_WRAPPER_MARKER);
    expect(s).toContain('exec "$real" "$@"');
    expect(s).toContain("git-credential get");
    expect(s).not.toContain("ghs_");
    expect(ghWrapperInstallSnippet()).toContain(s);
  });

  test("hands gh the helper's token as GH_TOKEN, asks for this directory's repository, and keeps every argument", () => {
    fakeCast();
    fakeRealGh();
    installWrapper();
    const r = runGh(["pr", "create", "--title", "two words"]);
    expect(r.status).toBe(7);
    expect(r.stdout).toBe("token=ghs_fresh\narg=pr\narg=create\narg=--title\narg=two words\n");
    expect(fs.readFileSync(path.join(dir, "cast-argv"), "utf-8").trim()).toBe("git-credential get");
    expect(castStdin()).toBe("protocol=https\nhost=github.com\n\n");
  });

  test("-R and --repo name the repository for the helper; a form it cannot read falls back to the directory", () => {
    fakeCast();
    fakeRealGh();
    installWrapper();
    runGh(["pr", "list", "-R", "o/r"]);
    expect(castStdin()).toBe("protocol=https\nhost=github.com\npath=o/r\n\n");
    runGh(["pr", "list", "--repo=https://github.com/o/r2.git"]);
    expect(castStdin()).toContain("path=o/r2\n");
    runGh(["pr", "list", "-Rgithub.com/o/r3"]);
    expect(castStdin()).toContain("path=o/r3\n");
    runGh(["pr", "list", "--repo", "enterprise.example/o/r"]);
    expect(castStdin()).toBe("protocol=https\nhost=github.com\n\n");
    runGh(["pr", "list", "-R", "o/r;rm -rf"]);
    expect(castStdin()).toBe("protocol=https\nhost=github.com\n\n");
  });

  test("falls through to plain gh when the helper has nothing", () => {
    fakeCast("exit 1");
    fakeRealGh();
    installWrapper();
    const r = runGh(["issue", "list"]);
    expect(r.status).toBe(7);
    expect(r.stdout).toBe("token=\narg=issue\narg=list\n");
    expect(r.stderr).toBe("");
  });

  test("a helper answer without a password sets no token", () => {
    fakeCast(`echo "cast 1.2.3 is available"`);
    fakeRealGh();
    installWrapper();
    expect(runGh(["api", "user"]).stdout).toBe("token=\narg=api\narg=user\n");
  });

  test("an explicit GH_TOKEN or GITHUB_TOKEN wins, and version or completion never asks the helper", () => {
    fakeCast();
    fakeRealGh();
    installWrapper();
    expect(runGh(["api", "user"], { GH_TOKEN: "mine" }).stdout).toBe("token=mine\narg=api\narg=user\n");
    runGh(["api", "user"], { GITHUB_TOKEN: "mine" });
    runGh(["--version"]);
    runGh(["completion", "-s", "bash"]);
    runGh(["api", "user"], { GH_HOST: "enterprise.example" });
    expect(castCalled()).toBe(false);
  });

  test("a github.com login made on the host with gh auth login wins over the App token", () => {
    fakeCast();
    fakeRealGh();
    installWrapper();
    fs.mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), "enterprise.example:\n    user: x\n");
    expect(runGh(["api", "user"]).stdout).toBe("token=ghs_fresh\narg=api\narg=user\n");
    fs.writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), "github.com:\n    user: human\n    git_protocol: https\n");
    fs.rmSync(path.join(dir, "cast-stdin"), { force: true });
    expect(runGh(["pr", "create"]).stdout).toBe("token=\narg=pr\narg=create\n");
    expect(castCalled()).toBe(false);
  });

  test("the real gh behind the wrapper is found in libexec first, never the wrapper itself; none is exit 127", () => {
    fakeCast();
    installWrapper();
    // Another wrapper copy further down PATH is skipped too.
    fs.writeFileSync(path.join(realBin, "gh"), ghWrapperScript(), { mode: 0o755 });
    const none = runGh(["pr", "list"]);
    expect(none.status).toBe(127);
    expect(none.stderr).toContain("not installed on this host");
    exe(path.join(home, REAL_GH_REL), `echo libexec "\${GH_TOKEN:-}"`);
    expect(runGh(["pr", "list"]).stdout).toBe("libexec ghs_fresh\n");
  });
});

describe("ghWrapperInstallSnippet", () => {
  const install = () => spawnSync("bash", ["-c", ghWrapperInstallSnippet()], { encoding: "utf-8", env: { HOME: home, PATH: systemPathWithout("gh") }, timeout: 20_000 });
  const wrapperPath = () => path.join(home, GH_WRAPPER_REL);

  test("moves a real gh at the wrapper's path aside, writes the wrapper 0755, and a rerun changes nothing", () => {
    fakeRealGh(wrapperPath());
    expect(install().status).toBe(0);
    expect(fs.readFileSync(wrapperPath(), "utf-8")).toBe(ghWrapperScript());
    expect(fs.statSync(wrapperPath()).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(home, REAL_GH_REL), "utf-8")).toContain("token=");
    expect(install().status).toBe(0);
    expect(fs.readFileSync(path.join(home, REAL_GH_REL), "utf-8")).toContain("token=");
    expect(fs.readFileSync(wrapperPath(), "utf-8")).toBe(ghWrapperScript());
    expect(fs.readdirSync(path.dirname(wrapperPath()))).toEqual(["gh"]);
    fakeCast();
    const r = runGh(["repo", "view"]);
    expect(r.stdout).toBe("token=ghs_fresh\narg=repo\narg=view\n");
  });

  test("with no gh anywhere it still writes the wrapper, which reports gh missing", () => {
    expect(install().status).toBe(0);
    expect(fs.existsSync(path.join(home, REAL_GH_REL))).toBe(false);
    expect(runGh(["pr", "list"]).status).toBe(127);
  });

  test("a real gh that cannot be moved aside is never overwritten", () => {
    fakeRealGh(wrapperPath());
    // libexec/codecast exists as a FILE, so the move target's directory cannot be made.
    fs.mkdirSync(path.join(home, ".local", "libexec"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local", "libexec", "codecast"), "");
    install();
    expect(fs.readFileSync(wrapperPath(), "utf-8")).not.toContain(GH_WRAPPER_MARKER);
  });
});
