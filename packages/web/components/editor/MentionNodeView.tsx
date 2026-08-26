import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { AvatarImg } from "../../lib/avatarCache";
import { User, Calendar } from "lucide-react";
import { EntityIdPill } from "../EntityIdPill";
import type { EntityType } from "../../lib/entityLinks";

const ROUTE_MAP: Record<string, string> = {
  person: "/team",
};

function PersonMention({ attrs }: { attrs: Record<string, any> }) {
  return (
    <a
      href={`${ROUTE_MAP.person}/${attrs.id}`}
      className="mention-inline mention-inline-person"
    >
      <AvatarImg
        src={attrs.image}
        alt=""
        className="w-[18px] h-[18px] rounded-full object-cover"
        fallback={
          <span className="w-[18px] h-[18px] rounded-full bg-[#859900]/20 flex items-center justify-center flex-shrink-0">
            <User className="w-3 h-3 text-[#859900]" />
          </span>
        }
      />
      <span className="mention-inline-label">{attrs.label}</span>
    </a>
  );
}

const RELATIVE_DATE_LABELS = new Set([
  "today", "yesterday", "tomorrow",
  "this week", "last week", "next week",
  "this month", "last month", "next month",
]);

function recomputeRelativeLabel(dateValue: string): string | null {
  const parts = dateValue.split("-");
  if (parts.length !== 3) return null;
  const target = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === -1) return "Yesterday";
  if (diffDays === 1) return "Tomorrow";
  return null;
}

function DateMention({ attrs }: { attrs: Record<string, any> }) {
  const dateValue = attrs.dateValue || attrs.id;
  const storedLabel: string = attrs.label || dateValue;

  // If the stored label is a relative term (e.g. "Today" from when the doc
  // was written), recompute it against the current date so old docs don't
  // claim to be from "today" forever.
  const isRelative = RELATIVE_DATE_LABELS.has(String(storedLabel).toLowerCase());
  const recomputed = isRelative && dateValue ? recomputeRelativeLabel(dateValue) : null;
  const label = isRelative ? (recomputed ?? dateValue) : storedLabel;

  let resolvedDisplay = "";
  if (dateValue) {
    const parts = dateValue.split("-");
    if (parts.length === 3) {
      const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
      const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      resolvedDisplay = `${DAYS[d.getDay()]}, ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
    }
  }

  const showResolved = resolvedDisplay && resolvedDisplay !== label;

  return (
    <span className="mention-inline mention-inline-date">
      <Calendar className="w-[14px] h-[14px] flex-shrink-0 text-[#cb4b16]" />
      <span className="mention-inline-label">{label}</span>
      {showResolved && (
        <span className="mention-date-resolved">{resolvedDisplay}</span>
      )}
    </span>
  );
}

export { PersonMention, DateMention };

// Object mentions render the same live pill as read mode (EntityIdPill: live
// title/status/avatar + hover card), so a reference looks identical while a
// doc is being edited and while it is being read. An unresolved id degrades
// exactly like read mode does: a pill labeled with the short id or type.
// Person/date mentions have no read-mode pill twin and keep their inline chips.
const OBJECT_MENTION_TYPES = new Set<EntityType>(["task", "doc", "plan", "session"]);

export function MentionNodeView({ node }: NodeViewProps) {
  const attrs = node.attrs;
  const mtype = attrs.type || "doc";

  if (OBJECT_MENTION_TYPES.has(mtype)) {
    return (
      <NodeViewWrapper as="span" style={{ display: "inline" }}>
        <EntityIdPill type={mtype as EntityType} id={attrs.id} />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="mention-node-wrap">
      {mtype === "person" && <PersonMention attrs={attrs} />}
      {mtype === "date" && <DateMention attrs={attrs} />}
    </NodeViewWrapper>
  );
}
