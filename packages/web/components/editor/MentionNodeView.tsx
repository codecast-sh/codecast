import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { AvatarImg } from "../../lib/avatarCache";
import { User } from "lucide-react";
import { EntityIdPill } from "../EntityIdPill";
import { DatePill } from "../DatePill";
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

// The chip itself lives in components/DatePill so the read-mode markdown
// pipeline renders the identical pill without importing tiptap.
function DateMention({ attrs }: { attrs: Record<string, any> }) {
  const iso = attrs.dateValue || attrs.id || "";
  return <DatePill iso={iso} label={attrs.label} />;
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
