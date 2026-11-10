import type { ReactNode } from "react";
import Link from "next/link";
import { railRowPlacement, type InboxSession } from "../../store/inboxStore";
import { sessionStatusOf, SESSION_STATUS, type SessionStatus } from "../../lib/sessionStatus";
import { sessionCardLine } from "../../lib/sessionCardLine";
import { SessionStatusMark, SessionStatusWord } from "../../components/inbox/SessionStatusMark";
import { HibernatedMarker } from "../../components/HibernatedMarker";
import { Button } from "../../components/ui/button";

// One /sessions row in the Modern style: the session card's first two lines
// (the state's mark, the title, the word and its reason, one line about the
// work) with the page's own facts beside them: how long since it moved, what
// its process is doing, and the machine figures. The state comes from the
// status vocabulary (lib/sessionStatus) over the inbox row the page joins, so
// it reads the same word as the rail; process liveness (up, idle, gone,
// hibernated) is a separate axis and is said as process facts, never as a
// state word.

/** The page's classified row, as much of it as the row draws. */
export type ModernSessionsRowData = {
  _id: string;
  session_id: string;
  conversation_id?: string | null;
  conversation_title?: string | null;
  tmux_session?: string | null;
  agent_status?: string | null;
  bucket: "active" | "idle" | "dead" | "hibernated";
  awakeIdleMs: number;
  lastActiveAt: number;
  lastActiveMs: number;
  last_heartbeat?: number | null;
  uptime: number;
  pinned: boolean;
  dismissed: boolean;
  killed: boolean;
  isAlive: boolean;
  headline?: string | null;
  last_message_preview?: string | null;
  last_message_role?: string | null;
  project_path?: string | null;
  git_branch?: string | null;
  worktree_name?: string | null;
  model?: string | null;
  agent_pid?: number | null;
  pid?: number | null;
  message_count?: number | null;
  is_subagent?: boolean | null;
  current_memory?: number | null;
  current_cpu?: number | null;
  current_pid_count?: number | null;
};

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const PROCESS_WORDS: Record<ModernSessionsRowData["bucket"], { word: string; title: string }> = {
  active: { word: "process up", title: "Its process is alive and recently active" },
  idle: { word: "process idle", title: "Its process is alive but has been idle while awake (sleep excluded)" },
  dead: { word: "no process", title: "No live process: the row is stale" },
  hibernated: { word: "hibernated", title: "Its process was stopped to free the machine; it resumes on the next send" },
};

export function ModernSessionsRow({ row, inbox, now, busy, expanded, parking, onToggleExpand, onPin, onStash, onKill, onPrune, children }: {
  row: ModernSessionsRowData;
  /** The inbox's own row for the conversation, when the store holds it. */
  inbox?: InboxSession;
  now: number;
  busy: boolean;
  expanded: boolean;
  /** A hibernate request is out for it. */
  parking: boolean;
  onToggleExpand: () => void;
  onPin: () => void;
  onStash: () => void;
  onKill: () => void;
  onPrune: () => void;
  /** The expanded metrics chart. */
  children?: ReactNode;
}) {
  const status: SessionStatus = row.killed ? "killed" : row.dismissed ? "stashed" : inbox
    ? sessionStatusOf({ row: inbox, placement: railRowPlacement(inbox, now), now })
    // No inbox row (a tmux-only process): what its live status says.
    : sessionStatusOf({ row: { agent_status: row.agent_status, message_count: row.message_count ?? 1, updated_at: row.lastActiveAt, last_heartbeat: row.last_heartbeat }, now });
  const line = inbox ? sessionCardLine({ row: inbox, status, now }) : null;
  const meta = SESSION_STATUS[status];
  const title = row.conversation_title || row.tmux_session || row.session_id.slice(0, 12);
  const about = row.headline || row.last_message_preview || line?.text || "";
  const facts = [
    row.project_path ? row.project_path.split("/").filter(Boolean).pop() : null,
    row.git_branch,
    row.worktree_name ? `wt:${row.worktree_name}` : null,
    row.model,
    `pid:${row.agent_pid ?? row.pid ?? "-"}`,
    row.message_count != null ? `${row.message_count} msgs` : null,
    `up ${duration(row.uptime)}`,
    row.is_subagent ? "subagent" : null,
    row.isAlive && row.current_memory ? `${(row.current_memory / (1024 * 1024)).toFixed(0)}MB` : null,
    row.isAlive && row.current_cpu ? `${row.current_cpu.toFixed(1)}% cpu` : null,
    row.isAlive && row.current_pid_count ? `${row.current_pid_count} procs` : null,
  ].filter(Boolean);
  const process = PROCESS_WORDS[row.bucket];
  return (
    <div
      data-mc-status={status}
      className={`rounded-card border bg-sol-card transition-colors ${row.pinned ? "border-sol-magenta/40" : "border-sol-border"} ${row.bucket === "dead" || row.dismissed ? "opacity-60" : ""} ${busy ? "opacity-40" : "hover:border-sol-text-dim/50"}`}
    >
      <div
        className="cursor-pointer px-4 py-3"
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("a") || target.closest("button")) return;
          onToggleExpand();
        }}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex min-w-0 flex-1 basis-[16rem] items-center gap-2">
            <span className="flex w-4 shrink-0 justify-center"><SessionStatusMark status={status} /></span>
            {row.conversation_id ? (
              <Link href={`/conversation/${row.conversation_id}`} className="min-w-0 truncate text-body font-medium text-sol-text hover:underline underline-offset-2">{title}</Link>
            ) : (
              <span className="min-w-0 truncate text-body text-sol-text-muted">{title}</span>
            )}
          </span>
          <span className="shrink-0 text-meta tabular-nums text-sol-text-dim" title={`Last active ${new Date(row.lastActiveAt).toLocaleString()}`}>
            {duration(row.lastActiveMs)} ago
          </span>
          <span className="shrink-0 font-mono text-meta text-sol-text-dim" title={process.title}>
            {row.bucket === "idle" ? `${process.word} ${duration(row.awakeIdleMs)}` : process.word}
          </span>
          <HibernatedMarker status={row.agent_status} compact />
          {parking && <span className="shrink-0 text-meta text-sol-text-dim">parking requested</span>}
          <span className="flex shrink-0 items-center gap-1">
            {busy ? (
              <span className="text-meta text-sol-text-dim">Working…</span>
            ) : (
              <>
                {row.conversation_id && <Button variant="ghost" size="xs" onClick={onPin} title={row.pinned ? "Unpin" : "Pin to the top of the inbox"}>{row.pinned ? "Unpin" : "Pin"}</Button>}
                {row.conversation_id && <Button variant="ghost" size="xs" onClick={onStash} title={row.dismissed ? "Restore to the inbox" : "Stash from the inbox; the agent keeps running"}>{row.dismissed ? "Restore" : "Stash"}</Button>}
                {row.bucket === "dead"
                  ? <Button variant="ghost" size="xs" onClick={onPrune} title="Remove this stale row (no live process to kill)">Prune</Button>
                  : row.conversation_id && <Button variant="ghost" size="xs" onClick={onKill} className="hover:text-sol-red" title="Kill this session">Kill</Button>}
              </>
            )}
          </span>
        </div>
        <p className="mt-1 truncate pl-6 text-ui" title={[line?.reasonTitle, about].filter(Boolean).join("\n") || meta.meaning}>
          <SessionStatusWord status={status} className="font-medium" />
          {line?.reason && <span className={meta.text}><span aria-hidden className="text-sol-text-dim"> · </span>{line.reason}</span>}
          {about && <span className="text-sol-text-muted"><span aria-hidden className="text-sol-text-dim"> · </span>{!row.headline && row.last_message_role ? `${row.last_message_role}: ` : ""}{about}</span>}
        </p>
        <div className="mt-1 truncate pl-6 font-mono text-meta text-sol-text-dim">{facts.join(" · ")}</div>
      </div>
      {expanded && children}
    </div>
  );
}
