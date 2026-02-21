import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");

type AgentType = "claude_code" | "codex" | "unknown";

interface AttachTuiConfig {
  authToken: string;
  convexUrl: string;
}

interface LiveTmuxSession {
  pid: number;
  tty: string;
  tmuxSession: string;
  sessionId: string;
  agentType: AgentType;
  label: "managed" | "resumed" | "tmux";
  uptimeSec: number;
  title?: string;
  subtitle?: string | null;
  preview?: string | null;
  projectPath?: string | null;
  updatedAt?: string;
  messageCount?: number;
  convexAgentType?: string | null;
}

interface SessionRegistryLookups {
  byPid: Map<number, string>;
  byTty: Map<string, string>;
}

function normalizePsTty(tty: string): string {
  if (tty.startsWith("/dev/")) return tty;
  if (/^s\d+$/.test(tty)) return `/dev/tty${tty}`;
  return `/dev/${tty}`;
}

function stripAnsi(input: string): string {
  return input
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, "");
}

function sanitizeAnsi(input: string): string {
  return input
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, (match) => match.endsWith("m") ? match : "")
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, "");
}

function truncate(input: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (input.length <= maxLen) return input;
  if (maxLen <= 1) return input.slice(0, maxLen);
  return `${input.slice(0, maxLen - 1)}…`;
}

function formatUptime(uptimeSec: number): string {
  if (uptimeSec < 60) return `${uptimeSec}s`;
  const mins = Math.floor(uptimeSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return "unknown";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "unknown";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shellOut(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PATH: ENRICHED_PATH },
    });
  } catch {
    return "";
  }
}

function loadSessionRegistryLookups(): SessionRegistryLookups {
  const byPid = new Map<number, string>();
  const byTty = new Map<string, string>();
  const registryDir = path.join(os.homedir(), ".codecast", "session-registry");
  const nowSec = Math.floor(Date.now() / 1000);

  if (!fs.existsSync(registryDir)) return { byPid, byTty };
  const files = fs.readdirSync(registryDir);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const sessionId = file.slice(0, -5);
    try {
      const raw = fs.readFileSync(path.join(registryDir, file), "utf-8");
      const parsed = JSON.parse(raw) as { pid?: unknown; tty?: unknown; ts?: unknown };
      const ts = typeof parsed.ts === "number" ? parsed.ts : 0;
      if (!ts || nowSec - ts > 2 * 24 * 60 * 60) continue;
      if (typeof parsed.pid === "number" && parsed.pid > 0) byPid.set(parsed.pid, sessionId);
      if (typeof parsed.tty === "string" && parsed.tty && parsed.tty !== "?" && parsed.tty !== "??") {
        byTty.set(normalizePsTty(parsed.tty), sessionId);
      }
    } catch {}
  }

  return { byPid, byTty };
}

function discoverLiveTmuxSessionsFast(): LiveTmuxSession[] {
  const tmuxPaneOut = shellOut("tmux list-panes -a -F '#{session_name}\t#{pane_tty}\t#{pane_pid}\t#{?pane_active,1,0}' 2>/dev/null");
  const paneBySession = new Map<string, { tty: string; panePid: number; isActive: boolean }>();
  for (const line of tmuxPaneOut.split("\n").filter(Boolean)) {
    const [sessionName, rawTty, rawPanePid, rawActive] = line.split("\t");
    if (!sessionName || !rawTty) continue;
    const panePid = Number.parseInt(rawPanePid || "0", 10);
    const isActive = rawActive === "1";
    const existing = paneBySession.get(sessionName);
    if (!existing || (isActive && !existing.isActive)) {
      paneBySession.set(sessionName, {
        tty: normalizePsTty(rawTty),
        panePid: Number.isFinite(panePid) ? panePid : 0,
        isActive,
      });
    }
  }
  if (paneBySession.size === 0) return [];

  const registry = loadSessionRegistryLookups();
  const psOut = shellOut("ps -axo pid=,tty=,etimes=,command=");
  const processByPid = new Map<number, { pid: number; tty: string; uptimeSec: number; agentType: AgentType | null; resumeSessionId?: string }>();
  const agentByTty = new Map<string, Array<{ pid: number; uptimeSec: number; agentType: AgentType; resumeSessionId?: string }>>();

  for (const line of psOut.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const tty = match[2];
    const uptimeSec = Number.parseInt(match[3], 10);
    const command = match[4];
    if (!Number.isFinite(pid) || !Number.isFinite(uptimeSec)) continue;
    const normalizedTty = normalizePsTty(tty);

    let agentType: AgentType | null = null;
    if (/\bclaude\b/i.test(command) && !/grep|bash -c|codecast|mcp/i.test(command)) {
      agentType = "claude_code";
    } else if (/(codex\/codex|\/codex\b|\bcodex\b)/i.test(command) && !/grep|Codex\.app|Sparkle|Autoupdate|Helper|Renderer|Crashpad|app-server/i.test(command)) {
      agentType = "codex";
    }
    const resumeMatch = command.match(/--resume\s+([0-9a-f-]{36})/i);
    processByPid.set(pid, {
      pid,
      tty: normalizedTty,
      uptimeSec,
      agentType,
      resumeSessionId: resumeMatch?.[1],
    });

    if (agentType && tty !== "?" && tty !== "??") {
      const bucket = agentByTty.get(normalizedTty) || [];
      bucket.push({
        pid,
        uptimeSec,
        agentType,
        resumeSessionId: resumeMatch?.[1],
      });
      agentByTty.set(normalizedTty, bucket);
    }
  }

  const out: LiveTmuxSession[] = [];
  for (const [tmuxSession, pane] of paneBySession) {
    const candidates = (agentByTty.get(pane.tty) || []).sort((a, b) => a.uptimeSec - b.uptimeSec);
    const bestAgent = candidates[0];

    const paneProc = pane.panePid > 0 ? processByPid.get(pane.panePid) : undefined;
    const pid = bestAgent?.pid || pane.panePid || 0;
    const uptimeSec = bestAgent?.uptimeSec ?? paneProc?.uptimeSec ?? 0;
    const inferredAgentType: AgentType = bestAgent?.agentType
      || (tmuxSession.startsWith("cx-") ? "codex" : tmuxSession.startsWith("cc-") ? "claude_code" : "unknown");
    const sessionId = bestAgent?.resumeSessionId
      || (pid > 0 ? registry.byPid.get(pid) : undefined)
      || registry.byTty.get(pane.tty)
      || `unknown-${inferredAgentType}-${pid || tmuxSession}`;

    const label: "managed" | "resumed" | "tmux" = tmuxSession.startsWith("codecast-")
      ? "managed"
      : (tmuxSession.startsWith("cc-resume") || tmuxSession.startsWith("cx-resume"))
        ? "resumed"
        : "tmux";

    out.push({
      pid: pid || 0,
      tty: pane.tty,
      tmuxSession,
      sessionId,
      agentType: inferredAgentType,
      label,
      uptimeSec: Math.max(0, uptimeSec),
    });
  }

  out.sort((a, b) => {
    if (a.label !== b.label) {
      const rank = (label: LiveTmuxSession["label"]) => (label === "managed" ? 0 : label === "resumed" ? 1 : 2);
      return rank(a.label) - rank(b.label);
    };
    return a.tmuxSession.localeCompare(b.tmuxSession);
  });
  return out;
}

async function fetchSessionMetadata(config: AttachTuiConfig, sessionIds: string[]): Promise<Map<string, {
  title?: string;
  subtitle?: string | null;
  message_count?: number;
  updated_at?: string;
  preview?: string | null;
  agent_type?: string | null;
  project_path?: string | null;
}>> {
  const out = new Map<string, {
    title?: string;
    subtitle?: string | null;
    message_count?: number;
    updated_at?: string;
    preview?: string | null;
    agent_type?: string | null;
    project_path?: string | null;
  }>();
  if (sessionIds.length === 0) return out;

  const siteUrl = config.convexUrl.replace(".cloud", ".site");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(`${siteUrl}/cli/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        api_token: config.authToken,
        session_ids: Array.from(new Set(sessionIds)),
      }),
    });
    if (!response.ok) return out;
    const data = await response.json() as { conversations?: Array<Record<string, unknown>> };
    for (const conv of data.conversations || []) {
      const sessionId = typeof conv.session_id === "string" ? conv.session_id : null;
      if (!sessionId) continue;
      out.set(sessionId, {
        title: typeof conv.title === "string" ? conv.title : undefined,
        subtitle: typeof conv.subtitle === "string" ? conv.subtitle : null,
        message_count: typeof conv.message_count === "number" ? conv.message_count : undefined,
        updated_at: typeof conv.updated_at === "string" ? conv.updated_at : undefined,
        preview: typeof conv.preview === "string" ? conv.preview : null,
        agent_type: typeof conv.agent_type === "string" ? conv.agent_type : null,
        project_path: typeof conv.project_path === "string" ? conv.project_path : null,
      });
    }
  } catch {}
  finally {
    clearTimeout(timeout);
  }

  return out;
}

async function listEnrichedTmuxSessions(config: AttachTuiConfig): Promise<LiveTmuxSession[]> {
  const base = discoverLiveTmuxSessionsFast();
  const metadata = await fetchSessionMetadata(
    config,
    base.filter((s) => !s.sessionId.startsWith("unknown")).map((s) => s.sessionId),
  );

  const merged = base.map((session) => {
    const meta = metadata.get(session.sessionId);
    return {
      ...session,
      title: meta?.title || session.title,
      subtitle: meta?.subtitle,
      preview: meta?.preview,
      projectPath: meta?.project_path,
      updatedAt: meta?.updated_at,
      messageCount: meta?.message_count,
      convexAgentType: meta?.agent_type,
    };
  });

  merged.sort((a, b) => {
    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.tmuxSession.localeCompare(b.tmuxSession);
  });
  return merged;
}

function captureTmuxPane(sessionName: string, maxLines = 220, preserveAnsi = false): string[] {
  const paneCandidates = shellOut(`tmux list-panes -t '${sessionName.replace(/'/g, "'\\''")}' -F '#{?pane_active,1,0} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null`)
    .split("\n")
    .filter(Boolean);

  if (paneCandidates.length === 0) {
    return ["Session has no visible panes."];
  }

  const active = paneCandidates.find((line) => line.startsWith("1 ")) || paneCandidates[0];
  const target = active.slice(2).trim();
  if (!target) return ["Unable to resolve active pane target."];

  const eFlag = preserveAnsi ? "-e " : "";
  const raw = shellOut(`tmux capture-pane ${eFlag}-p -J -t '${target.replace(/'/g, "'\\''")}' -S -${maxLines} 2>/dev/null`);
  if (!raw.trim()) return ["Pane is empty."];
  return raw.split("\n").map((line) => preserveAnsi ? sanitizeAnsi(line) : stripAnsi(line));
}

function resolveActivePaneTarget(sessionName: string): string | null {
  const out = shellOut(`tmux list-panes -t '${sessionName.replace(/'/g, "'\\''")}' -F '#{?pane_active,1,0}\t#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null`);
  const panes = out.split("\n").filter(Boolean);
  if (panes.length === 0) return null;
  const active = panes.find((line) => line.startsWith("1\t")) || panes[0];
  const target = active.split("\t")[1];
  return target || null;
}

function sendTmuxInput(sessionName: string, input: string, options: { literal?: boolean } = {}): boolean {
  const target = resolveActivePaneTarget(sessionName);
  if (!target) return false;
  const args = ["send-keys", "-t", target];
  if (options.literal) args.push("-l", input);
  else args.push(input);
  const result = spawnSync("tmux", args, { stdio: "ignore", env: { ...process.env, PATH: ENRICHED_PATH } });
  return (result.status ?? 1) === 0;
}

function killTmuxSession(sessionName: string): boolean {
  const result = spawnSync("tmux", ["kill-session", "-t", sessionName], {
    stdio: "ignore",
    env: { ...process.env, PATH: ENRICHED_PATH },
  });
  return (result.status ?? 1) === 0;
}

function matchesQuery(session: LiveTmuxSession, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  return [
    session.title,
    session.subtitle || "",
    session.preview || "",
    session.projectPath || "",
    session.tmuxSession,
    session.sessionId,
    session.label,
    session.agentType,
  ].join(" ").toLowerCase().includes(q);
}

function sessionDisplayTitle(session: LiveTmuxSession): string {
  return session.title || `Session ${session.sessionId.startsWith("unknown") ? `PID ${session.pid}` : session.sessionId.slice(0, 8)}`;
}

function projectLine(session: LiveTmuxSession, width: number): string {
  const project = session.projectPath
    ? session.projectPath.replace((process.env.HOME || ""), "~")
    : "unknown project";
  return truncate(`${project}  ·  ${session.tmuxSession}`, width);
}

function projectName(session: LiveTmuxSession): string {
  if (!session.projectPath) return "unknown";
  const name = path.basename(session.projectPath);
  return name || session.projectPath;
}

function formatHoursAgoLabel(updatedAt?: string): string {
  if (!updatedAt) return "unknown";
  const ms = Date.parse(updatedAt);
  if (Number.isNaN(ms)) return "unknown";
  const hours = Math.floor((Date.now() - ms) / (60 * 60 * 1000));
  return hours <= 0 ? "<1h ago" : `${hours}h ago`;
}

function liveIndicator(session: LiveTmuxSession): { symbol: string; color: string } {
  const updatedMs = session.updatedAt ? Date.parse(session.updatedAt) : 0;
  const ageSec = updatedMs ? Math.floor((Date.now() - updatedMs) / 1000) : Infinity;
  if (ageSec < 300) return { symbol: "●", color: "greenBright" };
  if (ageSec < 3600) return { symbol: "◐", color: "yellow" };
  if (session.uptimeSec > 0 && session.uptimeSec < 3600) return { symbol: "◐", color: "yellow" };
  return { symbol: "○", color: "blueBright" };
}

function AttachTuiApp({
  config,
  onAttach,
}: {
  config: AttachTuiConfig;
  onAttach: (tmuxSession: string) => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [sessions, setSessions] = useState<LiveTmuxSession[]>([]);
  const [selectedTmux, setSelectedTmux] = useState<string | null>(null);
  const [previewLines, setPreviewLines] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"normal" | "insert" | "search">("normal");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showUnknown, setShowUnknown] = useState(false);
  const [listPercent, setListPercent] = useState(28);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [pendingKill, setPendingKill] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("Loading live tmux sessions...");
  const refreshInFlight = useRef(false);
  const metadataCache = useRef(new Map<string, { title?: string; updatedAt?: string; messageCount?: number; projectPath?: string | null; convexAgentType?: string | null }>());

  const refreshSessions = useCallback(async (manual = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const next = await listEnrichedTmuxSessions(config);
      for (const s of next) {
        if (s.title || s.updatedAt) {
          metadataCache.current.set(s.sessionId, { title: s.title, updatedAt: s.updatedAt, messageCount: s.messageCount, projectPath: s.projectPath, convexAgentType: s.convexAgentType });
        }
      }
      const stable = next.map(s => {
        if (!s.title && !s.updatedAt && !s.sessionId.startsWith("unknown")) {
          const cached = metadataCache.current.get(s.sessionId);
          if (cached) return { ...s, ...cached };
        }
        return s;
      });
      stable.sort((a, b) => {
        const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        if (aTime !== bTime) return bTime - aTime;
        return a.tmuxSession.localeCompare(b.tmuxSession);
      });
      setSessions((prev) => {
        if (prev.length === stable.length && prev.every((s, i) => s.tmuxSession === stable[i].tmuxSession && s.updatedAt === stable[i].updatedAt && s.title === stable[i].title && s.messageCount === stable[i].messageCount)) return prev;
        return stable;
      });
      setSelectedTmux((prev) => {
        if (stable.length === 0) return null;
        if (prev && stable.some((s) => s.tmuxSession === prev)) return prev;
        return stable[0].tmuxSession;
      });
      if (manual) setStatusMessage(`Refreshed ${stable.length} session${stable.length === 1 ? "" : "s"}.`);
      if (!manual && stable.length === 0) setStatusMessage("No live tmux sessions found.");
    } finally {
      refreshInFlight.current = false;
    }
  }, [config]);

  useEffect(() => {
    void refreshSessions(true);
  }, [refreshSessions]);

  useEffect(() => {
    if (!autoRefresh || mode === "insert") return;
    const timer = setInterval(() => {
      void refreshSessions(false);
    }, 2200);
    return () => clearInterval(timer);
  }, [autoRefresh, refreshSessions, mode]);

  const filteredSessions = useMemo(() => {
    const visible = showUnknown
      ? sessions
      : sessions.filter((session) => !(session.sessionId.startsWith("unknown") && !session.title));
    return visible.filter((session) => matchesQuery(session, query));
  }, [sessions, query, showUnknown]);

  useEffect(() => {
    if (filteredSessions.length === 0) {
      setSelectedTmux(null);
      setPendingKill(null);
      return;
    }
    if (!selectedTmux || !filteredSessions.some((session) => session.tmuxSession === selectedTmux)) {
      setSelectedTmux(filteredSessions[0].tmuxSession);
      setPendingKill(null);
    }
  }, [filteredSessions, selectedTmux]);

  const selectedIndex = Math.max(0, filteredSessions.findIndex((session) => session.tmuxSession === selectedTmux));
  const selected = filteredSessions[selectedIndex] || null;

  useEffect(() => {
    if (!selected?.tmuxSession) {
      setPreviewLines([]);
      return;
    }
    let canceled = false;
    const updatePreview = () => {
      const lines = captureTmuxPane(selected.tmuxSession, 220, true);
      if (!canceled) setPreviewLines((prev) => {
        if (prev.length === lines.length && prev.every((l, i) => l === lines[i])) return prev;
        return lines;
      });
    };
    updatePreview();
    const interval = mode === "insert" ? 150 : 1200;
    const timer = setInterval(updatePreview, interval);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [selected?.tmuxSession, mode]);

  const moveSelection = useCallback((delta: number) => {
    if (filteredSessions.length === 0) return;
    const nextIndex = (selectedIndex + delta + filteredSessions.length) % filteredSessions.length;
    setSelectedTmux(filteredSessions[nextIndex].tmuxSession);
  }, [filteredSessions, selectedIndex]);

  useInput((input, key) => {
    // ── Search mode ──
    if (mode === "search") {
      if (key.escape || key.return) { setMode("normal"); return; }
      if (key.ctrl && input === "c") { setMode("normal"); setQuery(""); return; }
      if (key.backspace || key.delete) { setQuery((v) => v.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) setQuery((v) => v + input);
      return;
    }

    // ── Insert mode ──
    if (mode === "insert") {
      if (key.escape) { setMode("normal"); setStatusMessage(""); return; }
      if (!selected?.tmuxSession) { setMode("normal"); return; }
      let sent = false;
      if (key.return) sent = sendTmuxInput(selected.tmuxSession, "Enter");
      else if (key.backspace || key.delete) sent = sendTmuxInput(selected.tmuxSession, "BSpace");
      else if (key.tab) sent = sendTmuxInput(selected.tmuxSession, "Tab");
      else if (key.upArrow) sent = sendTmuxInput(selected.tmuxSession, "Up");
      else if (key.downArrow) sent = sendTmuxInput(selected.tmuxSession, "Down");
      else if (key.leftArrow) sent = sendTmuxInput(selected.tmuxSession, "Left");
      else if (key.rightArrow) sent = sendTmuxInput(selected.tmuxSession, "Right");
      else if (key.ctrl && input === "c") sent = sendTmuxInput(selected.tmuxSession, "C-c");
      else if (key.ctrl && input) sent = sendTmuxInput(selected.tmuxSession, `C-${input.toLowerCase()}`);
      else if (!key.ctrl && !key.meta && input) sent = sendTmuxInput(selected.tmuxSession, input, { literal: true });
      return;
    }

    // ── Normal mode ──
    if (key.ctrl && input === "c") { exit(); return; }
    if (input === "q") { exit(); return; }

    if (input === "i") {
      if (!selected?.tmuxSession) return;
      setMode("insert");
      setStatusMessage("-- INSERT --");
      return;
    }
    if (input === "/") { setMode("search"); return; }
    if (input === "?") { setShowHelp((v) => !v); return; }

    if (input === "j" || key.downArrow) { moveSelection(1); return; }
    if (input === "k" || key.upArrow) { moveSelection(-1); return; }
    if (input === "g") { if (filteredSessions.length > 0) setSelectedTmux(filteredSessions[0].tmuxSession); return; }
    if (input === "G" || (key.shift && input === "g")) { if (filteredSessions.length > 0) setSelectedTmux(filteredSessions[filteredSessions.length - 1].tmuxSession); return; }
    if (/^[1-9]$/.test(input)) { const d = Number.parseInt(input, 10) - 1; if (d >= 0 && d < filteredSessions.length) setSelectedTmux(filteredSessions[d].tmuxSession); return; }

    if (key.return || input === "o") { if (selected?.tmuxSession) { onAttach(selected.tmuxSession); exit(); } return; }

    if (input === "r") { void refreshSessions(true); return; }
    if (input === "t") { setAutoRefresh((v) => { const n = !v; setStatusMessage(n ? "Auto-refresh enabled." : "Auto-refresh paused."); return n; }); return; }
    if (input === "u") { setShowUnknown((v) => { const n = !v; setStatusMessage(n ? "Unknown sessions shown." : "Unknown sessions hidden."); return n; }); return; }
    if (input === "=" || input === "+") { setListCollapsed(false); setListPercent((v) => Math.min(50, v + 5)); return; }
    if (input === "-") { setListPercent((v) => Math.max(18, v - 5)); return; }
    if (input === "\\") { setListCollapsed((v) => !v); return; }

    if (input === "x") {
      if (!selected?.tmuxSession) return;
      if (pendingKill === selected.tmuxSession) {
        const ok = killTmuxSession(selected.tmuxSession);
        setPendingKill(null);
        if (ok) {
          const idx = filteredSessions.findIndex(s => s.tmuxSession === selected.tmuxSession);
          const adjacent = filteredSessions[idx + 1] || filteredSessions[idx - 1];
          if (adjacent) setSelectedTmux(adjacent.tmuxSession);
          setStatusMessage(`Killed ${selected.tmuxSession}.`);
          void refreshSessions(true);
        } else {
          setStatusMessage(`Failed to kill ${selected.tmuxSession}.`);
        }
      } else {
        setPendingKill(selected.tmuxSession);
        setStatusMessage(`Press x again to kill ${selected.tmuxSession}.`);
      }
      return;
    }

    if (pendingKill && input) setPendingKill(null);
  });

  const columns = stdout.columns || 120;
  const rows = stdout.rows || 36;
  let listWidth = listCollapsed ? 0 : Math.floor(columns * (listPercent / 100));
  let previewWidth = listCollapsed ? columns : columns - listWidth - 1;
  if (!listCollapsed && listWidth < 24) {
    listWidth = 24;
    previewWidth = Math.max(40, columns - listWidth - 1);
  }
  if (!listCollapsed && previewWidth < 40) {
    previewWidth = 40;
    listWidth = Math.max(20, columns - previewWidth - 1);
  }
  const bodyHeight = rows;
  const helpLines = 6;
  const maxVisible = Math.max(4, Math.floor((bodyHeight - 2 - (showHelp ? helpLines : 0)) / 2));

  let listStart = Math.max(0, selectedIndex - Math.floor(maxVisible / 2));
  if (listStart + maxVisible > filteredSessions.length) {
    listStart = Math.max(0, filteredSessions.length - maxVisible);
  }
  const listSlice = filteredSessions.slice(listStart, listStart + maxVisible);
  const previewBodyLines = Math.max(6, bodyHeight - 3);
  const trimmed = (() => {
    let end = previewLines.length;
    while (end > 0 && !previewLines[end - 1]?.trim()) end--;
    return previewLines.slice(0, end);
  })();
  const previewSlice = trimmed.slice(-previewBodyLines);

  const helpEntries: Array<[string, string]> = [
    ["j/k", "navigate"], ["enter", "attach"], ["i", "interact"],
    ["/ ", "search"], ["x", "kill"], ["r", "refresh"],
    ["=-", "resize"], ["\\", "collapse"], ["u", "unknown"],
    ["t", "auto-refresh"], ["g/G", "top/btm"], ["q", "quit"],
  ];

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box flexGrow={1}>
        <Box
          width={previewWidth}
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
          borderColor="magenta"
          paddingLeft={1}
          overflow="hidden"
        >
          {selected ? (
            <>
              <Text bold color="cyanBright">
                {truncate(sessionDisplayTitle(selected), previewWidth - 4)}
              </Text>
              <Text dimColor>
                {truncate(projectLine(selected, previewWidth - 4), previewWidth - 4)}
              </Text>
              <Box marginTop={1} flexDirection="column">
                {previewSlice.length > 0 ? previewSlice.map((line, i) => (
                  <Text key={`p-${i}`} wrap="truncate">{line || " "}</Text>
                )) : (
                  <Box flexDirection="column">
                    <Text dimColor>Pane is empty.</Text>
                    {selected.preview ? (
                      <Text color="cyan">{truncate(selected.preview, previewWidth - 4)}</Text>
                    ) : null}
                  </Box>
                )}
              </Box>
            </>
          ) : (
            <Text dimColor>Select a session to preview.</Text>
          )}
        </Box>

        {!listCollapsed && (
          <Box width={listWidth} flexDirection="column" paddingLeft={1}>
          {listSlice.length > 0 ? listSlice.map((session, idx) => {
            const absIdx = listStart + idx;
            const isSel = absIdx === selectedIndex;
            const indicator = liveIndicator(session);
            const title = sessionDisplayTitle(session);
            const titleLine = truncate(`${absIdx + 1}. ${title}`, listWidth - 4);
            const freshness = formatHoursAgoLabel(session.updatedAt);
            const msgs = session.messageCount !== undefined ? `${session.messageCount} msgs` : "";
            const meta = truncate([freshness, msgs].filter(Boolean).join(" · "), listWidth - 6);

            return (
              <Box key={session.tmuxSession} flexDirection="column">
                <Text wrap="truncate">
                  <Text color={isSel ? "cyanBright" : indicator.color}>{isSel ? "▶" : indicator.symbol}</Text>
                  <Text color={isSel ? "cyanBright" : undefined} bold={isSel}>{" "}{titleLine}</Text>
                </Text>
                <Text color={isSel ? "cyan" : undefined} dimColor={!isSel} wrap="truncate">{"   "}{meta}</Text>
              </Box>
            );
          }) : (
            <Text dimColor>{query ? "No sessions match filter." : "No live sessions found."}</Text>
          )}
            <Box flexGrow={1} />
            {mode === "search" ? (
              <Text color="yellowBright" bold>/ {query}█</Text>
            ) : mode === "insert" ? (
              <Text color="greenBright" bold>-- INSERT --  esc to return</Text>
            ) : showHelp ? (
              <Box flexDirection="column" borderStyle="single" borderLeft={false} borderBottom={false} borderRight={false} borderColor="magenta">
                {[0, 1, 2, 3].map((row) => (
                  <Text key={row} wrap="truncate" dimColor>
                    {helpEntries.slice(row * 3, row * 3 + 3).map(([k, v]) => (
                      `  ${k} ${v}`
                    )).join("")}
                  </Text>
                ))}
                <Text dimColor wrap="truncate">  ? close help</Text>
              </Box>
            ) : (
              <Text dimColor wrap="truncate">j/k nav  i insert  ? help</Text>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export async function runAttachTui(config: AttachTuiConfig): Promise<void> {
  let attachTarget: string | null = null;
  const app = render(
    <AttachTuiApp
      config={config}
      onAttach={(tmuxSession) => {
        attachTarget = tmuxSession;
      }}
    />,
    { exitOnCtrlC: false },
  );

  await app.waitUntilExit();

  if (attachTarget) {
    console.log(`Attaching to tmux session: ${attachTarget}`);
    console.log("Detach and return here with: Ctrl+b then d");
    spawnSync("tmux", ["attach-session", "-t", attachTarget], { stdio: "inherit" });
  }
}
