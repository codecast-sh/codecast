"use client";
// The right click menu on a People chart card. A session gets the inbox's own
// session verbs; every card that can move gets "Move to…" (the first dozen
// targets inline, the rest in the picker); people and roles fold and unfold.
// Opening a card goes where a click goes: a role to its session, a person to
// their profile, a session to its conversation.
import { ArrowRightLeft, ChevronDown, ChevronRight, ExternalLink, Search, User } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { CtxHeader, CtxItem, CtxSeparator, CtxSub, CtxSubContent, CtxSubTrigger } from "../ui/context-menu";
import { SessionMenuItems } from "../menus/ObjectContextMenus";
import { Avatar } from "../tasks/TaskCommentStream";
import type { OrgGraphObject } from "./OrgGraph";
import type { OrgLayoutNode } from "./orgLayout";
import type { MoveSubject } from "./useOrgPeopleView";
import type { OrgMoves } from "./useOrgMoves";
import { sameParent, type OrgParentRef } from "./orgTypes";

const INLINE_TARGETS = 12;

export function OrgNodeMenu({ node, moves, currentParentOf, onToggleCollapse, onOpenSession, onOpenObject }: {
  node: OrgLayoutNode;
  moves: Pick<OrgMoves, "canEditRole" | "canMoveSession" | "targetsFor" | "move" | "openPicker">;
  currentParentOf: (s: MoveSubject) => OrgParentRef | null;
  onToggleCollapse: (nodeId: string) => void;
  onOpenSession: (conversationId: string) => void;
  /** False when the store cannot name the card's page yet. */
  onOpenObject: (o: OrgGraphObject) => boolean;
}) {
  const moveTo = (subject: MoveSubject) => {
    const cur = currentParentOf(subject);
    const list = moves.targetsFor(subject);
    return (
      <CtxSub>
        <CtxSubTrigger icon={ArrowRightLeft}>Move to…</CtxSubTrigger>
        <CtxSubContent>
          {list.slice(0, INLINE_TARGETS).map((t) => {
            const isCur = !!cur && sameParent(cur, t.ref);
            return (
              <CtxItem
                key={t.id}
                disabled={isCur}
                onSelect={() => moves.move(subject, t.ref, t.title)}
                leading={t.kind === "person" ? <Avatar name={t.title} image={t.image} /> : <span className="w-4 h-4 rounded inline-flex items-center justify-center text-[8px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>@</span>}
                trailing={isCur ? <span className="text-[10px]" style={{ color: "var(--sol-text-dim)" }}>current</span> : undefined}
                data-move-target={t.id}
              >
                {t.title}
              </CtxItem>
            );
          })}
          {list.length > INLINE_TARGETS && <CtxItem icon={Search} onSelect={() => moves.openPicker(subject)}>More…</CtxItem>}
        </CtxSubContent>
      </CtxSub>
    );
  };
  const fold = (n: { id: string; collapsed: boolean }) => (
    <CtxItem icon={n.collapsed ? ChevronRight : ChevronDown} onSelect={() => onToggleCollapse(n.id)}>{n.collapsed ? "Expand" : "Collapse"}</CtxItem>
  );

  if (node.kind === "session") {
    const st = useInboxStore.getState();
    const row = st.sessions[node.session._id];
    const foreign = !row || String((row as { user_id?: string }).user_id ?? "") !== String(st.currentUser?._id ?? "");
    return (
      <>
        {row ? (
          <SessionMenuItems session={row} isForeign={foreign} onOpen={() => onOpenSession(node.session._id)} />
        ) : (
          <>
            <CtxHeader title={node.session.title || "Session"} id={node.session.short_id} />
            <CtxItem icon={ExternalLink} onSelect={() => onOpenSession(node.session._id)}>Open</CtxItem>
          </>
        )}
        {moves.canMoveSession(node.session) && (
          <>
            <CtxSeparator />
            {moveTo({ kind: "session", id: node.session._id, title: node.session.title || node.session.short_id })}
          </>
        )}
      </>
    );
  }
  if (node.kind === "role") {
    const r = node.role;
    return (
      <>
        <CtxHeader title={r.name} id={`@${r.handle}`} />
        {r.standing?.conversation_id && <CtxItem icon={ExternalLink} onSelect={() => onOpenObject({ kind: "role", id: r._id })}>Open its session</CtxItem>}
        {fold(node)}
        {moves.canEditRole(r._id) && (
          <>
            <CtxSeparator />
            {moveTo({ kind: "role", id: r._id, title: r.name })}
          </>
        )}
      </>
    );
  }
  if (node.kind === "person") {
    return (
      <>
        <CtxHeader title={node.person.name} />
        <CtxItem icon={User} onSelect={() => onOpenObject({ kind: "person", id: node.person.user_id })}>Open profile</CtxItem>
        {fold(node)}
      </>
    );
  }
  return node.kind === "cluster" ? <CtxHeader title={`+${node.remaining} sessions`} /> : null;
}
