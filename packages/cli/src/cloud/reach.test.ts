import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  REACH_ARGV0, REACH_LAPTOP_SCRIPT, REACH_NOTE, REACH_NO_SSHFS_EXIT, REACH_OCCUPIED_EXIT, REACH_REMOTE_SCRIPT, REACH_REMOVE_SCRIPT,
  normalizeReachFolder, reachHostRefusal, reachLaptopArgs, reachLine, reachRefusal, reachSandboxProfile,
} from "./reach.js";
import type { CloudHost } from "../browser/cloudHost.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-test-")));
afterAll(() => { spawnSync("chmod", ["-R", "u+w", tmp]); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("normalizeReachFolder", () => {
  const home = path.join(tmp, "home");
  beforeAll(() => {
    for (const d of ["notes/sub", ".ssh", "Library/Keychains"]) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(home, "file.txt"), "x");
  });

  test("expands ~ and keeps the path as named", () => {
    expect(normalizeReachFolder("~/notes/", home)).toBe(path.join(home, "notes"));
    expect(normalizeReachFolder(path.join(home, "notes/sub"), home)).toBe(path.join(home, "notes/sub"));
  });

  test("refuses the home folder, anything above it and the root", () => {
    expect(() => normalizeReachFolder("~", home)).toThrow(/too broad/);
    expect(() => normalizeReachFolder(tmp, home)).toThrow(/too broad/);
    expect(() => normalizeReachFolder("/", home)).toThrow(/too broad/);
  });

  test("refuses credential folders, missing paths and files", () => {
    expect(() => normalizeReachFolder("~/.ssh", home)).toThrow(/credentials/);
    expect(() => normalizeReachFolder("~/Library/Keychains", home)).toThrow(/credentials/);
    expect(() => normalizeReachFolder("~/nope", home)).toThrow(/does not exist/);
    expect(() => normalizeReachFolder("~/file.txt", home)).toThrow(/not a folder/);
  });
});

describe("reachHostRefusal", () => {
  const base: CloudHost = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k", watchdogVersion: 3 };
  test("a provisioned Linux host and any macOS host are fine; a Linux host with an old watchdog is not", () => {
    expect(reachHostRefusal(base)).toBeNull();
    expect(reachHostRefusal({ ...base, watchdogVersion: 2 })).toMatch(/cast hosts provision i-1/);
    // A Mac never stops itself, so it has no watchdog to outgrow; sshfs is the host's answer.
    expect(reachHostRefusal({ ...base, platform: "darwin", watchdogVersion: undefined })).toBeNull();
  });
});

describe("reachRefusal", () => {
  test("only the reserved exit codes refuse; anything else is retried", () => {
    expect(reachRefusal(REACH_NO_SSHFS_EXIT, "i-1", "/Users/a/n")).toMatch(/no sshfs/);
    expect(reachRefusal(REACH_OCCUPIED_EXIT, "i-1", "/Users/a/n")).toMatch(/already holds files/);
    expect(reachRefusal(255, "i-1", "/Users/a/n")).toBeNull();
    expect(reachRefusal(null, "i-1", "/Users/a/n")).toBeNull();
  });
});

describe("reachSandboxProfile", () => {
  test("denies files by default, lets the folder's ancestors resolve, and grants the folder", () => {
    const p = reachSandboxProfile("/Users/a/my \"notes\"", false);
    expect(p.indexOf("(deny file-read* file-write*)")).toBeLessThan(p.indexOf("(allow file-read* file-write* (subpath"));
    expect(p).toContain(`(allow file-read-metadata (literal "/Users/a") (literal "/Users"))`);
    expect(p).toContain(`(subpath "/Users/a/my \\"notes\\"")`);
    expect(p).toContain("(deny network*)");
  });
  test("read-only grants no write", () => {
    expect(reachSandboxProfile("/Users/a/notes", true)).toContain(`(allow file-read* (subpath "/Users/a/notes"))`);
  });
});

describe("reachLaptopArgs", () => {
  const host = { address: "1.2.3.4", user: "ubuntu", keyPath: "/k", remoteBaseDir: "/home/ubuntu/work" };
  test("bash runs the fifo script with profile, folder and mode, then a held ssh connection whose command mounts at the laptop path", () => {
    const args = reachLaptopArgs(host, { path: "/Users/a/it's", addedAt: 1, readOnly: true }, "/private/x", "Mac");
    expect(args.slice(0, 3)).toEqual(["-c", REACH_LAPTOP_SCRIPT, REACH_ARGV0]);
    expect(args[4]).toBe("/private/x");
    expect(args[5]).toBe("-R");
    expect(args).toContain("ControlPath=none");
    expect(args.at(-2)).toBe("ubuntu@1.2.3.4");
    expect(args.at(-1)).toContain(`'/Users/a/it'\\''s' '/private/x' 'Mac'`);
  });
});

describe("reachLine", () => {
  test("names the state, and says when the daemon has gone quiet", () => {
    expect(reachLine({ path: "/n", addedAt: 1 }, { state: "mounted", since: 1 }, 1000)).toBe("/n: mounted on the host");
    expect(reachLine({ path: "/n", addedAt: 1, readOnly: true }, { state: "refused", detail: "why", since: 1 }, 0)).toBe("/n (read-only): refused — why");
    expect(reachLine({ path: "/n", addedAt: 1 }, { state: "mounted", since: 1 }, 10 * 60_000)).toMatch(/has not reported/);
  });
});

// The host script against a stub sshfs: everything but the mount itself.
describe("REACH_REMOTE_SCRIPT", () => {
  const bin = path.join(tmp, "bin");
  const log = path.join(tmp, "sshfs-args");
  beforeAll(() => {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "sshfs"), `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  }, 60_000);
  const run = (mp: string, withSshfs = true) => spawnSync("bash", ["-c", REACH_REMOTE_SCRIPT, REACH_ARGV0, mp, "/laptop/notes", "Ashot's Mac"], {
    encoding: "utf-8",
    env: { ...process.env, PATH: withSshfs ? `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` : "/usr/bin:/bin:/usr/sbin:/sbin" },
  });

  test("without sshfs it refuses with its reserved code", () => {
    expect(run(path.join(tmp, "m0"), false).status).toBe(REACH_NO_SSHFS_EXIT);
  }, 60_000);

  test("makes the mountpoint, leaves the note, runs sshfs in slave mode on the laptop path, then locks the folder", () => {
    const mp = path.join(tmp, "deep/m1");
    const r = run(mp);
    expect(r.status).toBe(0);
    const args = fs.readFileSync(log, "utf-8").trim().split("\n");
    expect(args.slice(0, 3)).toEqual([":/laptop/notes", mp, "-f"]);
    expect(args.join(" ")).toContain("-o slave -o idmap=user");
    expect(fs.readFileSync(path.join(mp, REACH_NOTE), "utf-8")).toContain("/laptop/notes on Ashot's Mac");
    expect(fs.statSync(mp).mode & 0o222).toBe(0);
    // A second run (the laptop reconnecting) reopens it and finds only its own note.
    expect(run(mp).status).toBe(0);
  }, 60_000);

  test("once a folder is no longer reached, its mountpoint and note are removed; one holding other files is left", () => {
    const remove = (mp: string) => spawnSync("bash", ["-c", REACH_REMOVE_SCRIPT, REACH_ARGV0, mp], { encoding: "utf-8" });
    const mp = path.join(tmp, "m3");
    expect(run(mp).status).toBe(0);
    expect(remove(mp).status).toBe(0);
    expect(fs.existsSync(mp)).toBe(false);
    const kept = path.join(tmp, "m4");
    fs.mkdirSync(kept);
    fs.writeFileSync(path.join(kept, "theirs.txt"), "x");
    expect(remove(kept).status).toBe(0);
    expect(fs.existsSync(path.join(kept, "theirs.txt"))).toBe(true);
  }, 60_000);

  test("refuses a mountpoint that holds anything but the note", () => {
    const mp = path.join(tmp, "m2");
    fs.mkdirSync(mp);
    fs.writeFileSync(path.join(mp, "theirs.txt"), "x");
    expect(run(mp).status).toBe(REACH_OCCUPIED_EXIT);
    expect(fs.existsSync(path.join(mp, REACH_NOTE))).toBe(false);
  }, 60_000);
});

// The real confinement: the profile around the real sftp-server, driven by
// sftp -D (a local server, no ssh). macOS only, like the feature.
describe.skipIf(process.platform !== "darwin")("the sandbox confines sftp-server to the folder", () => {
  const folder = path.join(tmp, "served");
  const outside = path.join(tmp, "outside.txt");
  const got = path.join(tmp, "got");
  let transcript = "";
  beforeAll(() => {
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(got, { recursive: true });
    fs.writeFileSync(path.join(folder, "in.txt"), "inside");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(folder, "escape"));
    const server = path.join(tmp, "server.sh");
    const profile = path.join(tmp, "profile.sb");
    fs.writeFileSync(profile, reachSandboxProfile(folder, false));
    fs.writeFileSync(server, `#!/bin/bash\nexec /usr/bin/sandbox-exec -f ${JSON.stringify(profile)} /usr/libexec/sftp-server -d ${JSON.stringify(folder)} -P symlink,hardlink\n`, { mode: 0o755 });
    const batch = [
      `get in.txt ${got}/in.txt`,
      `put ${path.join(folder, "in.txt")} written.txt`,
      `get escape ${got}/escape.txt`,
      `get ${outside} ${got}/outside.txt`,
      `symlink ${outside} planted`,
      `rename written.txt ${path.join(tmp, "moved-out.txt")}`,
      "mkdir sub",
    ].join("\n");
    transcript = spawnSync("sftp", ["-D", server], { input: batch + "\n", encoding: "utf-8" }).stdout;
  }, 60_000);

  test("reads and writes inside the folder work", () => {
    expect(fs.readFileSync(path.join(got, "in.txt"), "utf-8")).toBe("inside");
    expect(fs.readFileSync(path.join(folder, "written.txt"), "utf-8")).toBe("inside");
    expect(fs.statSync(path.join(folder, "sub")).isDirectory()).toBe(true);
  }, 60_000);

  test("a symlink out, an absolute path out, a planted link and a rename out all fail", () => {
    expect(fs.existsSync(path.join(got, "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(got, "outside.txt"))).toBe(false);
    expect(fs.existsSync(path.join(folder, "planted"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "moved-out.txt"))).toBe(false);
    expect(transcript).toContain("sftp> mkdir sub");
  }, 60_000);
});
