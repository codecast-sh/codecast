import { describe, expect, it } from "bun:test";
import { popOutVia, type PopOutRungs } from "../popOut";

// Popping a surface out lands on a different rung on every build in the wild.
// The one outcome that must never happen is the one the founder got: a browser
// window out of the desktop app because the newest verb was missing.

const ROUTE = "/people";

function rungs(over: Partial<PopOutRungs> = {}): PopOutRungs {
  return { openPopup: () => true, desktop: false, ...over };
}

describe("popOutVia", () => {
  it("uses the shell's own window when the build has one", async () => {
    const calls: string[] = [];
    const outcome = await popOutVia(
      ROUTE,
      rungs({
        desktop: true,
        shellOpen: async () => void calls.push("shell"),
        detach: async () => void calls.push("detach"),
        openPopup: () => (calls.push("popup"), true),
      }),
    );
    expect(outcome).toBe("shell");
    expect(calls).toEqual(["shell"]);
  });

  it("detaches the route on an older build that never heard of the window", async () => {
    const detached: string[] = [];
    const outcome = await popOutVia(
      ROUTE,
      rungs({
        desktop: true,
        detach: async (p) => void detached.push(p),
        openPopup: () => (detached.push("popup"), true),
      }),
    );
    expect(outcome).toBe("detached");
    // A REAL window at the route asked for, and no browser popup behind it.
    expect(detached).toEqual([ROUTE]);
  });

  it("says the app is old rather than opening a browser window inside it", async () => {
    let popped = false;
    const outcome = await popOutVia(
      ROUTE,
      rungs({ desktop: true, openPopup: () => ((popped = true), true) }),
    );
    expect(outcome).toBe("needs-update");
    expect(popped).toBe(false);
  });

  it("pops a browser window when there is no shell at all", async () => {
    expect(await popOutVia(ROUTE, rungs())).toBe("popup");
  });

  it("reports a popup a blocker ate", async () => {
    expect(await popOutVia(ROUTE, rungs({ openPopup: () => false }))).toBe("blocked");
  });
});
