import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hostProfileScript, hostSetupScript, hostSpecHash, parseHostSetupOutput, resolveHostSpec } from "./hostSetup";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-setup-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

test("the repo's [host] and the person's own merge; a zsh laptop asks for zsh", () => {
  write("repo/.codecast/workspace.toml", '[host]\npackages = ["postgresql", "redis-server"]\nservices = ["redis-server"]\nrun = ["make db"]\n');
  write("home/.codecast/host.toml", '[host]\npackages = ["redis-server", "jq"]\nrun = ["echo mine"]\n');
  const spec = resolveHostSpec({ repoRoot: path.join(dir, "repo"), home: path.join(dir, "home"), shell: "/bin/zsh" });
  expect(spec).toEqual({ packages: ["redis-server", "jq", "postgresql", "zsh"], services: ["redis-server"], run: ["echo mine", "make db"], shell: "zsh" });
  expect(resolveHostSpec({ home: path.join(dir, "nobody"), shell: "/bin/bash" })).toEqual({ packages: [], services: [], run: [] });
  expect(hostSpecHash(spec, "/home/ubuntu/work/r")).not.toBe(hostSpecHash({ ...spec, run: ["make db"] }, "/home/ubuntu/work/r"));
});

test("a [host] entry that is not a package or unit name is refused", () => {
  write("repo/.codecast/workspace.toml", '[host]\npackages = ["redis; rm -rf /"]\n');
  expect(() => resolveHostSpec({ repoRoot: path.join(dir, "repo"), home: dir })).toThrow(/not a package or unit name/);
});

/** The script under a fake HOME with sudo, apt and systemctl stubbed, so it runs for real without touching this machine. */
function runScript(script: string) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["sudo", "dpkg", "getent"]) fs.writeFileSync(path.join(bin, name), name === "sudo" ? `#!/bin/sh\necho "sudo $*" >> "$HOME/calls"\ncase "$*" in *tee*) cat > /dev/null;; *"install -y -qq bad"*) echo "E: Unable to locate package bad" >&2; exit 100;; esac\n` : name === "dpkg" ? "#!/bin/sh\nexit 1\n" : "#!/bin/sh\necho u:x:1:1::/h:/bin/bash\n", { mode: 0o755 });
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", env: { ...process.env, HOME: path.join(dir, "home"), PATH: `${bin}:${process.env.PATH}` } });
  return { out: parseHostSetupOutput(r.stdout), calls: fs.existsSync(path.join(dir, "home/calls")) ? fs.readFileSync(path.join(dir, "home/calls"), "utf-8") : "" };
}

test("the script applies once per spec, re-applies when forced, and reports the failing step without stamping", () => {
  fs.mkdirSync(path.join(dir, "home"), { recursive: true });
  const spec = { packages: ["redis-server"], services: ["redis-server"], run: ["echo ran > \"$HOME/ran\""] };
  const first = runScript(hostSetupScript(spec, { hash: "h1" }));
  expect(first.out).toEqual({ ok: true, applied: true });
  expect(first.calls).toContain("sudo -n apt-get install -y -qq redis-server");
  expect(first.calls).toContain("sudo -n systemctl enable --now redis-server");
  expect(fs.readFileSync(path.join(dir, "home/ran"), "utf-8").trim()).toBe("ran");
  expect(runScript(hostSetupScript(spec, { hash: "h1" })).out).toEqual({ ok: true, skipped: "in step", applied: false });
  expect(runScript(hostSetupScript(spec, { hash: "h1", force: true })).out).toEqual({ ok: true, applied: true });
  const failed = runScript(hostSetupScript({ packages: ["bad"], services: [], run: [] }, { hash: "h2" }));
  expect(failed.out?.ok).toBe(false);
  expect(failed.out?.step).toBe("install bad");
  expect(failed.out?.error).toContain("Unable to locate package bad");
  expect(JSON.parse(fs.readFileSync(path.join(dir, "home/.codecast/host-setup.json"), "utf-8")).hash).toBe("h1");
});

test("every login shell on a host names the host and keeps the host's tool directories", () => {
  const text = hostProfileScript();
  expect(text).toContain("export CODECAST_CLOUD=1");
  const r = spawnSync("sh", ["-c", `${text}\nprintf '%s' "$PATH"`], { encoding: "utf-8", env: { HOME: dir, PATH: "/usr/bin:/bin" } });
  expect(r.stdout.split(":")).toContain("/usr/bin");
  fs.mkdirSync(path.join(dir, ".local/bin"), { recursive: true });
  const again = spawnSync("sh", ["-c", `${text}\nprintf '%s' "$PATH"`], { encoding: "utf-8", env: { HOME: dir, PATH: "/usr/bin:/bin" } });
  expect(again.stdout.split(":")[0]).toBe(path.join(dir, ".local/bin"));
});
