// `cast herd` and `cast gc`: the person's view onto this machine's tmux agents.

import { spawn } from "node:child_process";
import { HERD_PROJECT_TOKEN, HERD_SESSION, HERDR_INSTALL_HINT, herdrAlive, herdrBin, herdrRequest, herdrSnapshot, herdrSocketPath } from "./herdr.js";
import { HerdFocus, herdMembers, serverTitles, syncHerd } from "./herdMirror.js";
import { claimHerdViewer } from "./herdViewer.js";
import { readTitleCache } from "./titleCache.js";
import { ensureTmux, listCodecastPanes, listCodecastPanesAsync, tmuxRun, type CodecastPane } from "./tmux.js";

/** The environment herdr's server hands its panes. A server started from
 *  inside tmux would pass TMUX on, and every pane's `tmux attach` would refuse
 *  to nest. */
function herdEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

async function ensureHerdServer(bin: string, socketPath: string): Promise<boolean> {
  if (await herdrAlive(socketPath)) return true;
  spawn(bin, ["--session", HERD_SESSION, "server"], { detached: true, stdio: "ignore", env: herdEnv() }).unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await herdrAlive(socketPath, 3000)) {
      await clearRestoredWorkspaces(socketPath);
      return true;
    }
  }
  return false;
}

/** A restarted herdr server restores the last layout as fresh shells, without
 *  the tokens that tie a pane to a session. Those shells hold nothing, and the
 *  first pass rebuilds the herd, so they are closed rather than left to pile up
 *  with each restart. */
async function clearRestoredWorkspaces(socketPath: string): Promise<void> {
  const snap = await herdrSnapshot(socketPath, 3000).catch(() => null);
  for (const ws of snap?.workspaces ?? []) {
    if (ws.tokens?.[HERD_PROJECT_TOKEN]) continue;
    await herdrRequest(socketPath, "workspace.close", { workspace_id: ws.workspace_id }).catch(() => {});
  }
}

export async function runHerdCommand(
  config: { auth_token?: string; convex_url?: string } | null,
  options: { open?: boolean } = {},
): Promise<void> {
  if (options.open === false || !process.stdout.isTTY) {
    console.log("Open cast herd in an interactive terminal to view agent sessions. No mirrors started.");
    return;
  }
  if (!ensureTmux()) return;
  const bin = herdrBin();
  if (!bin) {
    console.error("cast herd runs on herdr (herdr.dev), which is not installed.");
    console.error(HERDR_INSTALL_HINT);
    process.exit(1);
  }
  const socketPath = herdrSocketPath(HERD_SESSION);
  if (!(await ensureHerdServer(bin, socketPath))) {
    console.error(`herdr did not start. Try it by hand: herdr --session ${HERD_SESSION} server`);
    process.exit(1);
  }

  const release = await claimHerdViewer(socketPath);
  const titles = serverTitles(config);
  const focus = new HerdFocus();
  let viewer: ReturnType<typeof spawn> | undefined;
  let closed = false;
  const stop = () => { closed = true; viewer?.kill("SIGTERM"); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);
  try {
    await syncHerd(socketPath, []);
    viewer = spawn(bin, ["--session", HERD_SESSION], { stdio: "inherit", env: herdEnv() });
    viewer.once("exit", () => { closed = true; });
    viewer.once("error", (err) => { console.error(err.message); closed = true; });
    let nextRefresh = 0;
    let members: ReturnType<typeof herdMembers> = [];
    while (!closed) {
      if (Date.now() >= nextRefresh) {
        const panes = await listCodecastPanesAsync();
        await titles.refresh(panes.flatMap((p) => p.sessionId ?? []));
        const cachedTitles = readTitleCache();
        members = herdMembers(panes, { status: () => null, title: (sid) => titles.get(sid) ?? cachedTitles[sid] });
        if (closed) break;
        await syncHerd(socketPath, members);
        nextRefresh = Date.now() + 3000;
      }
      if (closed) break;
      await focus.sync(socketPath, members);
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    stop();
    try {
      await release();
      await syncHerd(socketPath, []);
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGHUP", stop);
    }
  }
}

/** Every tmux session on this machine with how long it has been idle. Sessions
 *  tmux reports no activity for are left out: they cannot be judged stale. */
function idleTmuxSessions(): Array<{ pane: CodecastPane; idleSec: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  return listCodecastPanes()
    .filter((pane) => pane.activitySec > 0)
    .map((pane) => ({ pane, idleSec: nowSec - pane.activitySec }));
}

export function runGcCommand(options: { mins?: string; dryRun?: boolean }): void {
  if (!ensureTmux()) return;
  const mins = Number.parseInt(options.mins || "60", 10) || 60;
  const stale = idleTmuxSessions().filter((s) => s.idleSec >= mins * 60);
  if (stale.length === 0) {
    console.log(`No sessions idle for >${mins}m.`);
    return;
  }
  const plural = stale.length === 1 ? "" : "s";
  if (options.dryRun) {
    console.log(`Would kill ${stale.length} session${plural}:`);
    for (const s of stale) console.log(`  ${s.pane.tmux}  (idle ${Math.floor(s.idleSec / 60)}m)`);
    return;
  }
  const killed = stale.filter((s) => tmuxRun(["kill-session", "-t", `=${s.pane.tmux}`]).status === 0).map((s) => s.pane.tmux);
  console.log(killed.length > 0
    ? `Killed ${killed.length} stale session${killed.length === 1 ? "" : "s"}: ${killed.join(", ")}`
    : `No sessions idle for >${mins}m.`);
}
