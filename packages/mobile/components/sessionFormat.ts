// Pure helpers for naming and colouring a session row, shared by the inbox,
// search and the long-press sheet. SessionItem.tsx re-exports them.
import { Theme } from '@/constants/Theme';
import { agentStatusAt } from '@codecast/web/lib/liveness';
import { agentDisplayName, isHostedAgentType } from '@codecast/shared/contracts';
import { MOBILE_AGENT_TINT } from '@codecast/shared/render/mobileSessionStyle';
import { conversationTitle } from '@codecast/web/components/simple/lane';
import type { SessionData } from '@/components/SessionItem';

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatDuration(ms: number): string {
  if (ms < 60000) return "<1m";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function cleanTitle(raw?: string): string {
  if (!raw) return 'Untitled';
  let t = raw.trim();
  const jsonMatch = t.match(/```(?:json)?\s*\{[\s\S]*?"title"\s*:\s*"([^"]+)"[\s\S]*?```/);
  if (jsonMatch) return jsonMatch[1];
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { const p = JSON.parse(t); if (p.title) return p.title; } catch {}
  return t || 'Untitled';
}

/** What a row is called, wherever the inbox names it (a row, the set-aside
 *  and closed lists, the long-press sheet). A conversation with the assistant
 *  is named the way its own screen names it, so it never reads "Untitled" or
 *  "New session" while its title is on the way. */
export function sessionTitle(session: Pick<SessionData, 'agent_type' | 'title' | 'last_user_message'>): string {
  return isHostedAgentType(session.agent_type) ? conversationTitle(session) : cleanTitle(session.title);
}

/** The agent's name from the shared registry, so a new agent is named here
 *  the day it is added there. Empty for a row with no agent. */
export function agentLabel(agentType: string): string {
  return agentType ? agentDisplayName(agentType) : "";
}

const projectColors = [Theme.blue, Theme.cyan, Theme.violet, Theme.magenta, Theme.green, Theme.orange];

export function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return projectColors[Math.abs(hash) % projectColors.length];
}

/** The agent's tint, the one the session header uses (MOBILE_AGENT_TINT). */
export function agentColor(agentType: string): string {
  const tint = MOBILE_AGENT_TINT[agentType];
  if (tint) return tint;
  if (agentType === "grok") return Theme.text;
  return agentType ? Theme.accent : Theme.textMuted0;
}

export const isProducingStatus = (status: string | undefined) => status === "working" || status === "thinking";

export function statusColor(session: SessionData, now = Date.now()): string {
  if (session.session_error) return Theme.red;
  if (session.is_unresponsive) return Theme.orange;
  if (session.has_pending) return Theme.accent;
  const status = agentStatusAt(session, now);
  if (isProducingStatus(status)) return Theme.greenBright;
  if (status === "permission_blocked") return Theme.orange;
  if (session.is_idle) return Theme.textMuted0;
  if (session.is_connected) return Theme.greenBright;
  return Theme.textMuted0;
}

/** A word beside the time only when something is wrong. Working, thinking
 *  and pending already read from the pulsing dot, so the row stays quiet. */
export function statusLabel(session: SessionData): string | null {
  if (session.session_error) return "error";
  if (session.agent_status === "permission_blocked") return "blocked";
  if (session.is_unresponsive) return "unresponsive";
  return null;
}

export function projectName(conv: { git_root?: string | null; project_path?: string | null }): string | null {
  const path = conv.git_root || conv.project_path;
  if (!path) return null;
  return path.split('/').pop() || null;
}
