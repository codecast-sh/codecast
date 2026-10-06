#!/usr/bin/env bun
/**
 * End-to-end check of reached folders (cloud/reach.ts), run from the laptop
 * against a real Linux host and the real laptop daemon.
 *
 *   bun scripts/reach-e2e.ts [--host <id>] [--skip-hang]
 *
 * It approves a scratch folder with `cast hosts reach` and checks, over ssh on
 * the host: reads, writes, in-place edits and grep through the mount; a laptop
 * edit showing up on the host; the idle watchdog not counting the reach's
 * connection; a dropped connection showing the offline note, refusing writes
 * and remounting; a frozen laptop (SIGSTOP) unmounting by sshd's keepalive;
 * read-only; a mountpoint the host already uses being refused; and --off.
 * Everything it creates is removed at the end, on both machines.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readHosts, resolveCloudHost, toRemoteHost } from "../src/browser/cloudHost.js";
import { ssh, shq } from "../src/remote/session-move.js";
import { REACH_NOTE, readReachStatus } from "../src/cloud/reach.js";

const argv = process.argv.slice(2);
const hostArg = argv.includes("--host") ? argv[argv.indexOf("--host") + 1] : undefined;
const skipHang = argv.includes("--skip-hang");
const cloud = resolveCloudHost(hostArg);
const remote = toRemoteHost(cloud);
const cli = path.resolve(import.meta.dir, "../src/main.ts");
const home = os.homedir();
const folder = path.join(home, "reach-e2e");
const occupied = path.join(home, "reach-e2e-occupied");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail.trim().split("\n").join("\n      ")}` : ""}`);
  if (!ok) failures++;
}
function onHost(cmd: string, timeoutMs = 60_000): { out: string; ok: boolean } {
  try { return { out: ssh(remote, cmd, timeoutMs), ok: true }; } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}` || err.message, ok: false };
  }
}
function cast(...args: string[]): { out: string; code: number } {
  const r = spawnSync("bun", [cli, ...args], { encoding: "utf-8", timeout: 120_000 });
  return { out: `${r.stdout}${r.stderr}`, code: r.status ?? -1 };
}
async function until(what: () => boolean, timeoutMs: number, stepMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (what()) return true; await Bun.sleep(stepMs); }
  return what();
}
const state = (p: string) => readReachStatus()?.hosts[cloud.id]?.[p]?.state;
const isMounted = (p: string) => onHost(`findmnt -n -M ${shq(p)} >/dev/null && echo yes || echo no`).out.trim() === "yes";
/** The laptop ssh carrying one reach: its argv holds the quoted mountpoint. */
function laptopSshPids(p: string): number[] {
  const ps = execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf-8" });
  return ps.split("\n").filter((l) => /^\s*\d+\s+ssh\s/.test(l) && l.includes(`'${p}'`)).map((l) => Number(l.trim().split(/\s+/)[0]));
}

function cleanup(): void {
  for (const p of [folder, occupied]) if ((readHosts().find((h) => h.id === cloud.id)?.reach ?? []).some((f) => f.path === p)) cast("hosts", "reach", cloud.id, p, "--off");
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(occupied, { recursive: true, force: true });
  fs.rmSync(path.join(home, "reach-e2e-secret.txt"), { force: true });
}

console.log(`host ${cloud.id} (${remote.address}), folder ${folder}\n`);
cleanup();
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, "todo.md"), "# todo\n- ship reach\n");
fs.writeFileSync(path.join(home, "reach-e2e-secret.txt"), "laptop secret\n");
fs.symlinkSync(path.join(home, "reach-e2e-secret.txt"), path.join(folder, "escape"));

try {
  // 1. Approve and wait for the daemon to mount it.
  const t0 = Date.now();
  const add = cast("hosts", "reach", cloud.id, folder);
  check("cast hosts reach mounts the folder", /mounted on the host/.test(add.out), add.out);
  console.log(`      (${Math.round((Date.now() - t0) / 1000)}s from approval to mounted)`);

  // 2. Reads, writes, in-place edits and grep through the mount.
  const q = shq(folder);
  check("the host reads a laptop file at the laptop path", onHost(`cat ${q}/todo.md`).out === "# todo\n- ship reach\n");
  const w = onHost(`echo 'written on the host' > ${q}/from-host.txt && sed -i 's/ship reach/ship reach (edited on host)/' ${q}/todo.md && mkdir -p ${q}/sub && echo deep > ${q}/sub/deep.txt`);
  check("the host writes, edits in place and makes folders", w.ok, w.out);
  check("the host's new file is on the laptop", fs.readFileSync(path.join(folder, "from-host.txt"), "utf-8") === "written on the host\n");
  check("the host's in-place edit is on the laptop", fs.readFileSync(path.join(folder, "todo.md"), "utf-8").includes("(edited on host)"));
  check("grep -r works through the mount", onHost(`grep -rl deep ${q}`).out.trim() === `${folder}/sub/deep.txt`);
  fs.writeFileSync(path.join(folder, "from-laptop.txt"), "laptop edit\n");
  check("a laptop edit shows on the host within seconds", await until(() => onHost(`cat ${q}/from-laptop.txt 2>/dev/null`).out === "laptop edit\n", 10_000));
  const esc = onHost(`cat ${q}/escape`);
  check("a symlink out of the folder reads nothing of the laptop's", !esc.out.includes("laptop secret"), esc.out);

  // 3. The idle watchdog does not count the reach's own connection.
  const wd = onHost(`conns=$(ss -Htn state established '( sport = :22 )' | wc -l); reaches=$(pgrep -c -f '^cast-reach :'); echo "$conns $reaches"`).out.trim().split(" ").map(Number);
  check("the watchdog's anchored pgrep counts the reach (one sshfs per folder)", wd[1] === 1, `conns=${wd[0]} reaches=${wd[1]}`);

  // 4. A dropped connection: offline note, writes refused, remount.
  for (const pid of laptopSshPids(folder)) process.kill(pid, "SIGKILL");
  check("the mount goes away when the laptop side drops", await until(() => !isMounted(folder), 20_000));
  check("while it is down the folder shows the offline note", onHost(`ls -A ${q}`).out.trim() === REACH_NOTE && onHost(`cat ${q}/${REACH_NOTE}`).out.includes("not connected"));
  const offlineWrite = onHost(`echo x > ${q}/offline.txt`);
  check("a write while it is down is refused", !offlineWrite.ok && /Permission denied/.test(offlineWrite.out), offlineWrite.out);
  const t1 = Date.now();
  check("the daemon remounts it", await until(() => isMounted(folder) && state(folder) === "mounted", 150_000, 2_000));
  console.log(`      (${Math.round((Date.now() - t1) / 1000)}s to remount)`);
  check("the remounted folder holds the laptop files again", onHost(`cat ${q}/from-laptop.txt`).out === "laptop edit\n");

  // 5. A frozen laptop (a sleep that left TCP half open): sshd's keepalive ends it.
  if (!skipHang) {
    const pids = laptopSshPids(folder);
    for (const pid of pids) process.kill(pid, "SIGSTOP");
    const t2 = Date.now();
    const gone = await until(() => !isMounted(folder), 150_000, 5_000);
    check("a frozen laptop's mount is dropped by the host's sshd keepalive", gone, `still mounted after ${Math.round((Date.now() - t2) / 1000)}s`);
    console.log(`      (${Math.round((Date.now() - t2) / 1000)}s to drop)`);
    for (const pid of pids) { try { process.kill(pid, "SIGCONT"); } catch { /* exited */ } }
    check("and the daemon remounts it after", await until(() => isMounted(folder) && state(folder) === "mounted", 180_000, 2_000));
  }

  // 6. Read-only.
  const ro = cast("hosts", "reach", cloud.id, folder, "--read-only");
  check("re-approving read-only remounts it", /mounted on the host/.test(ro.out) && /read-only/.test(ro.out), ro.out);
  check("read-only: reads work", onHost(`cat ${q}/todo.md`).out.includes("edited on host"));
  const roWrite = onHost(`echo x > ${q}/ro.txt`);
  check("read-only: writes fail on the host", !roWrite.ok && !fs.existsSync(path.join(folder, "ro.txt")), roWrite.out);

  // 7. A mountpoint the host already uses is refused, and nothing is touched there.
  fs.mkdirSync(occupied, { recursive: true });
  onHost(`sudo -n mkdir -p ${shq(occupied)} && sudo -n chown $(id -u) ${shq(occupied)} && echo host-owned > ${shq(occupied)}/keep.txt`);
  const occ = cast("hosts", "reach", cloud.id, occupied);
  check("an occupied mountpoint is refused with the reason", occ.code !== 0 && /already holds files/.test(occ.out), occ.out);
  check("the host's own file there is untouched", onHost(`cat ${shq(occupied)}/keep.txt`).out === "host-owned\n");
  onHost(`sudo -n rm -rf ${shq(occupied)}`);

  // 8. --off unmounts.
  const off = cast("hosts", "reach", cloud.id, folder, "--off");
  check("--off is accepted", off.code === 0, off.out);
  check("--off unmounts within seconds", await until(() => !isMounted(folder), 40_000));
  check("after --off the mountpoint and its note are gone from the host", await until(() => onHost(`[ -e ${q} ] && echo there || echo gone`).out.trim() === "gone", 30_000));
  check("the laptop folder is intact", fs.readFileSync(path.join(folder, "todo.md"), "utf-8").includes("edited on host"));
} finally {
  cleanup();
  onHost(`for d in ${shq(folder)} ${shq(occupied)}; do findmnt -n -M "$d" >/dev/null && fusermount3 -uz "$d"; [ -d "$d" ] && sudo -n rm -rf "$d"; done; true`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
