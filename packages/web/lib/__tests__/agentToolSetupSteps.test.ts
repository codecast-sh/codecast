import { describe, expect, test } from "bun:test";
import { agentSetupSteps } from "../agentToolSetupSteps";

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
