import { describe, expect, test } from "bun:test";
import { parseSimCapture, parseSimDevice, watchErrorStatus, watchExitStatus } from "../browserWatch";
import { browserRelayKey } from "../browserWatchRelay";
import { isSimulatorRoutePath, simulatorPanePath, simulatorPaneSession } from "../simulatorPane";

// The simulator pane rides the browser watch: these pin the parts that differ.

describe("simulator stream endings", () => {
  test("a session with no simulator can retry, and nothing offers a page to reopen", () => {
    expect(watchErrorStatus("no-sim", "")).toMatchObject({ message: "this session holds no simulator", canRetry: true, tabGone: false, waiting: true });
  });

  test("a machine with no simulators at all cannot be fixed by retrying, or by waiting", () => {
    const s = watchErrorStatus("no-simulators", "");
    expect(s).toMatchObject({ canRetry: false });
    expect("waiting" in s).toBe(false);
  });

  test("a browser stream's endings never wait", () => {
    expect("waiting" in watchExitStatus("tab-closed")).toBe(false);
  });

  test("a released or shut down device says which", () => {
    expect(watchExitStatus("sim-released")).toMatchObject({ message: "the session released its simulator", canRetry: true, waiting: true });
    expect(watchExitStatus("sim-not-booted")).toMatchObject({ message: "the session's simulator is shut down" });
    expect(watchErrorStatus("sim-not-booted", "")).toMatchObject({ message: "the session's simulator is shut down" });
  });
});

describe("browserRelayKey", () => {
  test("a simulator stream is its own relay row, named by the session uuid", () => {
    expect(browserRelayKey({ sessionUuid: "u1", tmuxSession: "cc-1", source: "sim" })).toBe("sim:u1");
    expect(browserRelayKey({ sessionUuid: "u1", tmuxSession: "cc-1" })).toBe("u1");
  });

  test("the simulator lock names sessions by uuid only, so a tmux name alone addresses nothing", () => {
    expect(browserRelayKey({ tmuxSession: "cc-1", source: "sim" })).toBeNull();
  });
});

describe("simulator pane path", () => {
  test("round-trips the session uuid", () => {
    const path = simulatorPanePath("218444ea-e74c-499f");
    expect(path).toBe("/simulator?s=218444ea-e74c-499f");
    expect(isSimulatorRoutePath(path)).toBe(true);
    expect(simulatorPaneSession(path)).toBe("218444ea-e74c-499f");
  });

  test("other routes and a missing session are not simulator panes", () => {
    expect(isSimulatorRoutePath("/simulators")).toBe(false);
    expect(simulatorPaneSession("/browser?s=x")).toBeNull();
    expect(simulatorPaneSession("/simulator")).toBeNull();
  });
});

describe("simulator device messages", () => {
  test("device state reads orientation and recording, and refuses a bad orientation", () => {
    expect(parseSimDevice({ orientation: 3, recording: { since: 5 }, canCapture: true })).toEqual({ orientation: 3, recording: { since: 5 }, canCapture: true });
    expect(parseSimDevice({ orientation: 1, recording: null })).toEqual({ orientation: 1, recording: null, canCapture: false });
    expect(parseSimDevice({ orientation: 7 })).toBeNull();
  });

  test("a capture is a whole file or an error, never half of one", () => {
    expect(parseSimCapture({ kind: "screenshot", mime: "image/png", name: "a.png", data: "AA==" })).toEqual({ kind: "screenshot", mime: "image/png", name: "a.png", data: "AA==" });
    expect(parseSimCapture({ kind: "video", error: "no" })).toEqual({ kind: "video", error: "no" });
    expect(parseSimCapture({ kind: "screenshot", mime: "image/png", data: "AA==" })).toBeNull();
    expect(parseSimCapture({ kind: "audio", error: "x" })).toBeNull();
  });
});
