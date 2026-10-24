import { describe, expect, test } from "bun:test";
import { autostartDisabledByEnv, daemonUnitFor, isTemplateInstance, supervisedBySystemdUnit } from "./systemdDaemonUnit";
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
    expect(daemonUnitFor(box, "root")).toBeNull();
  });
  test("a template instance starts with enable --now; the host's own unit with start", () => {
    expect(isTemplateInstance("codecast-daemon-user@jbtest2.service")).toBe(true);
    expect(isTemplateInstance("codecast-daemon.service")).toBe(false);
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

describe("supervisedBySystemdUnit", () => {
  test("a daemon a unit started exits to restart; one started by hand beside no unit spawns its replacement", () => {
    expect(supervisedBySystemdUnit({ INVOCATION_ID: "abc" }, () => "codecast-daemon.service")).toBe(true);
    expect(supervisedBySystemdUnit({}, () => "codecast-daemon.service")).toBe(false);
    // A terminal launched by a systemd user service carries INVOCATION_ID too: without a unit, nothing would bring it back.
    expect(supervisedBySystemdUnit({ INVOCATION_ID: "abc" }, () => null)).toBe(false);
  });
});

describe("the wanted file a shared box's user starts and stops their daemon with", () => {
  const { unitUsesWantedFlag, setDaemonWanted, daemonWantedPath } = require("./systemdDaemonUnit") as typeof import("./systemdDaemonUnit");
  const fsm = require("node:fs") as typeof import("node:fs");
  const osm = require("node:os") as typeof import("node:os");
  const pathm = require("node:path") as typeof import("node:path");
  const { userDaemonUnits } = require("./browser/sharedHost") as typeof import("./browser/sharedHost");

  test("only a unit that names the file is driven by it; an older hand-built unit keeps the sudo path", () => {
    const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "units-"));
    fsm.writeFileSync(pathm.join(dir, "codecast-daemon-user@.service"), userDaemonUnits().service);
    fsm.writeFileSync(pathm.join(dir, "old-daemon@.service"), "[Service]\nUser=%i\nExecStart=/home/%i/.local/bin/cast _daemon\n");
    expect(unitUsesWantedFlag("codecast-daemon-user@cam.service", dir)).toBe(true);
    expect(unitUsesWantedFlag("old-daemon@cam.service", dir)).toBe(false);
    fsm.rmSync(dir, { recursive: true, force: true });
  });

  test("start creates it 0600 in the person's own ~/.codecast; stop removes it", () => {
    const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "home-"));
    setDaemonWanted(true, home);
    expect((fsm.statSync(daemonWantedPath(home)).mode & 0o777).toString(8)).toBe("600");
    setDaemonWanted(false, home);
    expect(fsm.existsSync(daemonWantedPath(home))).toBe(false);
    fsm.rmSync(home, { recursive: true, force: true });
  });
});
