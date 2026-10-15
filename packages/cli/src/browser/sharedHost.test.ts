import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addUserRootScript, addUserSelfScript, BASHRC_PATH_MARK, claudeFirstRunScript, enableUserDaemonScript,
  sharedHostMarkScript, sharedHostSetupScript, sharedOwnerSteps, teammateSteps, userDaemonUnits,
} from "./sharedHost.js";
import { daemonUnitScript } from "./provisionLinux.js";
import { SHARED_HOST_MARKER, SHARED_HOST_PUSH_GUARD, SHARED_HOST_REFUSAL, SHARED_HOST_REFUSED_STATUS } from "../remote/sharedHostGuard.js";
import { parseAgentAuthReceiverOutput } from "../remote/session-move.js";
import { agentCliInstallScript } from "./provisionAgents.js";
import { nodeInstallSnippet } from "../cloud/hostTools.js";
import { hostReleaseScript } from "../hosts/installRelease.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });
function tempHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "shared-host-home-"));
  homes.push(h);
  return h;
}
function bash(script: string, env: Record<string, string> = {}, input?: string) {
  return spawnSync("bash", ["-c", script], { encoding: "utf-8", env: { ...process.env, ...env }, input });
}
/** `bash -n`: the script parses. Every generator here ships to a host that runs it unseen. */
function parses(script: string): string {
  return spawnSync("bash", ["-n"], { input: script, encoding: "utf-8" }).stderr;
}

describe("generated scripts", () => {
  const all: Array<[string, string]> = [
    ["shared host mark", sharedHostMarkScript()],
    ["shared host setup", sharedHostSetupScript()],
    ["add user (root, github)", addUserRootScript("cam", "cameron417")],
    ["add user (root, no github)", addUserRootScript("cam")],
    ["add user (self)", addUserSelfScript({ claude: "2.1.301", codex: "0.150.0" })],
    ["enable daemon", enableUserDaemonScript("cam")],
    ["owner daemon unit (shared)", daemonUnitScript({ shared: true })],
  ];
  for (const [name, script] of all) {
    test(`${name} parses and leaves no template placeholder`, () => {
      expect(parses(script)).toBe("");
      expect(script).not.toContain("${");
      expect(script).not.toContain("undefined");
    });
  }

  test("names that would reach a shell or a unit name are refused", () => {
    for (const bad of ["Cam", "cam;rm -rf /", "../root", "", "a".repeat(33)]) {
      expect(() => addUserRootScript(bad)).toThrow();
      expect(() => enableUserDaemonScript(bad)).toThrow();
    }
    expect(() => addUserRootScript("cam", "x;curl evil")).toThrow();
  });
});

describe("per-user daemon units", () => {
  const { service, path: pathUnit } = userDaemonUnits();

  test("a peer daemon: never a remote device, its own Claude token, its own cast", () => {
    expect(service).not.toContain("CODECAST_REMOTE_DEVICE");
    expect(service).toContain("User=%i");
    expect(service).toContain("EnvironmentFile=-/home/%i/.codecast/claude.env");
    expect(service).toContain("ExecStart=/home/%i/.local/bin/cast _daemon");
    expect(service).toContain("KillMode=process");
    expect(service).toContain("Environment=CODECAST_CLOUD=1");
  });

  test("its own tools come before anything shared on PATH", () => {
    const line = service.split("\n").find((l) => l.startsWith("Environment=PATH="))!;
    const dirs = line.slice("Environment=PATH=".length).split(":");
    expect(dirs.indexOf("/home/%i/.local/bin")).toBe(0);
    expect(dirs.indexOf("/home/%i/.bun/bin")).toBeLessThan(dirs.indexOf("/usr/local/bin"));
  });

  test("the path unit starts it once that person's cast login writes their config", () => {
    expect(pathUnit).toContain("PathExists=/home/%i/.codecast/config.json");
    expect(pathUnit).toContain("Unit=codecast-daemon-user@%i.service");
  });

  test("setup installs both units and the marker", () => {
    const s = sharedHostSetupScript();
    expect(s).toContain(`sudo touch ${SHARED_HOST_MARKER}`);
    expect(s).toContain("/etc/systemd/system/codecast-daemon-user@.service");
    expect(s).toContain("/etc/systemd/system/codecast-daemon-user@.path");
  });

  test("enabling arms the path unit, not the service, so a user who has not signed in is not crash-looped", () => {
    expect(enableUserDaemonScript("cam")).toContain("systemctl enable --now codecast-daemon-user@cam.path");
  });
});

describe("the owner's daemon unit", () => {
  test("shared: a peer with its own token and tools, and the remote-device marker removed", () => {
    const s = daemonUnitScript({ shared: true });
    expect(s).not.toContain("CODECAST_REMOTE_DEVICE");
    expect(s).toContain("rm -f /home/ubuntu/.codecast/remote-device");
    expect(s).toContain("EnvironmentFile=-/home/ubuntu/.codecast/claude.env");
    expect(s).toContain("ExecStart=/home/ubuntu/.local/bin/cast _daemon");
    expect(s).toContain("systemctl disable --now codecast-daemon-user@ubuntu.path codecast-daemon-user@ubuntu.service");
  });

  test("not shared: unchanged, a remote device", () => {
    const s = daemonUnitScript();
    expect(s).toContain("Environment=CODECAST_REMOTE_DEVICE=1");
    expect(s).toContain(": > /home/ubuntu/.codecast/remote-device");
    expect(s).toContain("ExecStart=/usr/local/bin/cast _daemon");
    expect(s).not.toContain("claude.env");
  });
});

describe("binaries outside private homes", () => {
  test("setup removes exactly the /usr/local/bin links that point into a home", () => {
    const loop = sharedHostSetupScript().match(/for l in \/usr\/local\/bin\/\*; do[\s\S]*?\ndone/)![0];
    const bin = tempHome();
    fs.symlinkSync("/home/ubuntu/.local/bin/claude", path.join(bin, "claude"));
    fs.symlinkSync("/home/ubuntu/.bun/bin/bun", path.join(bin, "bun"));
    fs.symlinkSync("/opt/node-22/bin/node", path.join(bin, "node"));
    fs.writeFileSync(path.join(bin, "cast"), "#!/bin/sh\n");
    const r = bash(loop.replaceAll("/usr/local/bin", bin).replaceAll("sudo ", ""));
    expect(r.status).toBe(0);
    expect(fs.readdirSync(bin).sort()).toEqual(["cast", "node"]);
  });

  test("every step that links a tool into /usr/local/bin first checks the host is not shared", () => {
    const guard = `[ ! -e ${SHARED_HOST_MARKER} ]`;
    for (const script of [agentCliInstallScript({}), nodeInstallSnippet(22), hostReleaseScript("linux")]) {
      const linking = script.split("\n").filter((l) => /sudo (-n )?ln -sf/.test(l));
      expect(linking.length).toBeGreaterThan(0);
      for (const line of linking) expect(line.includes(guard) || script.includes(`if ${guard}; then sudo ln -sf`)).toBe(true);
    }
  });

  test("converting a host removes the Claude login an earlier provision pushed", () => {
    expect(sharedHostSetupScript()).toContain('rm -f "$HOME/.claude/.credentials.json"');
  });

  test("a new user's installs run with their own PATH, so a tool linked for the owner is never taken as theirs", () => {
    const s = addUserSelfScript({});
    const paths = s.split("\n").filter((l) => l.startsWith("export PATH="));
    // The release install runs in its own subshell; every other PATH leaves /usr/local/bin out.
    const release = s.slice(s.indexOf("(\n"), s.indexOf("\n)") + 2);
    for (const p of paths.filter((l) => !release.includes(l))) expect(p).not.toContain("/usr/local/bin");
    expect(s).toContain('[ -x "$HOME/.bun/bin/bun" ]');
  });

  test("the user's cast comes from the published release, without system links", () => {
    const s = addUserSelfScript({});
    expect(s).toContain("https://dl.codecast.sh/latest.json");
    expect(s).not.toContain("sudo ln -sf");
  });
});

describe("the PATH line in ~/.bashrc", () => {
  const block = sharedHostSetupScript().match(/if ! grep -qF[\s\S]*?\nfi/)![0];

  test("goes above Ubuntu's interactive guard, once", () => {
    const home = tempHome();
    const original = "# ~/.bashrc\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\nalias ll='ls -l'\n";
    fs.writeFileSync(path.join(home, ".bashrc"), original);
    expect(bash(block, { HOME: home }).status).toBe(0);
    expect(bash(block, { HOME: home }).status).toBe(0);
    const rc = fs.readFileSync(path.join(home, ".bashrc"), "utf-8");
    expect(rc.split(BASHRC_PATH_MARK).length).toBe(2);
    expect(rc.indexOf(BASHRC_PATH_MARK)).toBe(0);
    expect(rc.endsWith(original)).toBe(true);
  });

  test("a non-interactive shell reading it gets the user's own tools first", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, ".bashrc"), "case $- in *i*) ;; *) return;; esac\n");
    bash(block, { HOME: home });
    const r = bash(`. "$HOME/.bashrc"; echo "$PATH"`, { HOME: home, PATH: "/usr/bin:/bin" });
    expect(r.stdout.trim().split(":").slice(0, 2)).toEqual([`${home}/.local/bin`, `${home}/.bun/bin`]);
  });
});

describe("claude's first-run screens", () => {
  test("answered for a fresh user, with HOME trusted and the bypass consent in settings.json", () => {
    const home = tempHome();
    const r = bash(claudeFirstRunScript(), { HOME: home });
    expect(r.stdout).toContain("claude-first-run=ok");
    const state = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"));
    expect(state.hasCompletedOnboarding).toBe(true);
    expect(state.theme).toBe("dark");
    expect(state.projects[home].hasTrustDialogAccepted).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"));
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect((fs.statSync(path.join(home, ".claude.json")).mode & 0o777).toString(8)).toBe("600");
  });

  test("a re-run keeps what the user already set", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ theme: "light", userID: "u1", projects: { "/x": { allowedTools: ["Bash"] } } }));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus" }));
    bash(claudeFirstRunScript(), { HOME: home });
    const state = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"));
    expect(state.theme).toBe("light");
    expect(state.userID).toBe("u1");
    expect(state.projects["/x"]).toEqual({ allowedTools: ["Bash"] });
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"));
    expect(settings).toEqual({ model: "opus", skipDangerousModePermissionPrompt: true });
  });
});

describe("no laptop logins reach a shared host", () => {
  test("the push guard drains stdin, says why and exits 4 when the marker exists", () => {
    const dir = tempHome();
    const marker = path.join(dir, "shared-host");
    const guard = SHARED_HOST_PUSH_GUARD.replaceAll(SHARED_HOST_MARKER, marker);
    const target = path.join(dir, "credentials.json");
    const cmd = `${guard}cat > ${target}`;
    expect(bash(cmd, {}, "secret").status).toBe(0);
    expect(fs.readFileSync(target, "utf-8")).toBe("secret");
    fs.rmSync(target);
    fs.writeFileSync(marker, "");
    const r = bash(cmd, {}, "secret");
    expect(r.status).toBe(SHARED_HOST_REFUSED_STATUS);
    expect(r.stderr).toContain(SHARED_HOST_REFUSAL);
    expect(fs.existsSync(target)).toBe(false);
  });

  test("the agent auth receiver's refusal reads as the shared-host reason", () => {
    expect(parseAgentAuthReceiverOutput("", SHARED_HOST_REFUSED_STATUS, SHARED_HOST_REFUSAL)).toEqual({ pushed: false, kept: [], reason: SHARED_HOST_REFUSAL });
  });
});

describe("the steps a person runs", () => {
  test("their own Claude token into the file their daemon reads, then their own codecast login", () => {
    const steps = teammateSteps("cam", "1.2.3.4");
    expect(steps[0]).toBe("ssh cam@1.2.3.4");
    expect(steps.join("\n")).toContain("claude setup-token");
    expect(steps.join("\n")).toContain("~/.codecast/claude.env");
    expect(steps.at(-1)).toMatch(/^cast login /);
  });

  test("the token step writes a 0600 env file the unit can read", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, ".codecast"));
    const write = teammateSteps("cam", "h")[2].replace(/^read -rsp 'Claude token: ' t && /, 't=$(cat) && ');
    expect(bash(write, { HOME: home }, "sk-ant-oat01-abc").status).toBe(0);
    const file = path.join(home, ".codecast", "claude.env");
    expect(fs.readFileSync(file, "utf-8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n");
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
  });

  test("the owner restarts the daemon that already runs", () => {
    expect(sharedOwnerSteps("ubuntu", "h").at(-1)).toBe("sudo systemctl restart codecast-daemon.service");
  });
});
