import { expect, test } from "bun:test";
import { orphanedTmuxClientPids } from "./daemon.js";

// Lines as `ps -axo pid=,ppid=,args=` prints them. A one-shot tmux client whose
// parent is launchd (pid 1) outlived the daemon that spawned it and, when wedged,
// spins at full CPU until killed (three has-session clients, 2026-09-03).
const lines = [
  "84305     1 tmux has-session -t cc-codex-000000000000",
  "80186     1 /opt/homebrew/bin/tmux -S /tmp/sock show-options -qv -t cc-claude-abc @codecast_session_id",
  " 1709     1 tmux new-session -d -x 220 -y 50 -s cc-resume-de0188ca -c /Users/x/src/eaiden",
  "74656 74617 tmux attach -t cc-resume-de0188ca",
  "  100 75622 tmux has-session -t cc-claude-live",
  " 2001     1 tmux wait-for cast-paste-42",
  " 2002     1 tmux -C attach -t x",
  "not a ps line",
];

test("kills only orphaned one-shot clients, never servers, attachers or waiters", () => {
  expect(orphanedTmuxClientPids(lines)).toEqual([
    { pid: 84305, args: "tmux has-session -t cc-codex-000000000000" },
    { pid: 80186, args: "/opt/homebrew/bin/tmux -S /tmp/sock show-options -qv -t cc-claude-abc @codecast_session_id" },
  ]);
});

test("a different orphan parent pid can be named", () => {
  expect(orphanedTmuxClientPids(lines, 75622).map((o) => o.pid)).toEqual([100]);
});
