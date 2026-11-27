// A plain session's mark (SessionMark, SessionTag.tsx): the small square that
// leads a session row, so a long list of sessions can be told apart at a
// glance. Its colour is the session's workspace (the same swatch as that
// workspace's row in the sidebar), and the glyph inside is the agent running
// it, drawn in the same ink.
import { AgentTypeIcon } from "../AgentTypeIcon";
import { workspaceNameOf, workspaceColorOf } from "../../lib/projectColors";
import { useWorkspaceColor } from "../../lib/labelColors";

/** The workspace tile alone, with no face lookup. */
export function WorkspaceTile({ row, size = 20, showAgent = true, quiet, className = "" }: {
  row: { agent_type?: unknown; git_root?: unknown; project_path?: unknown };
  size?: number;
  /** Off, the tile carries the workspace's first letter instead of the agent. */
  showAgent?: boolean;
  /** The agent mark keeps no tooltip (SessionMark's `quiet`). */
  quiet?: boolean;
  className?: string;
}) {
  const colorOf = useWorkspaceColor();
  const workspace = workspaceNameOf({ git_root: str(row.git_root), project_path: str(row.project_path) });
  const color = workspaceColorOf(workspace, colorOf);
  const agent = str(row.agent_type) || "claude_code";
  // The agent glyph names itself and its workspace on hover; the letter tile has only the title.
  const glyph = showAgent ? AgentTypeIcon({ agentType: agent, mono: true, quiet, className: "h-[58%] w-[58%]", hint: workspace ?? undefined }) : null;
  return (
    <span
      data-cc-mark
      title={glyph ? undefined : workspace ?? undefined}
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-[5px] ${color.text} ${className}`}
      style={{ width: size, height: size, backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}
    >
      {glyph ?? (
        <span aria-hidden className="font-semibold uppercase leading-none" style={{ fontSize: Math.round(size * 0.55) }}>
          {(workspace ?? "·").charAt(0)}
        </span>
      )}
    </span>
  );
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
