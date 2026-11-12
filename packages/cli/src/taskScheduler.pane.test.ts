import { describe, it, expect, spyOn } from "bun:test";
import { paneChildren, runPaneFinished } from "./taskScheduler.js";

// Whether a trigger run's tmux pane still has a live agent in it. Split out of
// taskScheduler.test.ts for its max-lines cap.
describe("runPaneFinished", () => {
  it("a pane whose shell has no children is finished; a missing session is finished; a live child is not", async () => {
    const tmux = await import("./tmux.js");
    const live = spyOn(tmux, "tmuxRunAsync").mockResolvedValue({ status: 0, stdout: "4242\n", stderr: "" });
    expect(await runPaneFinished("ct-claude-x", async () => "")).toBe(true);
    expect(await runPaneFinished("ct-claude-x", async () => "4300\n")).toBe(false);
    live.mockResolvedValue({ status: 1, stdout: "", stderr: "can't find session: ct-claude-x", code: 1 } as any);
    expect(await runPaneFinished("ct-claude-x", async () => "")).toBe(true);
    live.mockResolvedValue({ status: null, stdout: "", stderr: "", killed: true } as any);
    expect(await runPaneFinished("ct-claude-x", async () => "")).toBe(false);
    live.mockRestore();
  });

  it("pgrep's no-match is no children; a timeout, a kill or a failed spawn is unknown", async () => {
    const fail = (e: object) => async () => { throw Object.assign(new Error("pgrep"), e); };
    expect(await paneChildren("1", async () => ({ stdout: "4300\n" }))).toBe("4300\n");
    expect(await paneChildren("1", fail({ code: 1 }))).toBe("");
    expect(await paneChildren("1", fail({ killed: true, signal: "SIGTERM" }))).toBeNull();
    expect(await paneChildren("1", fail({ code: 127 }))).toBeNull();
    expect(await paneChildren("1", fail({ code: "EAGAIN" }))).toBeNull();
  });

  it("a child probe that cannot answer (pgrep timed out or failed to fork under load) is not a finished run", async () => {
    const tmux = await import("./tmux.js");
    const live = spyOn(tmux, "tmuxRunAsync").mockResolvedValue({ status: 0, stdout: "4242\n", stderr: "" });
    expect(await runPaneFinished("ct-claude-x", async () => null)).toBe(false);
    live.mockRestore();
  });

  it("the default probe answers for a real process: its children, none, or an unknown pid", async () => {
    const tmux = await import("./tmux.js");
    const { spawn } = await import("node:child_process");
    const parent = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { stdio: "ignore" });
    const idle = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      // Under load the shell forks its child late: wait until it exists.
      for (let i = 0; i < 100 && !(await paneChildren(String(parent.pid)))?.trim(); i++) await new Promise((r) => setTimeout(r, 100));
      const pane = spyOn(tmux, "tmuxRunAsync").mockResolvedValue({ status: 0, stdout: `${parent.pid}\n`, stderr: "" });
      expect(await runPaneFinished("ct-claude-x")).toBe(false);
      pane.mockResolvedValue({ status: 0, stdout: `${idle.pid}\n`, stderr: "" });
      expect(await runPaneFinished("ct-claude-x")).toBe(true);
      pane.mockRestore();
    } finally {
      parent.kill("SIGKILL");
      idle.kill("SIGKILL");
    }
  }, 60_000);
});
