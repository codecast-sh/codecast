"use client";

/**
 * The agents working for this session, under the session_owners model: its
 * sub-agents and the sessions it spawned, which it owns, so they stay out of
 * every inbox (store `sessionAgents`, fed by hooks/useSyncSessionOwners).
 * Collapsed it is one line, "N agents · M working"; open, each agent with its
 * state and owners, and Add me, which puts it in your inbox ("In your inbox"
 * takes it out again). Nothing for a session off the model or with no agents.
 */

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { ownersModelOnFor } from "../../store/sessionOwnersSlice";
import { agentOwnersOf, agentStateOf, agentsSig, type SessionAgentRow } from "../../lib/sessionAgents";
import { holdOwnerCard } from "../../lib/visibleOwnerCards";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useOpenSession } from "../../hooks/useOpenSession";
import { SESSION_STATUS, type SessionStatus } from "../../lib/sessionStatus";
import { SessionMark } from "../identity";
import { AssigneeFace } from "../identity/AssigneeFace";
import { ParentSessionFace } from "../OwnersMenu";
import { applyOwnersWithToast } from "../../lib/ownersGestures";
import { Button } from "../ui/button";

const BUSY = new Set<SessionStatus>(["working", "starting"]);

export function SessionAgentsBand({ conversationId }: { conversationId: string }) {
  const sig = useInboxStore((s) => (ownersModelOnFor(s as never, conversationId) ? agentsSig(s, conversationId) : ""));
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const parentTitle = useInboxStore((s: any) => s.sessions?.[conversationId]?.title ?? s.conversations?.[conversationId]?.title ?? "This session");
  const [open, setOpen] = useState(false);
  const openSession = useOpenSession();
  // Its agents' owners come from the owners home, read with the cards on
  // screen while the band is open (closed, it draws no owners).
  const agentIds = sig && open ? sig.split("|").map((a) => a.split(":")[0]).join(",") : "";
  useWatchEffect(() => {
    const releases = agentIds ? agentIds.split(",").map(holdOwnerCard) : [];
    return () => { for (const release of releases) release(); };
  }, [agentIds]);
  if (!sig) return null;
  const st = useInboxStore.getState() as any;
  const agents: SessionAgentRow[] = st.sessionAgents?.[conversationId]?.agents ?? [];
  const busy = agents.filter((a) => BUSY.has(agentStateOf(a.agent_status))).length;
  return (
    <div data-cc-agents-band className="flex-shrink-0 border-b border-sol-border/60 bg-sol-bg-alt">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full min-h-[32px] items-center gap-2 px-4 py-1.5 text-ui text-sol-text-muted hover:text-sol-text">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span className="font-medium">{agents.length} {agents.length === 1 ? "agent" : "agents"}</span>
        <span className="text-sol-text-dim">· {busy} working</span>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1">
          {agents.slice(0, 6).map((a) => <SessionMark key={a._id} session={{ _id: a._id, title: a.title } as any} size={14} iconClassName="w-3 h-3" />)}
        </span>
      </button>
      {open && (
        <div className="max-h-[180px] overflow-auto" data-cc-agents-list>
          {agents.map((a) => {
            const state = SESSION_STATUS[agentStateOf(a.agent_status)];
            const owners = agentOwnersOf(st, conversationId, a);
            const mine = !!meId && owners.people.some((o) => o._id === meId);
            const title = a.title?.trim() || a.short_id;
            return (
              <div key={a._id} data-cc-agent-row={a._id} className="flex min-h-[44px] items-center gap-2 border-t border-sol-border/40 px-4 py-1.5">
                <SessionMark session={{ _id: a._id, title: a.title } as any} size={20} />
                <button type="button" onClick={() => openSession(a._id)} className="flex min-w-0 flex-1 flex-col text-left leading-tight">
                  <span className="truncate text-ui text-sol-text hover:underline">{title}</span>
                  <span className={`truncate text-meta ${state.text}`}>{state.word}</span>
                </button>
                <span className="inline-flex items-center gap-1" title={`Owners: ${[...(owners.ownedByParent ? [parentTitle] : []), ...owners.people.map((o) => (o._id === meId ? "You" : o.name))].join(", ")}`}>
                  {owners.ownedByParent && <ParentSessionFace sessionId={conversationId} title={parentTitle} size={16} />}
                  {owners.people.map((o) => <AssigneeFace key={o._id} info={{ name: o.name, image: o.image }} size={16} hover={false} />)}
                </span>
                {meId && (mine ? (
                  <Button type="button" variant="ghost" size="xs" data-agent-unwatch={a._id} title="Take it out of your inbox" onClick={() => applyOwnersWithToast(a._id, { remove: [meId] }, { add: [meId] }, `${title} left your inbox`)}>
                    <Check className="w-3.5 h-3.5" />In your inbox
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="xs" data-agent-add-me={a._id} onClick={() => applyOwnersWithToast(a._id, { add: [meId] }, { remove: [meId] }, `${title} is in your inbox`)}>
                    <Plus className="w-3.5 h-3.5" />Add me
                  </Button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
