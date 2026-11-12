// Who may read the person's own Chrome, and that the web's daemon path reads as nobody's session.
import { describe, expect, test } from "bun:test";
import { sessionIdFromEnv } from "../sessionIdentity";
import { parseRunCommand } from "@codecast/shared/contracts/commandRun";
import { NO_SESSION_ENV, chromeReadRefusal, chromeSigninAsk, handleCaptureSigninCommand } from "./signinCommand";

describe("--from-chrome", () => {
  test("an agent session is refused; a person's terminal and the daemon's child are not", () => {
    const person = () => false;
    expect(chromeReadRefusal({ CLAUDE_CODE_SESSION_ID: "abc" }, person)).toContain("cast decide");
    expect(chromeReadRefusal({ CODEX_THREAD_ID: "t" }, person)).not.toBeNull();
    expect(chromeReadRefusal({}, person)).toBeNull();
    // An agent that cleared its session variables is still under its agent process.
    expect(chromeReadRefusal({}, () => true)).not.toBeNull();
    // The daemon blanks every session variable it may have inherited.
    expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: "abc", CODECAST_SESSION_ID: "x", ...NO_SESSION_ENV })).toBeNull();
  });

  test("an agent's --from-chrome becomes a Yes card that runs the same save as the person", () => {
    const ask = chromeSigninAsk("suno.com", { personal: true, name: "suno me" }, false);
    expect(ask.on).toBeUndefined();
    expect(parseRunCommand(ask.command)).toEqual({ argv: ["vault", "save-signin", "suno.com", "--from-chrome", "--name", "suno me", "--personal"] });
    expect(ask.question).toContain("for you");
    expect(chromeSigninAsk("suno.com", {}, true).on).toBe("laptop");
    expect(chromeSigninAsk("suno.com", { team: "t1" }, false).command).toBe("cast vault save-signin suno.com --from-chrome --team t1");
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
