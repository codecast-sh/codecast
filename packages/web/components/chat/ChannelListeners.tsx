"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Check } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { orgRoleHref } from "../../lib/remarkChatMentions";
import { channelListeners, orgRolesListenSig } from "../../lib/chatListeners";
import type { OrgTree } from "../org/orgTypes";
import "./chat.css";

// "listening: N roles" — the channel header's account of which org roles read
// this room (docs/architecture/agent-channels.md C1/C4).
//
// A role follows a channel through `org_roles.follow_channel_ids`; the lines
// posted here then ride its next wake frame. Nothing about a plain post wakes
// it, so "listening" is the honest word: the role reads, on its own clock.
//
// The control reads the `orgTree` store singleton (the same snapshot the org
// page paints from; the chat page mounts its feeder) and offers "follow as
// @handle" for the roles the viewer administers — host, owner or team admin,
// the grant orgChannels.follow checks server-side. The toggle is a store
// action (orgSlice.followOrgChannel): the count moves in the same tick, and
// the next org.tree push confirms it.

export type ListenersChannel = { id: string; kind?: string; isPrivate?: boolean };

export function ChannelListeners({ channel }: { channel: ListenersChannel }) {
  // The tree ref churns with every session heartbeat in the org; the header
  // only branches on roles and the viewer's grant, so it wakes on THAT
  // signature (lib/chatListeners) and reads the tree from the tracked state.
  const s = useTrackedStore([(st) => orgRolesListenSig(st.orgTree), (st) => st.currentUser?._id]);
  const viewerId = String(s.currentUser?._id ?? "");
  const orgTree = s.orgTree as OrgTree | null;
  const sig = orgRolesListenSig(orgTree);
  const { listening, mine } = useMemo(
    () => channelListeners(orgTree, channel.id, viewerId),
    // Keyed on the signature, not the ref: a re-render for some other reason
    // must not recompute over an unchanged tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig, channel.id, viewerId],
  );
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement | null>(null);
  useWatchEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (hostRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A role may not follow a DM or a private room (orgChannels.follow refuses
  // both), so those headers never offer it. Elsewhere the line appears on an
  // agents channel always, and on an ordinary channel once a role listens or
  // the viewer has a role to point at it.
  const followable = channel.kind !== "dm" && !channel.isPrivate && channel.kind !== "private";
  if (!followable) return null;
  if (channel.kind !== "agents" && listening.length === 0 && mine.length === 0) return null;

  const n = listening.length;
  const label = n === 0 ? "listening: no roles" : n === 1 ? `listening: @${listening[0].handle}` : `listening: ${n} roles`;
  const following = new Set(listening.map((r) => r._id));

  return (
    <span ref={hostRef} className="ch-head-listen-host">
      <button
        type="button"
        className="ch-head-listen"
        title={n ? listening.map((r) => `@${r.handle}`).join(", ") : "No role follows this channel yet"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Bot className="w-3 h-3" aria-hidden="true" />
        <span className="ch-head-listen-text">{label}</span>
      </button>
      {open && (
        <div className="ch-listen-pop" role="menu" aria-label="Roles listening">
          <div className="ch-listen-head">Listening</div>
          {listening.length === 0 ? (
            <div className="ch-listen-empty">No role follows this channel.</div>
          ) : (
            listening.map((r) => (
              <Link key={r._id} href={orgRoleHref(r.short_id)} className="ch-listen-row" role="menuitem">
                <span className="ch-listen-handle">@{r.handle}</span>
                <span className="ch-listen-name">{r.name}</span>
              </Link>
            ))
          )}
          {mine.length > 0 && (
            <>
              <div className="ch-listen-head">Follow as</div>
              {mine.map((r) => {
                const on = following.has(r._id);
                return (
                  <button
                    key={r._id}
                    type="button"
                    className="ch-listen-row"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() => useInboxStore.getState().followOrgChannel(r.short_id, channel.id, !on)}
                  >
                    <span className="ch-listen-handle">@{r.handle}</span>
                    <span className="ch-listen-name">{r.name}</span>
                    <span className="ch-listen-state">
                      {on ? <Check className="w-3 h-3 inline-block" aria-label="following" /> : "follow"}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </span>
  );
}
