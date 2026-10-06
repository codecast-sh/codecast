import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  joinListings,
  ownServerSession,
  paneOwnerEnv,
  paneOwnerId,
  routeTmuxArgs,
  sessionServerSockets,
  socketOfTmuxEnv,
  targetSession,
  tmuxSocketDir,
  withTmuxSession,
} from "./tmuxRoute.js";

let env: NodeJS.ProcessEnv;
beforeAll(() => {
  env = { TMUX_TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), "tmux-route-")), CODECAST_TMUX_PER_SESSION: "1" };
  fs.mkdirSync(tmuxSocketDir(env), { recursive: true });
  for (const s of ["default", "cast-cc-claude-own", "cast-cx-resume-two"]) fs.writeFileSync(path.join(tmuxSocketDir(env), s), "");
});
afterAll(() => fs.rmSync(env.TMUX_TMPDIR!, { recursive: true, force: true }));

describe("targetSession", () => {
  test("reads the session out of every target form", () => {
    expect(targetSession("cc-claude-own")).toBe("cc-claude-own");
    expect(targetSession("=cc-claude-own")).toBe("cc-claude-own");
    expect(targetSession("cc-claude-own:0.0")).toBe("cc-claude-own");
    expect(targetSession("=cc-claude-own:")).toBe("cc-claude-own");
  });
  test("an id names no session, and no target is undefined", () => {
    for (const id of ["%3", "$2", "@1", "=%3"]) expect(targetSession(id)).toBeNull();
    expect(targetSession(null)).toBeUndefined();
  });
});

describe("routeTmuxArgs", () => {
  test("a call naming a session with its own server reaches that server", () => {
    expect(routeTmuxArgs(["send-keys", "-t", "cc-claude-own:0.0", "Enter"], env, undefined)).toEqual([
      ["-L", "cast-cc-claude-own", "send-keys", "-t", "cc-claude-own:0.0", "Enter"],
    ]);
  });

  test("a session without one stays on the shared server", () => {
    expect(routeTmuxArgs(["has-session", "-t", "cc-claude-legacy"], env, undefined)).toEqual([["has-session", "-t", "cc-claude-legacy"]]);
  });

  test("a fleet listing asks the shared server and every session server", () => {
    expect(routeTmuxArgs(["list-sessions", "-F", "#{session_name}"], env, undefined)).toEqual([
      ["list-sessions", "-F", "#{session_name}"],
      ["-L", "cast-cc-claude-own", "list-sessions", "-F", "#{session_name}"],
      ["-L", "cast-cx-resume-two", "list-sessions", "-F", "#{session_name}"],
    ]);
    expect(routeTmuxArgs(["list-panes", "-a", "-F", "#{pane_id}"], env, undefined)).toHaveLength(3);
  });

  test("listing one session's panes is not a fleet listing", () => {
    expect(routeTmuxArgs(["list-panes", "-s", "-t", "cc-claude-own", "-F", "#{pane_id}"], env, undefined)).toEqual([
      ["-L", "cast-cc-claude-own", "list-panes", "-s", "-t", "cc-claude-own", "-F", "#{pane_id}"],
    ]);
  });

  // Ids repeat across servers: inside work for one session they, and any
  // fleet listing, stay on that session's server.
  test("in a session's scope, ids and listings reach only its server", () => {
    withTmuxSession("cc-claude-own", () => {
      expect(routeTmuxArgs(["kill-pane", "-t", "%0"], env)).toEqual([["-L", "cast-cc-claude-own", "kill-pane", "-t", "%0"]]);
      expect(routeTmuxArgs(["list-panes", "-a", "-F", "#{pane_id}"], env)).toEqual([["-L", "cast-cc-claude-own", "list-panes", "-a", "-F", "#{pane_id}"]]);
    });
  });

  test("an id outside any scope keeps meaning the current server", () => {
    expect(routeTmuxArgs(["display-message", "-p", "-t", "%4", "#{session_name}"], env, undefined)).toEqual([
      ["display-message", "-p", "-t", "%4", "#{session_name}"],
    ]);
  });

  test("from inside a session server's pane, the shared server is named outright", () => {
    const inPane = { ...env, TMUX: `${tmuxSocketDir(env)}/cast-cc-claude-own,123,0` };
    expect(routeTmuxArgs(["has-session", "-t", "cc-claude-legacy"], inPane, undefined)).toEqual([["-L", "default", "has-session", "-t", "cc-claude-legacy"]]);
    expect(routeTmuxArgs(["display-message", "-p", "#{session_name}"], inPane, undefined)).toEqual([["display-message", "-p", "#{session_name}"]]);
    expect(routeTmuxArgs(["list-sessions"], inPane, undefined)[0]).toEqual(["-L", "default", "list-sessions"]);
  });

  test("a call that already names its socket is left alone", () => {
    expect(routeTmuxArgs(["-S", "/x/sock", "list-panes", "-a"], env, undefined)).toEqual([["-S", "/x/sock", "list-panes", "-a"]]);
  });
});

describe("ownServerSession", () => {
  test("an agent session's new-session gets its own server when enabled", () => {
    expect(ownServerSession(["new-session", "-d", "-s", "cc-claude-abc", "-c", "/tmp"], env)).toBe("cc-claude-abc");
    expect(ownServerSession(["-N", "new-session", "-d", "-s", "wf-123"], env)).toBe("wf-123");
  });
  test("terminals, utility panes and a disabled switch keep the shared server", () => {
    expect(ownServerSession(["new-session", "-A", "-s", "cast-term-1"], env)).toBeNull();
    expect(ownServerSession(["new-session", "-d", "-s", "claude-login-flow"], env)).toBeNull();
    expect(ownServerSession(["new-session", "-d", "-s", "cc-claude-abc"], { ...env, CODECAST_TMUX_PER_SESSION: "0" })).toBeNull();
    expect(ownServerSession(["send-keys", "-t", "cc-claude-abc"], env)).toBeNull();
  });
});

describe("helpers", () => {
  test("sessionServerSockets lists only session servers", () => {
    expect(sessionServerSockets(env)).toEqual(["cast-cc-claude-own", "cast-cx-resume-two"]);
  });
  test("joinListings keeps one row per line whatever each server ended with", () => {
    expect(joinListings(["a\nb\n", "", "c", "d\n\n"])).toBe("a\nb\nc\nd\n");
    expect(joinListings(["", ""])).toBe("");
  });
  test("a pane's identity names its server unless it is the shared one, and maps back", () => {
    expect(socketOfTmuxEnv(undefined)).toBe("default");
    expect(socketOfTmuxEnv("/private/tmp/tmux-501/default,1,0")).toBe("default");
    expect(socketOfTmuxEnv("/private/tmp/tmux-501/cast-cc-x,1,0")).toBe("cast-cc-x");
    expect(paneOwnerId("%3", "default")).toBe("%3");
    expect(paneOwnerId("%3", "cast-cc-x")).toBe("%3@cast-cc-x");
    expect(paneOwnerEnv("%3", env)).toEqual({ TMUX_PANE: "%3" });
    const own = paneOwnerEnv("%3@cast-cc-x", env);
    expect(own.TMUX_PANE).toBe("%3");
    expect(paneOwnerId(own.TMUX_PANE, socketOfTmuxEnv(own.TMUX))).toBe("%3@cast-cc-x");
  });
});
