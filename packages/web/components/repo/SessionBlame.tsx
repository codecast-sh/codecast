// Session blame, drawn.
//
// Two pieces. The gutter cell sits in front of a line and names the session
// behind it: a colour that runs the height of the range, and on its first
// line the person, the session and how long ago. The strip above the file
// lists the sessions that shaped it, most lines first, and hovering or picking
// one lights its lines up wherever they fall.
import Link from "next/link";
import { GitCommitHorizontal, MessagesSquare } from "lucide-react";
import { AuthorAvatar } from "../entityDisplay";
import {
  blameViaLabel,
  sessionBlameHref,
  type BlameSession,
  type SessionBlameRange,
  type SessionBlameSummary,
} from "../../lib/repoView";
import { relTimeShort } from "../../lib/utils";

const firstName = (name: string | undefined) => name?.trim().split(/\s+/)[0] ?? "";

/** What a reader learns on hover: who, which session, which commit, and how the line was traced. */
function rangeTitle(range: SessionBlameRange): string {
  const { session, git } = range;
  const commit = git ? `${git.sha.slice(0, 7)} ${git.message?.split("\n")[0] ?? ""}`.trim() : "";
  if (!session) {
    return [git?.author_name ? `${git.author_name} committed this outside a codecast session` : "No codecast session recorded", commit]
      .filter(Boolean)
      .join("\n");
  }
  return [
    session.title,
    [session.author_name, blameViaLabel(session.via)].filter(Boolean).join(" "),
    session.short_id ? `session ${session.short_id}` : "",
    commit,
  ]
    .filter(Boolean)
    .join("\n");
}

export function SessionBlameCell({
  range,
  line,
  color,
}: {
  range: SessionBlameRange | undefined;
  line: number;
  color: string | undefined;
}) {
  const starts = !!range && range.start_line === line;
  const session = range?.session ?? null;
  return (
    <div
      className={`repo-session-blame w-[17rem] shrink-0 pl-2 pr-2 text-[10px] ${starts ? "repo-blame-start" : ""}`}
      style={color ? ({ "--session-hue": color } as React.CSSProperties) : undefined}
      data-session={session?.conversation_id}
      title={range ? rangeTitle(range) : undefined}
    >
      {starts && range && (session ? <SessionLabel session={session} range={range} /> : <UnattributedLabel range={range} />)}
    </div>
  );
}

function SessionLabel({ session, range }: { session: BlameSession; range: SessionBlameRange }) {
  return (
    <Link
      href={sessionBlameHref(session)}
      className="flex items-center gap-1.5 min-w-0 text-sol-text-muted hover:text-sol-text transition-colors"
    >
      <AuthorAvatar name={session.author_name} avatar={session.author_image} size={12} />
      <span className="truncate">{session.title}</span>
      {session.via === "edit" && (
        <span className="shrink-0 text-[9px] uppercase tracking-wide" style={{ color: "var(--session-hue)" }} aria-label="wrote this line">
          wrote
        </span>
      )}
      {range.newest_at ? (
        <span className="ml-auto shrink-0 tabular-nums text-sol-text-dim">{relTimeShort(range.newest_at)}</span>
      ) : null}
    </Link>
  );
}

function UnattributedLabel({ range }: { range: SessionBlameRange }) {
  const git = range.git;
  return (
    <span className="flex items-center gap-1.5 min-w-0 text-sol-text-dim">
      <GitCommitHorizontal className="w-3 h-3 shrink-0 opacity-60" />
      <span className="truncate">{git?.author_login || git?.author_name || "no session"}</span>
      {git?.committed_at ? <span className="ml-auto shrink-0 tabular-nums">{relTimeShort(git.committed_at)}</span> : null}
    </span>
  );
}

/**
 * The sessions that shaped the file, as a row of chips. A chip is hovered to
 * see the session's lines, clicked to keep them lit and jump to the first.
 */
export function SessionBlameStrip({
  summary,
  colors,
  focus,
  pinned,
  onFocus,
  onPick,
}: {
  summary: SessionBlameSummary;
  colors: ReadonlyMap<string, string>;
  focus: string | null;
  pinned: string | null;
  onFocus: (id: string | null) => void;
  onPick: (id: string, firstLine: number) => void;
}) {
  if (summary.total === 0) return null;
  const pct = Math.round((summary.attributed / summary.total) * 100);
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-sol-border/30 shrink-0 min-w-0 overflow-x-auto">
      <span className="text-[11px] text-sol-text-dim tabular-nums shrink-0" title={`${summary.attributed} of ${summary.total} lines trace to a codecast session`}>
        {summary.entries.length === 0
          ? "No lines trace to a codecast session"
          : `${pct}% by ${summary.entries.length} ${summary.entries.length === 1 ? "session" : "sessions"}`}
      </span>
      {summary.entries.map((entry) => {
        const id = entry.session.conversation_id;
        const color = colors.get(id);
        const active = focus === id || pinned === id;
        return (
          <span
            key={id}
            data-active={active}
            className="repo-session-chip flex items-center h-[22px] rounded-full border border-sol-border/40 text-[11px] text-sol-text-muted shrink-0 max-w-[20rem]"
            style={{ "--session-hue": color } as React.CSSProperties}
            onMouseEnter={() => onFocus(id)}
            onMouseLeave={() => onFocus(null)}
          >
            <button
              type="button"
              onClick={() => onPick(id, entry.first_line)}
              className="flex items-center gap-1.5 min-w-0 h-full pl-2 pr-1.5 hover:text-sol-text"
              title={`${entry.session.title}\n${entry.lines} lines in ${entry.ranges} ${entry.ranges === 1 ? "place" : "places"}${entry.session.author_name ? `\n${entry.session.author_name}` : ""}\nClick to jump to line ${entry.first_line}`}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
              <span className="truncate">{entry.session.title}</span>
              {firstName(entry.session.author_name) && (
                <span className="text-sol-text-dim shrink-0">{firstName(entry.session.author_name)}</span>
              )}
              <span className="tabular-nums text-sol-text-dim shrink-0">{entry.lines}</span>
            </button>
            <Link
              href={sessionBlameHref(entry.session)}
              className="flex items-center h-full pr-2 pl-0.5 text-sol-text-dim hover:text-sol-text"
              title="Open the session"
              aria-label={`Open ${entry.session.title}`}
            >
              <MessagesSquare className="w-3 h-3" />
            </Link>
          </span>
        );
      })}
    </div>
  );
}
