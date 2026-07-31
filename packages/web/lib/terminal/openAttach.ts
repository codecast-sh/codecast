// App → terminal integration: open a live view of an agent session's tmux
// pane inside the bottom terminal panel.
//
// Read-only on purpose: the daemon screen-scrapes agent panes (AUQ menus,
// interactive prompts) and injects keys with its own timing — a second human
// typing into the same pane would corrupt that. Full control stays one
// clipboard away via the tmux attach pill.

import type { ConvexReactClient } from "convex/react";
import { getTerminalEndpoint } from "./endpoint";
import { openTerminal } from "./termSessions";
import { setTerminalOpen } from "./panelPrefs";

export async function openAgentTerminal(
  convex: ConvexReactClient,
  tmuxSession: string,
  title?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const endpoint = await getTerminalEndpoint(convex);
  if (!endpoint) {
    return { ok: false, reason: "No local daemon reachable — the agent runs on another machine or cast isn't running here." };
  }
  setTerminalOpen(true);
  openTerminal({ endpoint, kind: "attach", target: tmuxSession, title: title ?? tmuxSession });
  return { ok: true };
}
