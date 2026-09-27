import "./test-helpers/isolatedTmuxServer.js";
import { afterEach, describe, expect, test } from "bun:test";
import { tmuxRun } from "./tmux.js";
import { killTmuxSessionAndTree } from "./daemon.js";

// A user who runs `claude` inside their own tmux session gets that session's
// pane resolved as the agent's home (findTmuxPaneForTty). An auth restart, an
// account switch or a kill then tore down the WHOLE tmux session the pane lived
// in — the user's terminal, every window in it — and the revive reappeared as a
// cc-resume-* pane (reported 2026-09-28: auth_restart on fa93c474).

const alive = (name: string) => tmuxRun(["has-session", "-t", `=${name}`]).status === 0;
const created: string[] = [];
function spawn(name: string) {
  expect(tmuxRun(["new-session", "-d", "-s", name, "sleep 300"]).status).toBe(0);
  created.push(name);
}

afterEach(() => {
  for (const name of created.splice(0)) tmuxRun(["kill-session", "-t", `=${name}`]);
});

describe("killTmuxSessionAndTree", () => {
  test("leaves a tmux session codecast did not create", async () => {
    spawn("work");
    tmuxRun(["new-window", "-t", "=work:", "sleep 300"]);
    await killTmuxSessionAndTree("work");
    expect(alive("work")).toBe(true);
  });

  test("still kills the sessions codecast creates", async () => {
    for (const name of ["cc-resume-fa93c474", "cc-claude-abc123", "ct-claude-abc123", "wf-abc123", "codecast-fa93c474"]) {
      spawn(name);
      await killTmuxSessionAndTree(name);
      expect(alive(name)).toBe(false);
    }
  });
});
