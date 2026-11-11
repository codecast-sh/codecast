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

  test("a wake's phases reach the host's row as they pass, throttled, and stay out of the outcome", async () => {
    const sent: any[] = [];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const r = new HostReports({
      runCast: async (args, opts) => {
        if (args[1] === "report") return { code: 0, stdout: JSON.stringify([{ host_device_id: "dev-h", report: report() }]), stderr: "" };
        const say = (l: string) => opts?.onStdoutLine?.(l);
        say("  starting i-1"); say("::wake-phase booting"); say("::wake-phase running");
        await wait(80);
        say("::wake-phase ssh_wait");
        await wait(80);
        say("::wake-phase not_a_phase");
        return { code: 0, stdout: "::wake-phase booting\n{\"host\":\"i-1\"}", stderr: "" };
      },
      report: async (id, rep) => { sent.push(structuredClone(rep.last_action)); },
      hostIdForDevice: () => "i-1",
      log: () => {},
      phaseReportMinMs: 50,
    });
    await r.refresh();
    sent.length = 0;
    const out = await r.run("dev-h", "wake", ["cloud", "wake", "i-1"], 5000);
    const details = sent.filter((a) => a?.status === "running").map((a) => a.detail);
    // The start goes out bare; booting and running land in one window, so only running is sent; then ssh_wait.
    expect(details).toEqual([undefined, "running", "ssh_wait"]);
    expect(sent.at(-1)).toMatchObject({ status: "ok", detail: '{"host":"i-1"}' });
    expect(out.tail).toBe('{"host":"i-1"}');
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
