import * as path from "node:path";
import { herdViewerAlive } from "./herdViewer.js";
import { execFileAsync } from "./proc.js";
import { tmuxRunAsync } from "./tmux.js";
import { cliFetchRead } from "./cliHttp.js";
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

/** Session titles from the server, the ones the inbox shows. Fetched for
 *  sessions the herd has not seen and refreshed every few minutes, so a rename
 *  reaches the herd without a request on every pass. A failed fetch waits out
 *  the same interval rather than retrying each pass. */
export class HerdTitles {
  private titles = new Map<string, { title?: string; at: number }>();

  constructor(
    private fetchTitles: (sessionIds: string[]) => Promise<Map<string, string>>,
    private ttlMs = 5 * 60_000,
  ) {}

  async refresh(sessionIds: string[]): Promise<void> {
    const now = Date.now();
    const due = sessionIds.filter((id) => now - (this.titles.get(id)?.at ?? 0) >= this.ttlMs);
    if (due.length === 0) return;
    const got = await this.fetchTitles(due).catch(() => new Map<string, string>());
    for (const id of due) this.titles.set(id, { title: got.get(id) ?? this.titles.get(id)?.title, at: now });
  }

  get(sessionId: string): string | undefined {
    return this.titles.get(sessionId)?.title;
  }
}

/** Fetches session titles with the CLI's credentials. */
export function serverTitles(config: { auth_token?: string; convex_url?: string } | null): HerdTitles {
  return new HerdTitles(async (sessionIds) => {
    const out = new Map<string, string>();
    if (!config?.auth_token || !config.convex_url) return out;
    const resp = await cliFetchRead(`${config.convex_url.replace(".cloud", ".site")}/cli/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: config.auth_token, session_ids: sessionIds }),
    });
    if (!resp.ok) return out;
    const data = await resp.json() as { conversations?: Array<{ session_id?: string; title?: string }> };
    for (const conv of data.conversations ?? []) {
      if (conv.session_id && conv.title) out.set(conv.session_id, conv.title);
    }
    return out;
  });
}

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
export async function applyHerd(socketPath: string, ops: HerdOp[], snap: HerdrSnapshot, log?: (m: string) => void, isActive: () => boolean = () => true): Promise<void> {
  const workspaces = new Map<string, string>();
  for (const ws of snap.workspaces) {
    const project = ws.tokens?.[HERD_PROJECT_TOKEN];
    if (project) workspaces.set(project, ws.workspace_id);
  }
  const req = (method: string, params: Record<string, unknown>) => herdrRequest<Record<string, any>>(socketPath, method, params);
  // Closes last: herdr removes a workspace with its last pane, and an open
  // planned into that workspace would find it gone.
  const ordered = [...ops.filter((op) => op.kind !== "close"), ...ops.filter((op) => op.kind === "close")];
  for (const op of ordered) {
    if (!isActive()) break;
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
  const existing = workspaces.get(cwd);
  // A workspace the person closed since the snapshot is replaced, not retried.
  const tab = existing
    ? await req("tab.create", { workspace_id: existing, cwd, label: member.tabLabel, focus: false }).catch(() => null)
    : null;
  let paneId: string;
  if (tab) {
    paneId = tab.root_pane.pane_id;
  } else {
    const ws = await req("workspace.create", { cwd, label: path.basename(cwd) || cwd, focus: false });
    const workspaceId = ws.workspace.workspace_id as string;
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
export async function syncHerd(socketPath: string, members: HerdMember[], log?: (m: string) => void, isActive?: () => boolean): Promise<HerdOp[]> {
  const snap = await herdrSnapshot(socketPath);
  const ops = planHerd(members, snap);
  if (ops.length > 0) await applyHerd(socketPath, ops, snap, log, isActive);
  return ops;
}

export async function syncHerdStatus(socketPath: string, members: HerdMember[], log?: (message: string) => void): Promise<void> {
  const snap = await herdrSnapshot(socketPath);
  const watching = await herdViewerAlive(socketPath);
  const ops = planHerd(watching ? members : [], snap).filter((op) => watching ? op.kind === "report" : op.kind === "close");
  await applyHerd(socketPath, ops, snap, log);
}

export class HerdFocus {
  private attached: { paneId: string; tty: string } | null = null;

  async sync(socketPath: string, members: HerdMember[], isActive: () => boolean = () => true): Promise<void> {
    const snap = await herdrSnapshot(socketPath);
    const pane = snap.panes.find((p) => p.pane_id === snap.focused_pane_id);
    const member = members.find((m) => m.sessionId === pane?.tokens?.[HERD_SESSION_TOKEN]);
    if (this.attached?.paneId === pane?.pane_id && member) return;
    if (this.attached) {
      const result = await tmuxRunAsync(["detach-client", "-t", this.attached.tty]);
      if (result.status !== 0 && snap.panes.some((p) => p.pane_id === this.attached!.paneId)) {
        const clients = await tmuxRunAsync(["list-clients", "-F", "#{client_tty}"]);
        if (clients.status !== 0 || clients.stdout.split("\n").includes(this.attached.tty)) return;
      }
      this.attached = null;
    }
    if (!pane || !member || !isActive()) return;
    const { process_info: info } = await herdrRequest<{ process_info: { tty?: string; shell_pid?: number } }>(socketPath, "pane.process_info", { pane_id: pane.pane_id });
    const ttyName = info.tty ?? (info.shell_pid
      ? String((await execFileAsync("ps", ["-o", "tty=", "-p", String(info.shell_pid)], { encoding: "utf8", timeout: 3000 })).stdout).trim()
      : "");
    if (!ttyName || ttyName === "??" || ttyName === "?") return;
    const tty = ttyName.startsWith("/dev/") ? ttyName : `/dev/${ttyName}`;
    await herdrRequest(socketPath, "pane.send_text", {
      pane_id: pane.pane_id,
      text: `env -u TMUX tmux attach-session -f ignore-size -t ${shellQuote(`=${member.tmux}`)}\r`,
    });
    this.attached = { paneId: pane.pane_id, tty };
    const deadline = Date.now() + 10_000;
    while (isActive() && Date.now() < deadline) {
      const clients = await tmuxRunAsync(["list-clients", "-F", "#{client_tty}"]);
      if (clients.status === 0 && clients.stdout.split("\n").includes(tty)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!isActive()) return;
    throw new Error(`tmux viewer did not attach to ${member.tmux}`);
  }
}
