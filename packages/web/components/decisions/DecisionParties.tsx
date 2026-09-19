"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useInboxStore, useTrackedStore, getProjectName, type SessionDecisionItem } from "../../store/inboxStore";
import { resolveAssigneeInfo, memberDisplayName, memberAvatarUrl } from "../../lib/liveEntities";
import { Avatar } from "../tasks/TaskCommentStream";
import { useJumpToDecisionAsk } from "../../hooks/useJumpToDecisionAsk";
import { isHumanOnlyCategory } from "@codecast/convex/convex/lib/decisionCategory";
import { SessionGlyph } from "../identity";
import { identityRowOf } from "../../lib/sessionIdentity";

// Who is in a decision: the session that asked, the person who holds it, and
// what its category means. One rendering for the queue card and the document
// page, so the same question never introduces its parties two ways.

/** The asking session as one line: a live dot, its name, its project. The
 *  name comes from the store row when the session is cached, else the row's
 *  own copy, which the server refreshes from the conversation on every read.
 *  Clicking scrolls the thread to the ask itself. */
export function AskingSession({
  decision,
  className = "",
}: {
  decision: Pick<SessionDecisionItem, "conversation_id" | "_id" | "question" | "session_title" | "project_path">;
  className?: string;
}) {
  const s = useTrackedStore([
    (st) => st.sessions[decision.conversation_id]?.title,
    (st) => st.sessions[decision.conversation_id]?.project_path,
    (st) => st.sessions[decision.conversation_id]?.status,
    // Identity, so the face re-renders when someone changes the character.
    (st) => st.sessions[decision.conversation_id]?.character_avatar,
    (st) => st.sessions[decision.conversation_id]?.standing_role_id,
  ]);
  const session = s.sessions[decision.conversation_id];
  const jumpToAsk = useJumpToDecisionAsk(decision.conversation_id, decision._id, decision.question);
  const title = session?.title || decision.session_title;
  const project = session?.project_path || decision.project_path;
  const live = session?.status === "running" || session?.status === "working";
  return (
    <span className={`inline-flex items-center gap-1.5 min-w-0 ${className}`} data-asking-session={decision.conversation_id}>
      {/* Who is asking (session-characters.md S3), then whether it is live. */}
      <SessionGlyph row={session ? identityRowOf(session as any) : null} size={14} className="shrink-0" />
      <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${live ? "bg-sol-green" : "bg-sol-text-dim"}`} />
      <Link
        href={`/conversation/${decision.conversation_id}`}
        className="truncate text-sol-text-muted hover:text-sol-blue transition-colors"
        title={title ? `${title} — go to the ask in the conversation` : "Go to the ask in the conversation"}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          void jumpToAsk();
        }}
      >
        {title || "a session with no name yet"}
      </Link>
      {project && <span className="truncate text-sol-text-dim">{getProjectName(project)}</span>}
    </span>
  );
}

/** A person, with their face, linked to their profile when we know their
 *  handle. The roster is the source: a teammate who changed their name or
 *  picture shows the new one on every decision at once. */
export function PersonChip({
  userId,
  fallbackName,
  fallbackImage,
  className = "",
}: {
  userId?: string;
  fallbackName?: string;
  fallbackImage?: string;
  className?: string;
}) {
  const s = useTrackedStore([(st) => st.teamMembers?.length, (st) => (st as any).currentUser?._id]);
  const info = resolveAssigneeInfo(
    userId,
    fallbackName ? { name: fallbackName, image: fallbackImage } : null,
    s.teamMembers as any,
    (s as any).currentUser,
  );
  const name = info?.name ?? fallbackName;
  if (!name) return null;
  const handle = (info as any)?.github_username as string | undefined;
  const body = (
    <span className={`inline-flex items-center gap-1.5 min-w-0 ${handle ? "hover:opacity-80" : ""} ${className}`}>
      <Avatar name={name} image={info?.image ?? fallbackImage} />
      <span className="truncate text-sol-text">{name}</span>
    </span>
  );
  return handle ? <Link href={`/team/${handle}`} title={`${name}'s profile`}>{body}</Link> : body;
}

/** Everyone holding the decision right now: the people it was asked of, or
 *  the role that holds it under a grant. */
export function HolderLine({
  people,
  roleName,
  className = "",
}: {
  people: Array<{ _id: string; name: string; avatar_url?: string }>;
  roleName?: string;
  className?: string;
}) {
  if (roleName) return <span className={className}>{roleName} <span className="text-sol-text-dim">holds it under a grant</span></span>;
  if (people.length === 0) return <span className={`text-sol-text-dim ${className}`}>its people</span>;
  return (
    <span className={`inline-flex items-center gap-3 flex-wrap ${className}`}>
      {people.map((u) => <PersonChip key={u._id} userId={u._id} fallbackName={u.name} fallbackImage={u.avatar_url} />)}
    </span>
  );
}

// What a category is FOR, in the words that matter to the reader: who is
// allowed to answer. The bare word plus "assigned by the server" said
// neither. `unknown` is not a warning — it means the asker proposed nothing,
// so it stays a person's to answer; it reads as a plain sentence, not a red
// chip demanding attention the decision itself deserves.
export function categoryMeaning(category: string | undefined): string {
  if (!category || category === "unknown") return "the asker proposed none, so a person answers it";
  if (category === "limit") return "a usage limit — always a person";
  return isHumanOnlyCategory(category) ? "always a person, never a role" : "a role can earn the right to answer these";
}

export function CategoryNote({
  category,
  proposed,
  className = "",
}: {
  category?: string;
  proposed?: string;
  className?: string;
}) {
  const unset = !category || category === "unknown";
  // Who set it, and whether the asker's proposal survived. The server pins a
  // protected category whatever was proposed, and that disagreement is the
  // one part of the provenance a reader acts on.
  const overridden = !!proposed && !!category && proposed !== category;
  return (
    <span className={`inline-flex items-center gap-1.5 flex-wrap ${className}`} data-decision-category={category ?? "unknown"}>
      {!unset && (
        <span className={`px-1.5 py-0.5 rounded border ${isHumanOnlyCategory(category) ? "border-sol-red/30 text-sol-red" : "border-sol-green/30 text-sol-green"}`}>
          {category}
        </span>
      )}
      <span className="text-sol-text-dim">
        {categoryMeaning(category)}
        {overridden && ` · the server pinned it; the asker proposed ${proposed}`}
      </span>
    </span>
  );
}

/** The link out to the whole decision, for a card that shows a slice of it. */
export function OpenDecisionLink({ href, label = "open", className = "" }: { href: string; label?: string; className?: string }) {
  return (
    <Link href={href} className={`inline-flex items-center gap-1 font-mono text-sol-text-dim hover:text-sol-text ${className}`}>
      {label}<ArrowUpRight className="w-3 h-3" />
    </Link>
  );
}
