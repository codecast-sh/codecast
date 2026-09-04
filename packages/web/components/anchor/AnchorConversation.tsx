"use client";

// The anchor's live conversation, embedded. Used by the /anchor page and the
// global slide-over alike — the same store-fed conversation, the same composer,
// so talking to the anchor feels identical wherever you open it.

import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { ConversationDiffLayout } from "../ConversationDiffLayout";
import { ConversationData } from "../ConversationView";
import { ProjectPathPicker } from "../ProjectPathPicker";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useInboxStore } from "../../store/inboxStore";
import { useState } from "react";
import { AnchorGlyph } from "./AnchorIdentity";

import { useWatchEffect } from "../../hooks/useWatchEffect";
export function AnchorConversation({ conversationId, hideHeader }: { conversationId: string; hideHeader?: boolean }) {
  // Seed ownership so the embedded conversation shows owner UI immediately.
  useWatchEffect(() => {
    useInboxStore.getState().syncRecord("conversations", conversationId, { _id: conversationId, is_own: true });
  }, [conversationId]);

  const {
    conversation,
    hasMoreAbove,
    hasMoreBelow,
    isLoadingOlder,
    isLoadingNewer,
    loadOlder,
    loadNewer,
    jumpToStart,
    jumpToEnd,
    jumpToTimestamp,
  } = useConversationMessages(conversationId);

  if (!conversation) return <CenteredNote>Loading conversation…</CenteredNote>;

  return (
    <div className="h-full">
      <ConversationDiffLayout
        conversation={conversation as ConversationData}
        embedded
        hasMoreAbove={hasMoreAbove}
        hasMoreBelow={hasMoreBelow}
        isLoadingOlder={isLoadingOlder}
        isLoadingNewer={isLoadingNewer}
        onLoadOlder={loadOlder}
        onLoadNewer={loadNewer}
        onJumpToStart={jumpToStart}
        onJumpToEnd={jumpToEnd}
        onJumpToTimestamp={jumpToTimestamp}
        isOwner
        showMessageInput
        hideHeader={hideHeader}
      />
    </div>
  );
}

export function CenteredNote({ children }: { children: React.ReactNode }) {
  return <div className="h-full flex items-center justify-center text-sol-text-dim text-sm px-6 text-center">{children}</div>;
}

/** No anchor for this scope yet: name it, pick where it lives, bring it
 *  online. `compact` fits the slide-over; the page uses the full form. */
export function AnchorOnboarding({
  scope, teamId, teamName, compact,
}: { scope: "team" | "user"; teamId?: string | null; teamName?: string | null; compact?: boolean }) {
  const provision = useMutation(api.anchors.provisionAnchor);
  const [project, setProject] = useState("");
  const [name, setName] = useState("Anchor");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await provision({
        scope_type: scope,
        team_id: scope === "team" && teamId ? teamId : undefined,
        name: name.trim() || "Anchor",
        project_path: project.trim() || undefined,
      } as any);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create anchor");
      setBusy(false);
    }
  };

  const who = scope === "team" ? `${teamName ?? "your team"}'s Anchor` : "your Anchor";
  return (
    <div className={`h-full flex items-center justify-center ${compact ? "px-5" : "px-6"}`}>
      <div className="max-w-md w-full text-center">
        <div className={`mx-auto ${compact ? "w-11 h-11 mb-3" : "w-14 h-14 mb-5"} rounded-2xl bg-sol-cyan/15 flex items-center justify-center`}>
          <AnchorGlyph className={`${compact ? "w-6 h-6" : "w-7 h-7"} text-sol-cyan`} />
        </div>
        <h1 className={`${compact ? "text-base" : "text-xl"} font-semibold tracking-tight mb-2`}>Meet {who}</h1>
        <p className="text-sm text-sol-text-muted mb-5 leading-relaxed">
          {scope === "team"
            ? "A standing agent every member of the team can talk to: it keeps the team's context, runs routines, answers in chat and Slack, and reaches people when something needs them."
            : "A standing agent that is yours alone: it keeps your context, runs the routines you give it, and speaks up when something needs you."}
        </p>
        <div className="text-left space-y-3">
          <label className="block">
            <span className="text-xs text-sol-text-dim">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full bg-sol-bg-alt border border-sol-border rounded-lg px-3 py-2 text-sm outline-none focus:border-sol-cyan"
            />
          </label>
          <div>
            <span className="text-xs text-sol-text-dim">Project it lives and works in</span>
            <ProjectPathPicker value={project} onChange={setProject} className="mt-1" />
            <span className="text-[11px] text-sol-text-dim/70">
              It runs on your machine at this path. Leave blank to let the daemon pick.
            </span>
          </div>
        </div>
        {err && <div className="text-sol-red text-xs mt-3">{err}</div>}
        <button
          onClick={create}
          disabled={busy}
          className="mt-5 w-full bg-sol-cyan text-sol-bg font-medium rounded-lg px-4 py-2.5 text-sm disabled:opacity-60 hover:bg-sol-cyan/90 transition-colors"
        >
          {busy ? "Bringing it online…" : `Create ${scope === "team" ? "team " : ""}Anchor`}
        </button>
      </div>
    </div>
  );
}
