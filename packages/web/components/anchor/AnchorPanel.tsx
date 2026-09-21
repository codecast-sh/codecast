"use client";

// The workspace's agent from anywhere, without leaving the page: the root
// role's slide-over (org-staffing.md S22). The header is the role's face,
// name and handle; the body is its live conversation. Ephemeral state in the
// store (`anchorPanel`), opened by the header chip, the shortcut, or the
// palette; the role's page (/anchor) is the full home, with its scope beside
// the conversation.

import { TopbarButton } from "../TopbarButton";
import { lazy, Suspense, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { agentName, deriveAnchorStatus, useRootAgent, type AnchorRow } from "../../hooks/useSyncAnchors";
import { AnchorAvatar, AnchorScopePill } from "./AnchorIdentity";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useCoarseNow } from "../../hooks/useCoarseNow";

import { useWatchEffect } from "../../hooks/useWatchEffect";

const AnchorConversation = lazy(() =>
  import("./AnchorConversation").then((module) => ({ default: module.AnchorConversation })),
);
const AnchorOnboarding = lazy(() =>
  import("./AnchorConversation").then((module) => ({ default: module.AnchorOnboarding })),
);

export function AnchorPanel() {
  const open = useInboxStore((st) => st.anchorPanel.open);
  const current = useRootAgent();
  const router = useRouter();

  // Keep mounted after first open so the conversation's scroll/composer state
  // survives close/reopen; slide via transform.
  const [everOpen, setEverOpen] = useState(false);
  useWatchEffect(() => { if (open) setEverOpen(true); }, [open]);
  const rootRef = useRef<HTMLDivElement>(null);
  if (!everOpen) return null;

  const close = () => useInboxStore.getState().closeAnchorPanel();
  const name = agentName(current);
  const openFull = () => {
    router.push("/anchor");
    close();
  };

  return (
    <div
      ref={rootRef}
      role="complementary"
      aria-label={name}
      aria-hidden={!open}
      data-anchor-panel
      onKeyDown={(e) => {
        // Esc from inside the panel closes it, unless a composer is holding
        // text (its own Esc handling wins there).
        if (e.key !== "Escape") return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT") && (t as HTMLInputElement).value) return;
        e.stopPropagation();
        close();
      }}
      className={`absolute inset-y-0 right-0 z-[45] flex flex-col bg-sol-bg border-l border-sol-border/60 shadow-[-12px_0_32px_-16px_rgba(0,0,0,0.45)] transition-transform ease-out ${
        open ? "translate-x-0" : "translate-x-full pointer-events-none"
      }`}
      style={{ width: "min(480px, 92vw)", transitionDuration: "var(--cc-panel-motion, 220ms)" }}
    >
      <header className="flex items-center gap-2 px-3 h-11 border-b border-sol-border/60 shrink-0">
        <RootAgentHead current={current} onOpenFull={openFull} />
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <button
            onClick={openFull}
            className="cc-panel__btn"
            title={`Open ${name}'s page (its scope, settings and Slack)`}
            aria-label={`Open ${name}'s page`}
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
          <ShortcutTooltip label="Close" action="anchor.toggle">
            <button onClick={close} className="cc-panel__btn is-close" aria-label="Close the panel">
              <X className="w-3.5 h-3.5" />
            </button>
          </ShortcutTooltip>
        </div>
      </header>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<div className="h-full flex items-center justify-center text-sol-text-dim text-sm">Loading…</div>}>
          {current ? (
            current.conversation_id
              ? <AnchorConversation conversationId={String(current.conversation_id)} hideHeader foldBootstrap foldWorkingTurns />
              : <div className="h-full flex items-center justify-center text-sol-text-dim text-sm">Coming online…</div>
          ) : (
            <AnchorOnboarding compact />
          )}
        </Suspense>
      </div>
    </div>
  );
}

/** The header identity: the role's face, its name, its handle and workspace,
 *  and its status. A click opens the role's page. */
function RootAgentHead({ current, onOpenFull }: { current: AnchorRow | null; onOpenFull: () => void }) {
  const now = useCoarseNow(30_000);
  const status = deriveAnchorStatus(current, now);
  const name = agentName(current);
  return (
    <button
      onClick={onOpenFull}
      className="flex items-center gap-2.5 min-w-0 rounded-md px-1 py-0.5 -ml-1 hover:bg-sol-bg-highlight/60 transition-colors text-left"
      title={current ? `Open ${name}'s page` : "Set up the workspace's agent"}
    >
      <AnchorAvatar anchor={current} size={28} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 min-w-0 leading-tight">
          <span className="font-semibold text-sm truncate">{current ? name : "Workspace agent"}</span>
          {current?.role && <span className="text-[10.5px] font-mono text-sol-text-dim truncate">@{current.role.handle}</span>}
          <AnchorScopePill anchor={current} />
        </span>
        {current && (
          <span className="flex items-center gap-1.5 text-[11px] leading-tight">
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            <span className={status.text}>{status.label}</span>
          </span>
        )}
      </span>
    </button>
  );
}

/** The header chip: the root role's face, and one glance says whether it
 *  needs you or is working; one click opens the panel. */
export function AnchorChip() {
  const current = useRootAgent();
  const now = useCoarseNow(30_000);
  const open = useInboxStore((st) => st.anchorPanel.open);
  const status = deriveAnchorStatus(current, now);
  const name = agentName(current);
  const dot = !current ? ""
    : status.tone === "attention" ? "bg-sol-yellow"
    : status.tone === "working" ? "bg-sol-cyan animate-pulse"
    : status.tone === "online" ? "bg-sol-green"
    : "bg-sol-text-dim/50";
  const label = !current
    ? "Set up the workspace's agent"
    : status.tone === "attention" ? `${name} needs you`
    : status.tone === "working" ? `${name} is working`
    : `Talk to ${name}`;
  return (
    <ShortcutTooltip label={label} action="anchor.toggle">
      <TopbarButton
        onClick={() => useInboxStore.getState().toggleAnchorPanel()}
        aria-label={label}
        aria-pressed={open}
        active={open}
        desktopOnly
      >
        <AnchorAvatar anchor={current} size={18} />
        {dot && (
          <span className={`absolute right-1 top-1 w-1.5 h-1.5 rounded-full ring-2 ring-sol-bg ${dot}`} />
        )}
      </TopbarButton>
    </ShortcutTooltip>
  );
}
