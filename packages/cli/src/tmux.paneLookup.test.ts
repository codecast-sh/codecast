// Finding the pane an agent lives in, for `cast restart <session> --tmux`.
//
// Two contracts, both learned the hard way:
//
// 1. The separator between format fields must be PRINTABLE. tmux rewrites
//    control characters in `-F` output to `_`, so a tab-separated row comes
//    back welded into one string and every lookup silently misses.
// 2. Attach to the pane the restart CREATED, never to the one it is about to
//    kill. The resume rebuilds the pane under the same name, so only the
//    creation time can tell the new pane from the old.

import { describe, expect, test } from "bun:test";
import { parseCodecastPaneRows, pickPaneForSession } from "./tmux.js";
import { resumeShortId, resumeTmuxName, upgradedLegacyResumeTmuxName } from "./resumeCommand.js";

const SESSION = "58f3cdd1-4027-4850-be9f-d5039fbf2055";
const SUFFIX = `-${resumeShortId(SESSION)}`;

/** One row as tmux emits it: stamp | created | name. */
function row(name: string, sessionId = "", created: string | number = ""): string {
  return `${sessionId}|${created}|${name}`;
}
function rows(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

describe("parseCodecastPaneRows", () => {
  test("reads stamp, creation time and name", () => {
    const panes = parseCodecastPaneRows(rows(row("cc-claude-nr0bqx", SESSION, 1786564893)));
    expect(panes).toEqual([{ tmux: "cc-claude-nr0bqx", sessionId: SESSION, createdSec: 1786564893 }]);
  });

  test("an unstamped pane parses with a null stamp, not an empty string", () => {
    const panes = parseCodecastPaneRows(rows(row("cc-claude-yyp2fz", "", 1786561734)));
    expect(panes[0].sessionId).toBeNull();
  });

  test("a separator inside the name is part of the name", () => {
    const panes = parseCodecastPaneRows(rows(row("my|odd|name", SESSION, 100)));
    expect(panes[0].tmux).toBe("my|odd|name");
    expect(panes[0].sessionId).toBe(SESSION);
  });

  test("a tmux too old to expand the stamp reads as no stamp, not as a session id", () => {
    const panes = parseCodecastPaneRows(rows(row("cc-resume-old-58f3cdd1", "#{@codecast_session_id}", 100)));
    expect(panes[0]).toEqual({ tmux: "cc-resume-old-58f3cdd1", sessionId: null, createdSec: 100 });
  });

  test("blank lines are skipped", () => {
    expect(parseCodecastPaneRows("\n\n")).toEqual([]);
  });
});

describe("pickPaneForSession", () => {
  test("the stamp wins over the name", () => {
    const panes = parseCodecastPaneRows(rows(
      row("cc-resume-something-else", "", 100),
      row("cc-claude-nr0bqx", SESSION, 100),
    ));
    expect(pickPaneForSession(panes, SESSION, SUFFIX)).toBe("cc-claude-nr0bqx");
  });

  test("falls back to the resume name when nothing carries the stamp", () => {
    const name = resumeTmuxName("claude", SESSION, "my-title");
    const panes = parseCodecastPaneRows(rows(row(name, "", 100)));
    expect(pickPaneForSession(panes, SESSION, SUFFIX)).toBe(name);
  });

  test("a pane stamped for another session is never taken, whatever it is called", () => {
    const name = resumeTmuxName("claude", SESSION, "my-title");
    const panes = parseCodecastPaneRows(rows(row(name, "someone-elses-session", 100)));
    expect(pickPaneForSession(panes, SESSION, SUFFIX)).toBeNull();
  });

  test("skips the pre-restart pane and takes the one the resume created", () => {
    const panes = parseCodecastPaneRows(rows(
      row("cc-resume-title-58f3cdd1", SESSION, 100),   // the pane about to be killed
      row("cc-resume-title-58f3cdd1b", SESSION, 500),  // the one the resume brought up
    ));
    expect(pickPaneForSession(panes, SESSION, SUFFIX, 400)).toBe("cc-resume-title-58f3cdd1b");
  });

  test("with no pane newer than the request, reports nothing rather than the doomed one", () => {
    const panes = parseCodecastPaneRows(rows(row("cc-resume-title-58f3cdd1", SESSION, 100)));
    expect(pickPaneForSession(panes, SESSION, SUFFIX, 400)).toBeNull();
    // ...and the same pane IS the answer once the caller stops demanding a new one
    // (the deduplicated-restart case: no new pane was ever coming).
    expect(pickPaneForSession(panes, SESSION, SUFFIX)).toBe("cc-resume-title-58f3cdd1");
  });

  test("resume takes the pane a live session is already in — no freshness bound", () => {
    // The contract split between the two verbs. `cast resume --tmux` kills
    // nothing, so the long-running pane is exactly where the user wants to land;
    // applying restart's freshness rule here would reject it and time out on a
    // perfectly healthy session.
    const panes = parseCodecastPaneRows(rows(row("cc-resume-title-58f3cdd1", SESSION, 100)));
    expect(pickPaneForSession(panes, SESSION, SUFFIX)).toBe("cc-resume-title-58f3cdd1");
  });

  test("a pane with no creation time can't prove it is new, so a freshness demand skips it", () => {
    const panes = parseCodecastPaneRows(rows(row("cc-resume-title-58f3cdd1", SESSION)));
    expect(pickPaneForSession(panes, SESSION, SUFFIX, 400)).toBeNull();
    expect(pickPaneForSession(panes, SESSION, SUFFIX)).toBe("cc-resume-title-58f3cdd1");
  });
});

describe("resumeTmuxName", () => {
  test("the id suffix survives with or without a title slug", () => {
    expect(resumeTmuxName("claude", SESSION)).toBe("cc-resume-58f3cdd1");
    expect(resumeTmuxName("claude", SESSION, "fix-auth")).toBe("cc-resume-fix-auth-58f3cdd1");
    expect(resumeTmuxName("codex", SESSION)).toBe("cx-resume-58f3cdd1");
  });

  test("prefixed ids keep 16 chars, so two agent-* sessions never collapse onto one pane", () => {
    const a = resumeTmuxName("claude", "agent-a920233e1ad3a0d16");
    const b = resumeTmuxName("claude", "agent-a9b62ebc367b5ffa6");
    expect(a).not.toBe(b);
  });

  test("Codex UUIDv7 ids with the same time prefix get distinct pane names", () => {
    const a = "01a06e13-0e36-7202-b795-4719aa020cf4";
    const b = "01a06e13-0de8-75c2-a580-88de14265d82";
    expect(resumeTmuxName("codex", a)).toBe("cx-resume-01a06e13-b7954719aa020cf4");
    expect(resumeTmuxName("codex", a)).not.toBe(resumeTmuxName("codex", b));
  });

  test("upgrades an existing eight-character resume pane without losing its title", () => {
    const sessionId = "01a06e13-6afb-71a1-9acc-deeac20e9ce5";
    expect(upgradedLegacyResumeTmuxName("cx-resume-01a06e13", sessionId))
      .toBe("cx-resume-01a06e13-9accdeeac20e9ce5");
    expect(upgradedLegacyResumeTmuxName("cx-resume-cloud-01a06e13", sessionId))
      .toBe("cx-resume-cloud-01a06e13-9accdeeac20e9ce5");
    expect(upgradedLegacyResumeTmuxName("cx-resume-01a06e13-9accdeeac20e9ce5", sessionId)).toBeNull();
  });
});
