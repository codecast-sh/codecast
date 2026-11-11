// A session named in a line: its glyph (face, or for a plain session its
// workspace tile with the agent inside, WorkspaceTile.tsx) and its identity line ("Whisker: the title"). Every place that
// names a session beside other content (a comment's author, a timeline row, a
// linked session) draws this, at one of a few sizes, so a session reads the
// same everywhere.
import type { ReactNode } from "react";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { WorkspaceTile } from "./WorkspaceTile";
import { SessionGlyph } from "./SessionGlyph";
import { SessionIdentityLine } from "./SessionIdentityLine";
import { identityRowOf, type IdentityRow } from "../../lib/sessionIdentity";

export type SessionTagSize = "xs" | "sm" | "md" | "lg";

const SIZES: Record<SessionTagSize, { face: number; text: string; gap: string }> = {
  xs: { face: 14, text: "text-meta", gap: "gap-1" },
  sm: { face: 16, text: "text-xs", gap: "gap-1.5" },
  md: { face: 20, text: "text-xs", gap: "gap-1.5" },
  lg: { face: 28, text: "text-sm", gap: "gap-2" },
};

type TagRow = IdentityRow & { agent_type?: string | null } & Record<string, unknown>;

/** A session's one glyph: the face with the agent brand on its corner when the
 *  session is personified, else its workspace tile with the agent inside. Every
 *  list of sessions leads its rows with this, so a session looks the same on
 *  the board, the rail, a task and the org chart. */
export function SessionMark({ session, size = 16, showAgent = true, className = "flex-shrink-0" }: {
  session: TagRow;
  size?: number;
  /** Off (the viewer hid agent icons), the tile shows the workspace's initial. */
  showAgent?: boolean;
  className?: string;
}) {
  const agent = session.agent_type || "claude_code";
  return (
    <SessionGlyph
      row={identityRowOf(session)}
      size={size}
      className={className}
      badge={showAgent ? <AgentTypeIcon agentType={agent} className="w-full h-full p-[1px]" /> : undefined}
      fallback={<WorkspaceTile row={session} size={size} showAgent={showAgent} className={className} />}
    />
  );
}

export function SessionTag({
  session, title, size = "sm", onClick, className, titleClassName, after,
}: {
  session: TagRow;
  /** The display title, already cleaned; defaults to the row's own. */
  title?: string | null;
  size?: SessionTagSize;
  /** Makes the tag a button (open the session). */
  onClick?: () => void;
  className?: string;
  titleClassName?: string;
  /** Chips that follow the title on the same line. */
  after?: ReactNode;
}) {
  const s = SIZES[size];
  const content = (
    <>
      <SessionMark session={session} size={s.face} />
      <SessionIdentityLine
        row={session}
        title={(title ?? session.title ?? "").trim() || "Untitled session"}
        className="min-w-0"
        titleClassName={titleClassName}
        after={after}
      />
    </>
  );
  const cls = `inline-flex items-center min-w-0 ${s.gap} ${s.text} ${className ?? ""}`;
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} text-left hover:opacity-80 transition-opacity`}>
      {content}
    </button>
  ) : (
    <span className={cls}>{content}</span>
  );
}
