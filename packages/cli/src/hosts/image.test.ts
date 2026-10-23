import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { baseImageName, brokenRefSweep, cloneResetUserData, cloneTreesAside, createBaseImageArgs, createImageArgs, imageName, macBaseScrubScript } from "./image";

test("a clone makes itself its own machine once, before the daemon: new machine id, no source token, no source worktrees", () => {
  const data = cloneResetUserData("ubuntu");
  const doc = (Bun as any).YAML.parse(data.replace(/^#cloud-config\n/, ""));
  const cmd: string[] = doc.bootcmd[0];
  expect(cmd.slice(0, 3)).toEqual(["cloud-init-per", "instance", "codecast-clone-reset"]);
  const script = cmd[5]!;
  expect(spawnSync("sh", ["-n", "-c", script]).status).toBe(0);
  expect(script.indexOf("systemctl stop codecast-daemon")).toBeLessThan(script.indexOf("systemd-machine-id-setup"));
  expect(script).toContain("rm -f /etc/machine-id /var/lib/dbus/machine-id");
  expect(script).toContain("/home/ubuntu/.codecast/config.json");
  expect(script).toContain(".codecast/$d");
});

test("a clone never deletes the source's worktrees while it boots: they move aside and go after boot", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = require("fs");
  const { join } = require("path");
  const home = mkdtempSync(join(require("os").tmpdir(), "clonehome-"));
  try {
    const repo = join(home, "work/repo");
    mkdirSync(join(repo, ".codecast/worktrees/agentwatch-ct-1"), { recursive: true });
    writeFileSync(join(repo, ".codecast/worktrees/agentwatch-ct-1/f"), "x");
    const [aside, later] = cloneTreesAside(home, "nobody-here");
    expect(spawnSync("sh", ["-c", aside!]).status).toBe(0);
    expect(existsSync(join(repo, ".codecast/worktrees"))).toBe(false);
    expect(existsSync(join(repo, ".codecast/.clone-trash-worktrees/agentwatch-ct-1/f"))).toBe(true);
    expect(later).toContain(`rm -rf ${home}/work/*/.codecast/.clone-trash-*`);
    const script = (Bun as any).YAML.parse(cloneResetUserData("ubuntu").replace(/^#cloud-config\n/, "")).bootcmd[0][5] as string;
    for (const step of cloneTreesAside("/home/ubuntu", "ubuntu")) expect(script).toContain(step);
    expect(script).not.toMatch(/rm -rf "\$r\.codecast\/worktrees"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an image is tagged as codecast's, for its platform and source, and captured without a reboot", () => {
  const name = imageName("linux", "i-084309c56a91e15ff", new Date("2026-09-29T10:11:12Z"));
  expect(name).toBe("codecast-linux-2026-09-29-10-11-12-a91e15ff".replace("a91e15ff", "c56a91e15ff".slice(-6)));
  const args = createImageArgs("i-084309c56a91e15ff", "linux", name);
  expect(args).toContain("--no-reboot");
  const tags = JSON.parse(args[args.indexOf("--tag-specifications") + 1]!);
  expect(tags.map((t: any) => t.ResourceType)).toEqual(["image", "snapshot"]);
  expect(tags[0].Tags).toContainEqual({ Key: "managed-by", Value: "codecast" });
  expect(tags[0].Tags).toContainEqual({ Key: "codecast-source", Value: "i-084309c56a91e15ff" });
});

test("a base image is never mistaken for a clone of someone's host", () => {
  expect(baseImageName("darwin", new Date("2026-10-09T20:00:00Z"))).toBe("codecast-base-darwin-2026-10-09");
  const args = createBaseImageArgs("i-0abc", "darwin", "codecast-base-darwin-2026-10-09");
  expect(args.join(" ")).not.toContain("managed-by");
  // A consistent snapshot: the base build lets AWS restart the machine.
  expect(args).not.toContain("--no-reboot");
});

test("the base scrub removes every key and password and keeps the granted helper", () => {
  const script = macBaseScrubScript();
  expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  expect(script).toContain('rm -rf "$home/.ssh"');
  expect(script).toContain("/etc/ssh/ssh_host_*");
  expect(script).toContain("! -name computer");
});

test("a clone drops refs whose objects the snapshot missed, and keeps every sound one", () => {
  const { mkdtempSync, rmSync, writeFileSync, existsSync } = require("fs");
  const { join } = require("path");
  const dir = mkdtempSync(join(require("os").tmpdir(), "refsweep-"));
  const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    git("branch", "sound");
    // A ref written to disk before its object: names a commit the repo lacks.
    writeFileSync(join(dir, ".git/refs/heads/torn"), "e18c568890e05cdc468fa947fefdc0f68c84a4af\n");
    writeFileSync(join(dir, ".git/gc.log"), "stale\n");
    const run = spawnSync("sh", ["-c", brokenRefSweep('"$1"'), "sh", dir], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(git("for-each-ref", "--format=%(refname)").stdout.trim().split("\n").sort()).toEqual(["refs/heads/main", "refs/heads/sound"]);
    expect(existsSync(join(dir, ".git/gc.log"))).toBe(false);
    expect(git("fsck", "--connectivity-only").status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the clone reset runs the broken-ref sweep in every work repo, as the host user", () => {
  const script = (Bun as any).YAML.parse(cloneResetUserData("ubuntu").replace(/^#cloud-config\n/, "")).bootcmd[0][5] as string;
  expect(spawnSync("sh", ["-n", "-c", script]).status).toBe(0);
  expect(script).toContain("su - ubuntu -c");
  expect(script).toContain("git cat-file -e");
});
