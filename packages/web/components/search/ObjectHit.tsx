// One object a search found (a to-do, plan, note, routine, project, goal,
// role, person or published page), drawn with the marks and facts its card
// draws wherever it is shared (EntityObjectCard: EntityKindIcon, CardMetaLine),
// so a task reads the same in a search, a message and its board.
import { memo } from "react";
import Link from "next/link";
import { Globe } from "lucide-react";
import { EntityKindIcon, CardMetaLine } from "../EntityObjectCard";
import { AuthorAvatar } from "../entityDisplay";
import { RoleFace } from "../org/RoleFace";
import { ShortId } from "../ShortId";
import { StampTime } from "../StampTime";
import { highlightMatch } from "../../lib/searchHighlight";
import { memberAvatarUrl } from "../../lib/liveEntities";
import { useSurface } from "../../lib/surfaces";
import type { ObjectHit as Hit } from "../../hooks/useObjectSearch";

/** The kinds whose card carries a facts line worth a row's second line. */
const WITH_META = new Set(["task", "plan", "doc", "trigger"]);

function Mark({ hit }: { hit: Hit }) {
  if (hit.kind === "person") return <AuthorAvatar name={hit.title} avatar={memberAvatarUrl(hit.entity)} size={16} />;
  if (hit.kind === "role") return <RoleFace role={hit.entity} size={16} />;
  if (!hit.type) return <Globe className="h-3.5 w-3.5 text-sol-cyan" />;
  return <EntityKindIcon type={hit.type} entity={hit.entity} />;
}

export const ObjectHit = memo(function ObjectHit({ hit, highlight, selected = false, onHover }: {
  hit: Hit;
  highlight: string;
  selected?: boolean;
  onHover?: () => void;
}) {
  const internals = useSurface("search.internals");
  const shortId = internals ? hit.entity?.short_id : null;
  const handle = hit.kind === "role" && hit.entity?.handle ? `@${hit.entity.handle}` : null;
  const done = hit.kind === "task" && (hit.entity?.status === "done" || hit.entity?.status === "dropped");
  return (
    <Link
      href={hit.href}
      target={hit.external ? "_blank" : undefined}
      onMouseEnter={onHover}
      data-search-object={hit.kind}
      data-selected={selected || undefined}
      className={`flex min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 no-underline transition-colors ${
        selected ? "border-sol-border bg-sol-bg-alt shadow-sm" : "border-transparent hover:border-sol-border/60 hover:bg-sol-bg-alt/60"
      }`}
    >
      <span className="mt-[3px] flex h-4 w-4 flex-shrink-0 items-center justify-center"><Mark hit={hit} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={`min-w-0 truncate text-[14px] ${done ? "text-sol-text-muted" : "text-sol-text"}`}>{highlightMatch(hit.title, highlight)}</span>
          {handle && <span className="flex-shrink-0 font-mono text-[11px] text-sol-text-dim">{highlightMatch(handle, highlight)}</span>}
        </span>
        {hit.type && WITH_META.has(hit.kind) && hit.entity && <CardMetaLine type={hit.type} entity={hit.entity} />}
      </span>
      <ShortId id={shortId} className="mt-[3px] text-[10px] text-sol-text-dim" />
      {hit.at ? <span className="mt-[2px] flex-shrink-0 text-[11px] tabular-nums text-sol-text-dim"><StampTime ts={hit.at} /></span> : null}
    </Link>
  );
});
