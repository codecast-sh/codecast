/**
 * The sentinel's pure policy: bounce exactly the unprovoked machine raise —
 * never the human's own Chrome, never a raise someone asked for, never a
 * window the human clicked into.
 */

import { describe, expect, test } from "bun:test";
import {
  DELIBERATE_RAISE_GRACE_MS,
  HUMAN_APP_SWITCH_GRACE_MS,
  HUMAN_CLICK_GRACE_S,
  isAppSwitchChord,
  isAgentChromeCommand,
  shouldRestoreFocus,
  stampAt,
} from "./focusSentinel.js";

describe("isAgentChromeCommand", () => {
  const managed =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=52523 --user-data-dir=/Users/x/.codecast/browser/profiles/default about:blank";
  const rig =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9721 --user-data-dir=/tmp/rig/profA --use-fake-device-for-media-stream";
  const humans = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const headless =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=39700 --user-data-dir=/tmp/ws/chrome-profile --headless=new";

  test("the managed clone and a scratch rig Chrome are agent-driven", () => {
    expect(isAgentChromeCommand(managed)).toBe(true);
    expect(isAgentChromeCommand(rig)).toBe(true);
  });

  test("the human's real Chrome is not", () => {
    expect(isAgentChromeCommand(humans)).toBe(false);
  });

  test("a headless Chrome cannot steal focus and is left alone", () => {
    expect(isAgentChromeCommand(headless)).toBe(false);
  });

  test("a non-Chrome app is not", () => {
    expect(isAgentChromeCommand("/Applications/Codecast.app/Contents/MacOS/Codecast")).toBe(false);
  });
});

describe("shouldRestoreFocus", () => {
  const steal = {
    agentChrome: true,
    msSinceDeliberateRaise: DELIBERATE_RAISE_GRACE_MS * 10,
    msSinceAppSwitch: HUMAN_APP_SWITCH_GRACE_MS * 10,
    secondsSinceClick: HUMAN_CLICK_GRACE_S * 100,
  };

  test("an unprovoked raise by an agent Chrome is bounced", () => {
    expect(shouldRestoreFocus(steal)).toBe(true);
  });

  test("a non-agent app in front is never touched", () => {
    expect(shouldRestoreFocus({ ...steal, agentChrome: false })).toBe(false);
  });

  test("a recent keyboard app switch means the human did it — spared", () => {
    expect(shouldRestoreFocus({ ...steal, msSinceAppSwitch: 50 })).toBe(false);
    expect(shouldRestoreFocus({ ...steal, msSinceAppSwitch: HUMAN_APP_SWITCH_GRACE_MS })).toBe(false);
    expect(shouldRestoreFocus({ ...steal, msSinceAppSwitch: HUMAN_APP_SWITCH_GRACE_MS + 1 })).toBe(true);
  });

  test("a deliberate raise (login, web open-tab) is spared for the grace window", () => {
    expect(shouldRestoreFocus({ ...steal, msSinceDeliberateRaise: 1_000 })).toBe(false);
    expect(shouldRestoreFocus({ ...steal, msSinceDeliberateRaise: DELIBERATE_RAISE_GRACE_MS - 1 })).toBe(false);
    expect(shouldRestoreFocus({ ...steal, msSinceDeliberateRaise: DELIBERATE_RAISE_GRACE_MS + 1 })).toBe(true);
  });

  test("a recent mouse click means the human did it — spared", () => {
    expect(shouldRestoreFocus({ ...steal, secondsSinceClick: 0.3 })).toBe(false);
    expect(shouldRestoreFocus({ ...steal, secondsSinceClick: HUMAN_CLICK_GRACE_S })).toBe(false);
    expect(shouldRestoreFocus({ ...steal, secondsSinceClick: HUMAN_CLICK_GRACE_S + 0.5 })).toBe(true);
  });
});

describe("isAppSwitchChord", () => {
  test("recognizes Command-Tab and Option-Tab only while Tab is down", () => {
    expect(isAppSwitchChord(true, 1n << 20n)).toBe(true);
    expect(isAppSwitchChord(true, 1n << 19n)).toBe(true);
    expect(isAppSwitchChord(false, 1n << 20n)).toBe(false);
    expect(isAppSwitchChord(true, 1n << 18n)).toBe(false);
  });
});

/** The stamps a CLI process leaves for the sentinel: `loginRaisedAt` from
 *  `cast browser login`, `computerRaisedAt` from `cast computer
 *  --restore-window`. Neither runs in the daemon, so neither can call
 *  noteDeliberateRaise. */
describe("stampAt", () => {
  test("passes a real stamp through", () => {
    const now = Date.now();
    expect(stampAt(now)).toBe(now);
    expect(stampAt(now - DELIBERATE_RAISE_GRACE_MS * 10)).toBe(now - DELIBERATE_RAISE_GRACE_MS * 10);
  });

  test("a missing or malformed field reads as no stamp", () => {
    for (const value of [undefined, null, "1788800000000", NaN, Infinity, -1, {}]) {
      expect(stampAt(value)).toBe(0);
    }
  });

  test("a stamp from the future reads as no stamp", () => {
    // Left alone, a future stamp makes `now - stamp` negative, which is under
    // every grace — the sentinel would go quietly dead for agent-Chrome raises
    // and never bounce one again.
    expect(stampAt(Date.now() + 60_000)).toBe(0);
    // A small skew between two writers is not a future stamp.
    const nearly = Date.now() + 1_000;
    expect(stampAt(nearly)).toBe(nearly);
  });

  test("a stale stamp still reads as a stamp; the grace is what expires it", () => {
    const old = Date.now() - DELIBERATE_RAISE_GRACE_MS - 1;
    expect(stampAt(old)).toBe(old);
    expect(
      shouldRestoreFocus({ agentChrome: true, msSinceDeliberateRaise: Date.now() - old, msSinceAppSwitch: 60_000, secondsSinceClick: 60 }),
    ).toBe(true);
  });
});
