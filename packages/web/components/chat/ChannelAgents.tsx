"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Bot, Check, MessageSquare, Plus, Search, Shield, X } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { chatAgentId } from "../../store/chatSlice";
import { objectHref, isConvexId } from "../../lib/entityLinks";
import { ownTitle } from "../../lib/conversationTitle";
import type { ChatChannelAgentRef } from "./chatTypes";
import type { OrgRole } from "../org/orgTypes";
import "./chat.css";

// The roles and sessions inside a room (docs/architecture/agent-channels.md
// C5): each hears every line a person posts there. Rows for the member panel,
// and the picker that puts more in, shared with the new-channel modal.

type AgentView = { ref: ChatChannelAgentRef; id: string; name: string; sub: string; href: string };

const sessionShortId = (id: string) => id.slice(0, 7);

function roleView(role: Pick<OrgRole, "_id" | "short_id" | "name" | "handle">): AgentView {
  return {
    ref: { kind: "role", role_id: role._id, short_id: role.short_id },
    id: role._id,
    name: role.name,
    sub: `@${role.handle}`,
    href: objectHref("role", role.short_id),
  };
}

function sessionView(id: string, title: string | undefined, shortId = sessionShortId(id)): AgentView {
  return {
    ref: { kind: "session", conversation_id: id, short_id: shortId },
    id,
    name: title || shortId,
    sub: shortId,
    href: `/conversation/${id}`,
  };
}

// Names for a room's members from what the store already holds: the org tree
// for roles, the session and conversation rows for sessions. Subscribes to a
// signature of exactly those names, never the churning collections.
function useAgentViews(agents: ChatChannelAgentRef[]): AgentView[] {
  const nameOf = (s: any, a: ChatChannelAgentRef): string => {
    if (a.kind === "role") {
      const r = (s.orgTree?.roles ?? []).find((x: OrgRole) => x._id === a.role_id);
      return r ? `${r.name}\u0001${r.handle}` : "";
    }
    return ownTitle(s.sessions?.[a.conversation_id]) || ownTitle(s.conversations?.[a.conversation_id]);
  };
  const s = useTrackedStore([(st) => agents.map((a) => nameOf(st, a)).join("\u0002")]);
  return agents.map((a) => {
    const known = nameOf(s, a);
    if (a.kind === "role") {
      const [name, handle] = known.split("\u0001");
      return roleView({ _id: a.role_id, short_id: a.short_id, name: name || a.short_id, handle: handle || a.short_id });
    }
    return sessionView(a.conversation_id, known, a.short_id);
  });
}

function AgentIcon({ kind }: { kind: ChatChannelAgentRef["kind"] }) {
  return kind === "role"
    ? <Shield className="w-3.5 h-3.5 text-sol-violet shrink-0" aria-hidden="true" />
    : <MessageSquare className="w-3.5 h-3.5 text-sol-cyan shrink-0" aria-hidden="true" />;
}

/** The member panel's agents: one row each, removable by anyone in the room. */
export function ChannelAgentRows({ channelId, agents }: { channelId: string; agents: ChatChannelAgentRef[] }) {
  const views = useAgentViews(agents);
  const remove = useInboxStore((s) => s.removeChatChannelAgent);
  return (
    <>
      {views.map((v) => (
        <div className="ch-people-row ch-roster-row" key={v.id}>
          <AgentIcon kind={v.ref.kind} />
          <Link href={v.href} className="ch-people-name truncate hover:underline">{v.name}</Link>
          <span className="ch-agent-sub">{v.sub}</span>
          <button
            type="button"
            className="ch-roster-mark ch-roster-mark-in ch-roster-mark-btn"
            title={`Take ${v.name} out of this channel`}
            aria-label={`Take ${v.name} out of this channel`}
            onClick={() => remove(channelId, v.id)}
          >
            <Check className="w-3 h-3 ch-roster-mark-on" />
            <X className="w-3 h-3 ch-roster-mark-off" />
          </button>
        </div>
      ))}
    </>
  );
}

/** Roles of the workspace and the viewer's recent sessions, minus `exclude`,
 *  matching the query. Read from the store when the picker renders. */
function useAgentCandidates(exclude: Set<string>, q: string): AgentView[] {
  const roles = useInboxStore((s) => s.orgTree?.roles) as OrgRole[] | undefined;
  const sessions = useInboxStore((s) => s.sessions);
  return useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^@/, "");
    const hit = (v: AgentView) => !needle || v.name.toLowerCase().includes(needle) || v.sub.toLowerCase().includes(needle);
    const roleViews = (roles ?? [])
      .filter((r) => r.status !== "retired" && !exclude.has(r._id))
      .map(roleView)
      .filter(hit);
    const sessionViews = Object.values(sessions ?? {})
      .filter((row: any) => isConvexId(row._id) && !exclude.has(row._id))
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .map((row: any) => sessionView(row._id, ownTitle(row)))
      .filter(hit);
    return [...roleViews.slice(0, 8), ...sessionViews.slice(0, needle ? 12 : 8)];
  }, [roles, sessions, exclude, q]);
}

/** Search roles and sessions; a click toggles one. `picked` marks the ones
 *  already chosen (the new-channel modal) or in the room (the member panel). */
export function AgentPicker({
  picked,
  exclude,
  onToggle,
  autoFocus = true,
}: {
  picked: ChatChannelAgentRef[];
  exclude?: string[];
  onToggle: (agent: ChatChannelAgentRef) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const excluded = useMemo(() => new Set(exclude ?? []), [exclude]);
  const candidates = useAgentCandidates(excluded, q);
  const on = new Set(picked.map(chatAgentId));
  return (
    <div className="ch-picker">
      <div className="ch-picker-search">
        <Search className="w-3 h-3 opacity-50" />
        <input
          value={q}
          autoFocus={autoFocus}
          placeholder="Search roles and sessions"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && candidates.length === 1) {
              e.preventDefault();
              onToggle(candidates[0].ref);
              setQ("");
            }
          }}
        />
      </div>
      <div className="ch-picker-list">
        {candidates.map((v) => (
          <button
            type="button"
            key={v.id}
            className={`ch-people-row ch-picker-row ${on.has(v.id) ? "ch-picker-on" : ""}`}
            onClick={() => onToggle(v.ref)}
          >
            <AgentIcon kind={v.ref.kind} />
            <span className="ch-people-name truncate">{v.name}</span>
            <span className="ch-agent-sub">{v.sub}</span>
            {on.has(v.id) ? <Check className="w-3.5 h-3.5 text-sol-cyan shrink-0" /> : <Plus className="w-3 h-3 opacity-50 shrink-0" />}
          </button>
        ))}
        {candidates.length === 0 && <div className="ch-picker-empty">{q ? "Nothing matches" : "No roles or sessions to add"}</div>}
      </div>
    </div>
  );
}

/** The trigger's agent tally beside the facepile. */
export function AgentCount({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <span className="ch-members-agents" aria-label={`${n} ${n === 1 ? "agent" : "agents"}`}>
      <Bot className="w-3 h-3" aria-hidden="true" />
      {n}
    </span>
  );
}
