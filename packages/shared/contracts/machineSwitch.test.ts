import { describe, expect, test } from "bun:test";
import {
  MACHINE_MOVE_NOTICE_PREFIX,
  MACHINE_SWITCH_NOTICE_PREFIX,
  formatMachineSwitchNotice,
  isMachineSwitchNotice,
  parseMachineSwitchNotice,
} from "./machineSwitch";

describe("machine switch notice", () => {
  test("formats a box switch with a was-clause", () => {
    const body = formatMachineSwitchNotice({
      toLabel: "Cloud Linux",
      fromLabel: "MacBook-Pro-168",
    });
    expect(body.startsWith(`${MACHINE_SWITCH_NOTICE_PREFIX} Cloud Linux (was MacBook-Pro-168).`)).toBe(true);
    expect(isMachineSwitchNotice(body)).toBe(true);
    expect(parseMachineSwitchNotice(body)).toEqual({
      toLabel: "Cloud Linux",
      fromLabel: "MacBook-Pro-168",
      machineChanged: true,
    });
  });

  test("a same-name notice has no was-clause", () => {
    const body = formatMachineSwitchNotice({
      toLabel: "Cloud Linux",
      fromLabel: "Cloud Linux",
    });
    expect(parseMachineSwitchNotice(body)).toEqual({
      toLabel: "Cloud Linux",
      machineChanged: true,
    });
  });

  test("rejects ordinary user text", () => {
    expect(isMachineSwitchNotice("please move this to the cloud box")).toBe(false);
    expect(parseMachineSwitchNotice("please move this to the cloud box")).toBeNull();
  });
});

describe("daemon reorientation notice", () => {
  test("classifies the long machine-move line as a switch", () => {
    const body =
      `${MACHINE_MOVE_NOTICE_PREFIX} to a different machine. It now runs on Cloud Linux in /home/ubuntu/work/codecast (previously /Users/ashot/src/codecast).`;
    expect(isMachineSwitchNotice(body)).toBe(true);
    expect(parseMachineSwitchNotice(body)).toEqual({
      toLabel: "Cloud Linux",
      machineChanged: true,
    });
  });

  test("a directory-only move is not a machine change", () => {
    const body =
      `${MACHINE_MOVE_NOTICE_PREFIX} to a different directory: it now runs in /repo/b (previously /repo/a).`;
    expect(parseMachineSwitchNotice(body)).toEqual({
      toLabel: "another directory",
      machineChanged: false,
    });
  });
});
