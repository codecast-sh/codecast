import { describe, expect, test } from "bun:test";
import {
  missingTabMessage,
  watchErrorStatus,
  watchExitStatus,
  watchUnreachableStatus,
} from "../browserWatch";

// Every way a stream can stop, and what the viewer is told about it. The two
// hosts (the conversation dock and the stage pane) draw completely different
// chrome from these, and both decide what to OFFER from the flags — a retry
// button on a foreign machine, or a reopen where there is no page to reopen,
// is a click that cannot work. So the flags are pinned here, not just the
// wording.

describe("watchExitStatus", () => {
  test("a closed tab is retryable AND reopenable — the page is known", () => {
    expect(watchExitStatus("tab-closed")).toEqual({
      kind: "failed",
      message: "the agent's browser tab was closed",
      canRetry: true,
      tabGone: true,
      capped: false,
    });
  });

  test("a stopped browser is the same offer: reopening starts one", () => {
    const s = watchExitStatus("browser-closed");
    expect(s).toMatchObject({ kind: "failed", tabGone: true, canRetry: true });
  });

  test("the daemon's 30 minute cap is not a fault, and says so", () => {
    const s = watchExitStatus("timeout");
    // `capped` is what turns the button from "Reconnect" into "Resume".
    expect(s).toMatchObject({ capped: true, canRetry: true, tabGone: false });
    expect((s as { message: string }).message).toContain("30 minutes");
  });

  test("an ending nobody named still ends honestly", () => {
    expect(watchExitStatus("closed")).toMatchObject({
      message: "stream ended",
      canRetry: true,
      tabGone: false,
    });
  });
});

describe("watchErrorStatus", () => {
  test("no tab and no browser are the reopenable pair", () => {
    expect(watchErrorStatus("no-tab", "")).toMatchObject({ tabGone: true });
    expect(watchErrorStatus("no-browser", "")).toMatchObject({ tabGone: true });
  });

  test("a refused stream is about the endpoint, not the tab", () => {
    expect(watchErrorStatus("forbidden", "")).toMatchObject({ tabGone: false, canRetry: true });
  });

  test("an unknown code passes the daemon's own words through", () => {
    expect(watchErrorStatus("weird", "the socket melted")).toMatchObject({
      message: "the socket melted",
    });
    // …and still says something when the daemon said nothing.
    expect(watchErrorStatus("weird", "")).toMatchObject({ message: "could not open the stream" });
  });
});

describe("watchUnreachableStatus", () => {
  test("someone else's machine: name it, and offer nothing", () => {
    const s = watchUnreachableStatus({ foreign: true, machineName: "ada-mbp", hasDevice: true });
    expect(s).toMatchObject({ canRetry: false, tabGone: false });
    expect((s as { message: string }).message).toContain("ada-mbp");
  });

  test("an unnamed foreign machine is still a full stop", () => {
    const s = watchUnreachableStatus({ foreign: false, machineName: null, hasDevice: false });
    expect(s).toMatchObject({ canRetry: true });
    expect((s as { message: string }).message).toContain("cast running on this machine");
  });

  test("another machine of yours: say which one, and where watching works", () => {
    const s = watchUnreachableStatus({ foreign: false, machineName: "mac-mini", hasDevice: true });
    expect((s as { message: string }).message).toContain("mac-mini");
    expect(s).toMatchObject({ canRetry: true });
  });
});

describe("missingTabMessage", () => {
  test("names the session and its last page", () => {
    expect(missingTabMessage("Fix the auth race", "https://example.com/login")).toBe(
      "Fix the auth race has no browser tab open right now. Its last page was https://example.com/login.",
    );
  });

  test("no title and no page still reads as a sentence", () => {
    expect(missingTabMessage(null, null)).toBe("This session has no browser tab open right now.");
    expect(missingTabMessage("   ", null)).toBe("This session has no browser tab open right now.");
  });
});
