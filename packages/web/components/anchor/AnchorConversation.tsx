"use client";

// The anchor's live conversation, embedded. Used by the /anchor page and the
// global slide-over alike — the same store-fed conversation, the same composer,
// so talking to the anchor feels identical wherever you open it.

import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { ConversationDiffLayout, type ConversationDiffLayoutProps } from "../ConversationDiffLayout";
import type { ConversationData } from "../conversation/types";
import { ProjectPathPicker } from "../ProjectPathPicker";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useMemo, useState } from "react";
import { AnchorGlyph } from "./AnchorIdentity";
import { bootstrapCut, windowConversationSince, type WindowedConversation } from "../../lib/anchorWindow";
import { useSeedOwnership } from "../../hooks/useSeedOwnership";

export function AnchorConversation({ conversationId, hideHeader, seedOwnership = true, onSendOverride, composerNode, autoFocusInput, since, foldBootstrap, foldWorkingTurns, openAtTop, composerPlaceholder, leadNode, leadPinned, stickyPrompt, initialDensity, hideDiff }: {
  conversationId: string;
  hideHeader?: boolean;
  /** The staffing pane owns the send into a proposal's thread (S18). */
  onSendOverride?: ConversationDiffLayoutProps["onSendOverride"];
  composerNode?: React.ReactNode;
  autoFocusInput?: boolean;
  /** A proposal's thread (org-staffing.md S19) is a standing session with a
   *  history from before the proposal: the embed shows what was said from
   *  `since` on, under the host's `leadNode` (the letter), and stops paging
   *  older once the loaded window reaches back past it. */
  since?: number;
  /** A standing session opens on its provisioning prompt: the seat's own
   *  system text, sent by the host as the first message. The scope page
   *  (scopes-and-feed.md F4.1) folds it away so the page opens on the agent
   *  talking to the person; the cut is the first message after it. */
  foldBootstrap?: boolean;
  /** The conversation as the agent talking to the person (ConversationView
   *  foldWorkingTurns): working turns and machine prompts fold away. */
  foldWorkingTurns?: boolean;
  openAtTop?: ConversationDiffLayoutProps["openAtTop"];
  composerPlaceholder?: ConversationDiffLayoutProps["composerPlaceholder"];
  leadNode?: ConversationDiffLayoutProps["leadNode"];
  leadPinned?: ConversationDiffLayoutProps["leadPinned"];
  stickyPrompt?: ConversationDiffLayoutProps["stickyPrompt"];
  initialDensity?: ConversationDiffLayoutProps["initialDensity"];
  hideDiff?: boolean;
  /** The anchor page owns its anchor by construction, so it seeds `is_own`
   *  before the row lands and the owner UI paints at once. A thread embedded
   *  elsewhere (the staffing pane's chief of staff, hosted by whoever hired
   *  it) passes false and takes ownership from the row itself. */
  seedOwnership?: boolean;
}) {
  useSeedOwnership(conversationId, seedOwnership);

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

  const windowed = useMemo(() => {
    const c = conversation as WindowedConversation | null;
    const cut = foldBootstrap ? bootstrapCut(c) : undefined;
    return windowConversationSince(c, cut !== undefined && (since === undefined || cut > since) ? cut : since);
  }, [conversation, since, foldBootstrap]);

  if (!conversation || !windowed) return <CenteredNote>Loading conversation…</CenteredNote>;

  return (
    <div className="h-full">
      <ConversationDiffLayout
        conversation={windowed.conversation as unknown as ConversationData}
        embedded
        hasMoreAbove={hasMoreAbove && !windowed.reachedStart}
        hasMoreBelow={hasMoreBelow}
        isLoadingOlder={isLoadingOlder}
        isLoadingNewer={isLoadingNewer}
        onLoadOlder={loadOlder}
        onLoadNewer={loadNewer}
        onJumpToStart={jumpToStart}
        onJumpToEnd={jumpToEnd}
        onJumpToTimestamp={jumpToTimestamp}
        isOwner={seedOwnership || !!(conversation as { is_own?: boolean }).is_own}
        showMessageInput
        hideHeader={hideHeader}
        onSendOverride={onSendOverride}
        composerNode={composerNode}
        autoFocusInput={autoFocusInput}
        leadNode={leadNode}
        leadPinned={leadPinned}
        stickyPrompt={stickyPrompt}
        initialDensity={initialDensity}
        foldWorkingTurns={foldWorkingTurns}
        openAtTop={openAtTop}
        composerPlaceholder={composerPlaceholder}
        hideDiff={hideDiff}
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
