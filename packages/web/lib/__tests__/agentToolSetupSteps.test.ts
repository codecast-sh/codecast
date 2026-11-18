import { describe, expect, test } from "bun:test";
import { agentSetupSteps, readThisProfileExtension, withThisProfile } from "../agentToolSetupSteps";

const browser = (s: Partial<{ installed: boolean; paired: boolean; connected: boolean }>) =>
  agentSetupSteps("browser", { tool: "browser", paired: false, connected: false, chrome_running: true, ...s });

describe("agentSetupSteps", () => {
  test("not installed: the install link is the step, and there is no Pair to press", () => {
    const [install, pair] = browser({ installed: false });
    expect(install.done).toBe(false);
    expect(install.action && "href" in install.action).toBe(true);
    expect(pair.action).toBeUndefined();
  });

  test("installed but unpaired: install is done and Pair starts on the machine", () => {
    const [install, pair] = browser({ installed: true });
    expect(install.done).toBe(true);
    expect(pair.done).toBe(false);
    expect(pair.action && "start" in pair.action).toBe(true);
  });

  test("a daemon without the installed field falls back to whether it ever paired", () => {
    expect(browser({ paired: true })[0].done).toBe(true);
    expect(browser({})[0].done).toBe(false);
    expect(browser({})[1].action).toBeDefined();
  });

  test("computer: Screen Recording waits for Accessibility", () => {
    const [ax, sr] = agentSetupSteps("computer", { tool: "computer", ready: false, accessibility: false, screen_recording: false, supported: true });
    expect(ax.action).toBeDefined();
    expect(sr.action).toBeUndefined();
  });
});

describe("the setup page in one Chrome profile", () => {
  const machine = { tool: "browser" as const, ready: true, installed: true, paired: true, connected: true, chrome_running: true };

  // Ashot's case (2026-11-18): Default was connected, the page in a second
  // profile said Ready while that profile's popup said Not paired.
  test("this profile's unpaired extension overrides a machine that is connected elsewhere", () => {
    const s = withThisProfile(machine, readThisProfileExtension(JSON.stringify({ state: "no-config", connected: false })));
    expect(s?.ready).toBe(false);
    expect(agentSetupSteps("browser", s)[1]).toMatchObject({ done: false, action: { label: "Pair", start: true } });
  });

  test("a connected profile is ready", () => {
    expect(withThisProfile(machine, { state: "connected", connected: true })?.ready).toBe(true);
  });

  test("without a note from this profile the machine's answer stands", () => {
    expect(withThisProfile(machine, readThisProfileExtension(undefined))).toBe(machine);
    expect(readThisProfileExtension("not json")).toBeNull();
  });
});
