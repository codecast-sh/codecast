// Is an agent alive in this tmux session: yes, no, or this machine could not
// tell. The third answer matters under load. At load 700 on 16 cores
// (2026-11-08, jx751p3) tmux and ps calls hit their 3s timeouts, and reading
// each timeout as "dead" dropped a live session's cached target. Delivery then
// fell through to the AppleScript path, which cannot type into a tmux pane, and
// every retry failed the same way while the agent sat idle in its pane.

/** What one probe of a tmux session saw. `null` means the probe got no answer. */
export interface TmuxLivenessFacts {
  /** list-panes: the session's pane pid, "gone" when tmux said the session does not exist. */
  panePid: number | "gone" | null;
  /** The agent pid found in the pane's tree, "absent" when every process answered and none is an agent. */
  agent: number | "absent" | null;
  /** The last lines of the pane, or null when capture-pane got no answer. */
  pane: string | null;
}

/** A pane that shows the agent has exited, whatever the process tree says. */
export function paneShowsAgentExited(pane: string): boolean {
  return /Resume this session with:/i.test(pane)
    || /Segmentation fault|panic:|SIGABRT|core dumped|exited with/.test(pane)
    || /-(?:ba)?sh:.*(?:No such file|command not found)/.test(pane);
}

export function classifyTmuxLiveness(f: TmuxLivenessFacts): boolean | null {
  if (f.panePid === "gone") return false;
  if (f.panePid === null) return null;
  if (f.pane !== null && (!f.pane.trim() || paneShowsAgentExited(f.pane.trim()))) return false;
  if (typeof f.agent === "number") return true;
  // No agent in a tree where every process answered: it exited or crashed.
  if (f.agent === "absent") return false;
  return null;
}
