// Who may read the person's own Chrome, and that the web's daemon path reads as nobody's session.
import { describe, expect, test } from "bun:test";
import { sessionIdFromEnv } from "../sessionIdentity";
import { NO_SESSION_ENV, chromeReadRefusal, handleCaptureSigninCommand } from "./signinCommand";

describe("--from-chrome", () => {
  test("an agent session is refused; a person's terminal and the daemon's child are not", () => {
    expect(chromeReadRefusal({ CLAUDE_CODE_SESSION_ID: "abc" })).toContain("Save sign-in on the Vault page");
    expect(chromeReadRefusal({ CODEX_THREAD_ID: "t" })).not.toBeNull();
    expect(chromeReadRefusal({})).toBeNull();
    // The daemon blanks every session variable it may have inherited.
    expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: "abc", CODECAST_SESSION_ID: "x", ...NO_SESSION_ENV })).toBeNull();
  });

  test("the daemon runs the capture with the session variables blanked", async () => {
    let env: Record<string, string> | undefined;
    await handleCaptureSigninCommand(JSON.stringify({ site: "github.com", personal: true }), {
      isRemoteDevice: () => false,
      runCastCommand: async (_args, opts) => {
        env = opts.env;
        return { code: 0, stdout: JSON.stringify({ ok: true, action: "created", short_id: "sec-1", cookies: 2 }), stderr: "" };
      },
      log: () => {},
      childErrorDetail: () => "",
    });
    expect(env).toEqual(NO_SESSION_ENV);
  });
});
