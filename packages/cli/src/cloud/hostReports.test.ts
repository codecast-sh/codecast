import { describe, expect, test } from "bun:test";
import { HostReports, hostActionArgs } from "./hostReports.js";

const report = (over: object = {}) => ({ managed_by: "lap", instance_id: "i-1", provider: "aws", state: "running", images: [], logins_held: [], at: 1, ...over });

function rig(actionCode = 0) {
  const sent: any[] = [];
  const calls: string[][] = [];
  const r = new HostReports({
    runCast: async (args) => {
      calls.push(args);
      if (args[1] === "report") return { code: 0, stdout: `noise\n${JSON.stringify([{ host_device_id: "dev-h", report: report() }])}`, stderr: "" };
      return { code: actionCode, stdout: actionCode ? "" : "woke i-1", stderr: actionCode ? "\x1b[31mAccess denied\x1b[0m" : "" };
    },
    report: async (id, rep) => { sent.push({ id, rep }); },
    hostIdForDevice: (id) => (id === "dev-h" ? "i-1" : null),
    log: () => {},
  });
  return { r, sent, calls };
}

describe("HostReports", () => {
  test("a successful action runs the child and folds its outcome into the next report", async () => {
    const { r, sent, calls } = rig();
    await r.act({ host_device_id: "dev-h", action: "wake" });
    // With no report yet, a pass starts beside the action so "running" reaches the web.
    expect(calls).toContainEqual(["hosts", "wake", "i-1"]);
    expect(sent.at(-1).rep.last_action).toMatchObject({ action: "wake", status: "ok", detail: "woke i-1" });
  });

  test("a failed action reports failed with the child's last line, colors stripped, and throws", async () => {
    const { r, sent } = rig(1);
    await expect(r.act({ host_device_id: "dev-h", action: "sleep" })).rejects.toThrow("Access denied");
    expect(sent.at(-1).rep.last_action).toMatchObject({ action: "sleep", status: "failed", detail: "Access denied" });
  });

  test("a wake reports running before the boot ends, on the last report it has", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const sent: any[] = [];
    const r = new HostReports({
      runCast: async (args) => {
        if (args[1] === "report") return { code: 0, stdout: JSON.stringify([{ host_device_id: "dev-h", report: report() }]), stderr: "" };
        await gate;
        return { code: 0, stdout: "up", stderr: "" };
      },
      report: async (id, rep) => { sent.push({ id, rep }); },
      hostIdForDevice: () => "i-1",
      log: () => {},
    });
    await r.refresh();
    const done = r.run("dev-h", "wake", ["cloud", "wake", "i-1"], 1000);
    await Promise.resolve();
    expect(sent.at(-1).rep.last_action).toMatchObject({ action: "wake", status: "running" });
    release();
    expect(await done).toMatchObject({ ok: true, tail: "up" });
    expect(sent.at(-1).rep.last_action).toMatchObject({ action: "wake", status: "ok" });
  });

  test("a host this laptop does not manage is refused", async () => {
    const { r, calls } = rig();
    await expect(r.act({ host_device_id: "other", action: "wake" })).rejects.toThrow("does not manage");
    expect(calls).toHaveLength(0);
  });

  test("image deletion needs a well-formed image id", () => {
    expect(hostActionArgs("delete_image", "i-1", "ami-0abc")).toEqual(["hosts", "image", "i-1", "--delete", "ami-0abc"]);
    expect(() => hostActionArgs("delete_image", "i-1", "; rm -rf /")).toThrow();
    expect(hostActionArgs("setup", "i-1")).toEqual(["hosts", "setup", "i-1", "--force"]);
  });
});
