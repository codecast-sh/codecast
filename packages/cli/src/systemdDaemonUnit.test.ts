import { describe, expect, test } from "bun:test";
import { autostartDisabledByEnv, daemonUnitFor } from "./systemdDaemonUnit";
import { ownDaemonPids, type ProcRow } from "./processTable";

const unit = (user: string, exec = "/usr/local/bin/cast _daemon") => `[Service]\nUser=${user}\nExecStart=${exec}\nRestart=always\n`;

describe("daemonUnitFor — the system unit running THIS user's daemon", () => {
  const box = [
    { name: "codecast-daemon.service", content: unit("ubuntu") },
    { name: "codecast-daemon-user@.service", content: unit("%i") },
    { name: "nginx.service", content: "[Service]\nUser=www-data\nExecStart=/usr/sbin/nginx\n" },
  ];
  test("the host's own unit for its user, a template instance for everyone else", () => {
    expect(daemonUnitFor(box, "ubuntu")).toBe("codecast-daemon.service");
    expect(daemonUnitFor(box, "jbtest2")).toBe("codecast-daemon-user@jbtest2.service");
  });
  test("another user's unit is never ours; no daemon unit means none", () => {
    expect(daemonUnitFor([box[0]!], "jbtest2")).toBeNull();
    expect(daemonUnitFor([box[2]!, { name: "x.service", content: unit("jbtest2", "/usr/bin/cast hosts ls") }], "jbtest2")).toBeNull();
  });
});

test("CODECAST_NO_AUTOSTART turns autostart off", () => {
  expect(autostartDisabledByEnv({ CODECAST_NO_AUTOSTART: "1" })).toBe(true);
  expect(autostartDisabledByEnv({ CODECAST_NO_AUTOSTART: "true" })).toBe(true);
  expect(autostartDisabledByEnv({})).toBe(false);
});

test("ownDaemonPids: cast stop stops this user's daemons, never another person's on a shared box", () => {
  const rows: ProcRow[] = [
    { pid: 10, ppid: 1, uid: 1000, command: "/home/ubuntu/.local/bin/cast _daemon" },
    { pid: 11, ppid: 1, uid: 1005, command: "/home/jbtest2/.local/bin/cast _daemon" },
    { pid: 12, ppid: 1, uid: 1005, command: "/home/jbtest2/.local/bin/cast feed" },
    { pid: 13, ppid: 1, uid: 1005, command: "/home/jbtest2/.local/bin/cast _daemon" },
  ] as ProcRow[];
  expect(ownDaemonPids(rows, 13, 1005)).toEqual([11]);
});
