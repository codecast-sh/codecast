// `cast herd`: codecast's tmux sessions, mirrored into a herdr session.
//
// Each live codecast session gets a herdr tab running `tmux attach` to its pane,
// grouped into one herdr workspace per project. codecast reports the session's
// real state and title into the pane under its own authority, so herdr's
// sidebar, badges and notifications show what codecast knows rather than what
// herdr can guess from a tmux client's screen.
//
// The plan is a diff against herdr's own snapshot, never against memory of what
// was sent last. The daemon's tick and the `cast herd` command can both apply
// it, and a person closing a tab in herdr is corrected on the next pass.

import * as path from "node:path";
import type { CodecastPane } from "./tmux.js";
import {
  HERD_PROJECT_TOKEN,
  HERD_SESSION_TOKEN,
  HERDR_SOURCE,
  herdrRequest,
  herdrSnapshot,
  herdrStateFor,
  sameHerdrState,
  type HerdrAgentState,
  type HerdrPane,
  type HerdrSnapshot,
} from "./herdr.js";

export type HerdMember = {
  sessionId: string;
  tmux: string;
  projectPath: string;
  /** herdr's agent label (claude, codex, ...). */
  agent: string;
  /** null when the caller does not know it: existing panes keep theirs. */
  state: HerdrAgentState | null;
  title: string;
  tabLabel: string;
};

export type HerdOp =
  | { kind: "open"; member: HerdMember }
  | { kind: "report"; paneId: string; member: HerdMember; state: boolean; title: boolean }
  | { kind: "close"; paneId: string };

const TAB_LABEL_MAX = 28;

/** The herd members for this machine's codecast tmux sessions. Only panes the
 *  daemon stamped with a session id belong to codecast; a person's own tmux
 *  sessions stay out of the herd. */
export function herdMembers(
  panes: CodecastPane[],
  lookup: { status: (sessionId: string) => string | undefined | null; title: (sessionId: string) => string | undefined },
): HerdMember[] {
  const out: HerdMember[] = [];
  for (const pane of panes) {
    if (!pane.sessionId) continue;
    const shortId = pane.conversationId?.slice(0, 7);
    const title = lookup.title(pane.sessionId)?.trim() || pane.tmux;
    const status = lookup.status(pane.sessionId);
    out.push({
      sessionId: pane.sessionId,
      tmux: pane.tmux,
      projectPath: pane.projectPath || "~",
      agent: herdrAgentLabel(pane.agentType),
      state: status === null ? null : herdrStateFor(status ?? undefined),
      title: shortId ? `${title} · ${shortId}` : title,
      tabLabel: title.length > TAB_LABEL_MAX ? `${title.slice(0, TAB_LABEL_MAX - 1)}…` : title,
    });
  }
  return out;
}

function herdrAgentLabel(agentType: string | null): string {
  if (!agentType || agentType === "claude_code") return "claude";
  return agentType;
}

export function planHerd(members: HerdMember[], snap: HerdrSnapshot): HerdOp[] {
  const ops: HerdOp[] = [];
  const panesBySession = new Map<string, HerdrPane[]>();
  for (const pane of snap.panes) {
    const sid = pane.tokens?.[HERD_SESSION_TOKEN];
    if (!sid) continue;
    panesBySession.set(sid, [...(panesBySession.get(sid) ?? []), pane]);
  }
  const wanted = new Set(members.map((m) => m.sessionId));
  for (const [sid, panes] of panesBySession) {
    // A session that ended, or a second pane two passes opened at once.
    const extra = wanted.has(sid) ? panes.slice(1) : panes;
    for (const pane of extra) ops.push({ kind: "close", paneId: pane.pane_id });
  }
  for (const member of members) {
    const pane = panesBySession.get(member.sessionId)?.[0];
    if (!pane) {
      ops.push({ kind: "open", member });
      continue;
    }
    const state = member.state !== null && !sameHerdrState(pane.agent_status, member.state);
    const title = pane.title !== member.title;
    if (state || title) ops.push({ kind: "report", paneId: pane.pane_id, member, state, title });
  }
  return ops;
}

/** Applies a plan. Ops are independent: one failing (a pane closed under us)
 *  never stops the rest, and the next pass retries whatever is still off. */
export async function applyHerd(socketPath: string, ops: HerdOp[], snap: HerdrSnapshot, log?: (m: string) => void): Promise<void> {
  const workspaces = new Map<string, string>();
  for (const ws of snap.workspaces) {
    const project = ws.tokens?.[HERD_PROJECT_TOKEN];
    if (project) workspaces.set(project, ws.workspace_id);
  }
  const req = (method: string, params: Record<string, unknown>) => herdrRequest<Record<string, any>>(socketPath, method, params);
  for (const op of ops) {
    try {
      if (op.kind === "close") {
        await req("pane.close", { pane_id: op.paneId });
      } else if (op.kind === "report") {
        if (op.title) await reportTitle(req, op.paneId, op.member);
        if (op.state) await reportState(req, op.paneId, op.member);
      } else {
        await openMember(req, workspaces, op.member);
      }
    } catch (err) {
      log?.(`${op.kind} ${op.kind === "close" ? op.paneId : op.member.tmux}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

type Req = (method: string, params: Record<string, unknown>) => Promise<Record<string, any>>;

async function openMember(req: Req, workspaces: Map<string, string>, member: HerdMember): Promise<void> {
  const cwd = member.projectPath;
  let workspaceId = workspaces.get(cwd);
  let paneId: string;
  if (workspaceId) {
    const tab = await req("tab.create", { workspace_id: workspaceId, cwd, label: member.tabLabel, focus: false });
    paneId = tab.root_pane.pane_id;
  } else {
    const ws = await req("workspace.create", { cwd, label: path.basename(cwd) || cwd, focus: false });
    workspaceId = ws.workspace.workspace_id as string;
    paneId = ws.root_pane.pane_id;
    workspaces.set(cwd, workspaceId);
    await req("workspace.report_metadata", { workspace_id: workspaceId, source: HERDR_SOURCE, tokens: { [HERD_PROJECT_TOKEN]: cwd } });
    await req("tab.rename", { tab_id: ws.tab.tab_id, label: member.tabLabel });
  }
  await req("pane.report_metadata", {
    pane_id: paneId,
    source: HERDR_SOURCE,
    agent: member.agent,
    title: member.title,
    tokens: { [HERD_SESSION_TOKEN]: member.sessionId },
  });
  await reportState(req, paneId, { ...member, state: member.state ?? "unknown" });
  // exec, so the pane closes when the tmux session ends or is detached. TMUX is
  // unset because a server started from inside tmux hands it to every pane.
  await req("pane.send_text", { pane_id: paneId, text: `exec env -u TMUX tmux attach-session -t ${shellQuote(`=${member.tmux}`)}\r` });
}

function reportTitle(req: Req, paneId: string, member: HerdMember) {
  return req("pane.report_metadata", { pane_id: paneId, source: HERDR_SOURCE, agent: member.agent, title: member.title });
}

function reportState(req: Req, paneId: string, member: HerdMember) {
  return req("pane.report_agent", {
    pane_id: paneId,
    source: HERDR_SOURCE,
    agent: member.agent,
    state: member.state ?? "unknown",
    agent_session_id: member.sessionId,
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One full pass: read herdr, plan against `members`, apply. */
export async function syncHerd(socketPath: string, members: HerdMember[], log?: (m: string) => void): Promise<HerdOp[]> {
  const snap = await herdrSnapshot(socketPath);
  const ops = planHerd(members, snap);
  if (ops.length > 0) await applyHerd(socketPath, ops, snap, log);
  return ops;
}
