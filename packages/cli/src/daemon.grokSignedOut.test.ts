import { describe, expect, test } from "bun:test";
import { agentAtLoginScreen, classifyLivePaneFor } from "./tmuxPaneState.js";
import { inputGuard } from "./daemon.js";

// grok 1.0.88 after xAI revoked its refresh token: it empties ~/.grok/auth.json
// and draws a device-code sign-in. Captured from jx71x5f (2026-11-18), where the
// daemon read it as an unknown pane and retried a message for minutes.
const SIGNED_OUT = `
                                                     ⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀
                                                     ⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀
                                  Approve in your browser to finish signing in.
                                                    DBHE-S5FR
                                     Make sure your browser shows this code.
                                            Click to copy sign-in URL
                                                  Show full URL
                                              Waiting for approval…
                                                  ctrl+q  quit`;

describe("grok at its login screen", () => {
  test("reads as grok signed out", () => {
    expect(agentAtLoginScreen(SIGNED_OUT)).toBe("grok");
    expect(classifyLivePaneFor("grok", SIGNED_OUT)).toBe("signed_out");
  });

  test("delivery holds with grok's login step", async () => {
    let caught: any;
    try { await inputGuard(async () => SIGNED_OUT)(); } catch (err) { caught = err; }
    expect(caught?.holdReason).toContain("grok login");
  });
});
