// A session named in a line: its glyph (face, or agent brand for a plain
// session) and its identity line ("Whisker: the title"). Every place that
// names a session beside other content (a comment's author, a timeline row, a
// linked session) draws this, at one of a few sizes, so a session reads the
// same everywhere.
import type { ReactNode } from "react";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { SessionGlyph } from "./SessionGlyph";
import { SessionIdentityLine } from "./SessionIdentityLine";
import { identityRowOf, type IdentityRow } from "../../lib/sessionIdentity";

export type SessionTagSize = "xs" | "sm" | "md" | "lg";

const SIZES: Record<SessionTagSize, { face: number; icon: string; text: string; gap: string }> = {
  xs: { face: 14, icon: "w-3 h-3", text: "text-[11px]", gap: "gap-1" },
  sm: { face: 16, icon: "w-3.5 h-3.5", text: "text-xs", gap: "gap-1.5" },
  md: { face: 20, icon: "w-4 h-4", text: "text-xs", gap: "gap-1.5" },
  lg: { face: 28, icon: "w-5 h-5", text: "text-sm", gap: "gap-2" },
};

type TagRow = IdentityRow & { agent_type?: string | null } & Record<string, unknown>;

/** A session's one glyph with its agent brand: the face with the brand on its
 *  corner when the session is personified, the brand alone when it is not. */
export function SessionMark({ session, size = 16, iconClassName = "w-3.5 h-3.5", className = "flex-shrink-0" }: {
  session: TagRow;
  size?: number;
  /** The plain brand's box, sized to sit beside the surface's text. */
  iconClassName?: string;
  className?: string;
}) {
  const agent = session.agent_type || "claude_code";
  return (
    <SessionGlyph
      row={identityRowOf(session)}
      size={size}
      className={className}
      badge={<AgentTypeIcon agentType={agent} className="w-full h-full p-[1px]" />}
      fallback={
        <span className={`inline-flex ${className}`} title={agent}>
          <AgentTypeIcon agentType={agent} className={iconClassName} />
        </span>
      }
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
      <SessionMark session={session} size={s.face} iconClassName={s.icon} />
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
