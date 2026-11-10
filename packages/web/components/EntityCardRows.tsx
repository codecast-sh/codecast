// The rows an expanded entity card lists (comments, a plan's tasks) and the
// markdown they render in.
import { taskVisual } from "./TaskStatusBadge";
import { MarkdownBlocks } from "./tools/MarkdownRenderer";
import { relativeTime } from "../lib/entityDisplay";
import { useRoleAuthor } from "../hooks/useLiveIdentityRow";

// Markdown rendered inside a card: the same shared blocks as doc transclusion,
// with the same list-outside override (see DocEmbed for why).
export function CardMarkdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 text-[13px] [overflow-wrap:anywhere] [&_ol]:!list-outside [&_ol]:!pl-5 [&_ul]:!list-outside [&_ul]:!pl-5">
      <MarkdownBlocks content={content} />
    </div>
  );
}

export function CommentRows({ comments }: { comments: any[] }) {
  const roleAuthor = useRoleAuthor();
  const ordered = [...comments].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  if (ordered.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t border-[color-mix(in_srgb,var(--sol-border)_55%,transparent)] pt-2">
      {ordered.map((c: any, i: number) => (
        <div key={c._id ?? i} className="space-y-1 text-[12px] leading-relaxed">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sol-text-muted">
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{roleAuthor({ userId: c.author_user_id, session: c.session_info })?.name || c.session_info?.title || c.author}</span>
            {c.created_at && <span className="text-[11px] text-sol-text-dim">{relativeTime(c.created_at)}</span>}
          </div>
          <CardMarkdown content={c.text || ""} />
        </div>
      ))}
    </div>
  );
}

export function PlanTaskRows({ tasks }: { tasks: any[] }) {
  if (!tasks || tasks.length === 0) return null;
  return (
    <div className="space-y-1">
      {tasks.map((t: any) => {
        const v = taskVisual(t.status);
        return (
          <div key={t._id} className="flex items-start gap-2 py-1 text-[13px]">
            <v.icon className={`h-3 w-3 flex-shrink-0 ${v.color}`} />
            <span className={`min-w-0 [overflow-wrap:anywhere] ${t.status === "done" ? "text-sol-text-dim line-through" : "text-sol-text-muted"}`}>
              {t.title}
            </span>
            {t.assignee_info?.name && (
              <span className="ml-auto flex-shrink-0 text-[10px] text-sol-text-dim">{t.assignee_info.name}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
