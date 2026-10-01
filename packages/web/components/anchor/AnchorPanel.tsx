"use client";

// A pinned role or session from anywhere, without leaving the page: the
// header's slide-over (org-staffing.md S22, S30). The header is the role's
// face, given name and title (or the session's title); the body is its live
// conversation. Ephemeral state in the store (`anchorPanel`), opened by a
// header pin, the shortcut, or the palette; a role's page is the full home,
// with its scope beside the conversation. With no target the panel shows the
// first header pin: the person's global Chief of Staff by default, else the
// active workspace's agent.

import { useWorkspaceFeature } from "../../lib/teamFeatures";
import { TopbarButton } from "../TopbarButton";
import { lazy, Suspense, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { agentName, agentTitle, deriveAnchorStatus, useAnchors, useRootAgent, type AnchorRow } from "../../hooks/useSyncAnchors";
import { AnchorAvatar, AnchorScopePill } from "./AnchorIdentity";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useTrackedStore } from "../../hooks/useTrackedStore";
import { isHeaderPinned, readHeaderPins, resolveHeaderPins, toggleHeaderPin, type ResolvedPin } from "../../lib/headerPins";
import { Pin, PinOff } from "lucide-react";
import { SessionFace } from "../identity/SessionFace";

import { useWatchEffect } from "../../hooks/useWatchEffect";

const AnchorConversation = lazy(() =>
  import("./AnchorConversation").then((module) => ({ default: module.AnchorConversation })),
);
const AnchorOnboarding = lazy(() =>
  import("./AnchorConversation").then((module) => ({ default: module.AnchorOnboarding })),
);

export function AnchorPanel() {
  const open = useInboxStore((st) => st.anchorPanel.open);
  // The org feature is per team, default off: no chip and no slide-over when
  // the active workspace has it off (the store keeps its state; nothing renders).
  const orgOn = useWorkspaceFeature("org");
  const pins = useHeaderPins();
  const target = useInboxStore((st) => st.anchorPanel.target);
  const anchors = useAnchors();
  const shown: ResolvedPin | null = (target?.kind === "anchor"
    ? pins.find((p) => p.anchor && p.anchor._id === target.id) ?? pinOfAnchor(anchors.find((a) => a._id === target.id) ?? null)
    : target?.kind === "session" ? pins.find((p) => p.conversationId === target.id) ?? sessionPin(target.id)
    : null) ?? pins[0] ?? null;
  const current = shown?.anchor ?? null;
  const router = useRouter();

  // Keep mounted after first open so the conversation's scroll/composer state
  // survives close/reopen; slide via transform.
  const [everOpen, setEverOpen] = useState(false);
  useWatchEffect(() => { if (open) setEverOpen(true); }, [open]);
  const rootRef = useRef<HTMLDivElement>(null);
  if (!everOpen) return null;

  const close = () => useInboxStore.getState().closeAnchorPanel();
  const name = shown?.name ?? agentName(current);
  const openFull = () => {
    router.push(current ? (current.role ? `/org/${current.role.short_id}` : "/anchor") : shown?.conversationId ? `/conversation/${shown.conversationId}` : "/anchor");
    close();
  };

  if (!orgOn) return null;
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
        <RootAgentHead current={current} shown={shown} onOpenFull={openFull} />
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
          {shown ? (
            shown.conversationId
              ? <AnchorConversation conversationId={shown.conversationId} hideHeader foldBootstrap foldWorkingTurns />
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
function RootAgentHead({ current, shown, onOpenFull }: { current: AnchorRow | null; shown: ResolvedPin | null; onOpenFull: () => void }) {
  const now = useCoarseNow(30_000);
  const status = deriveAnchorStatus(current, now);
  const name = shown?.name ?? agentName(current);
  const title = current ? agentTitle(current) : shown?.subtitle ?? null;
  return (
    <button
      onClick={onOpenFull}
      className="flex items-center gap-2.5 min-w-0 rounded-md px-1 py-0.5 -ml-1 hover:bg-sol-bg-highlight/60 transition-colors text-left"
      title={shown ? `Open ${name}'s page` : "Set up the workspace's agent"}
    >
      {current || !shown ? <AnchorAvatar anchor={current} size={28} /> : <SessionPinFace id={shown.conversationId ?? ""} size={28} />}
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 min-w-0 leading-tight">
          <span className="font-semibold text-sm truncate">{shown ? name : "Workspace agent"}</span>
          {current?.role && <span className="text-[10.5px] font-mono text-sol-text-dim truncate">@{current.role.handle}</span>}
          {current && <AnchorScopePill anchor={current} />}
        </span>
        {shown && (
          <span className="flex items-center gap-1.5 text-[11px] leading-tight">
            {current && <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />}
            {title && <span className="text-sol-text-muted truncate">{title}</span>}
            {current && <span className={status.text}>· {status.label}</span>}
          </span>
        )}
      </span>
    </button>
  );
}

/** The header's pins, resolved against what the viewer can see. */
export function useHeaderPins(): ResolvedPin[] {
  const anchors = useAnchors();
  const s = useTrackedStore([
    (st) => JSON.stringify(st.clientState.ui?.header_pins ?? null),
    (st) => st.clientState.ui?.active_team_id ?? null,
    (st) => {
      const pins = readHeaderPins(st);
      return pins ? pins.filter((p) => p.kind === "session").map((p) => `${p.id}:${st.sessions[p.id]?.title ?? ""}:${st.sessions[p.id]?.short_id ?? ""}`).join("|") : "";
    },
  ]);
  return resolveHeaderPins(readHeaderPins(s), anchors, s.sessions as any, (s.clientState.ui?.active_team_id as string | undefined) ?? null);
}

/** A pinned session's face: the row's character, read through a short
 *  signature so a heartbeat elsewhere never re-renders the header. */
function SessionPinFace({ id, size }: { id: string; size: number }) {
  const s = useTrackedStore([(st) => { const r = st.sessions[id]; return r ? `${r.character_avatar ?? ""}|${r.character_name ?? ""}|${r.title ?? ""}|${r.standing_role_id ?? ""}` : ""; }]);
  const row = s.sessions[id];
  if (!row) return <AnchorAvatar anchor={null} size={size} />;
  return <SessionFace row={row as any} size={size} />;
}

function pinOfAnchor(a: AnchorRow | null): ResolvedPin | null {
  if (!a) return null;
  return { key: `anchor:${a._id}`, pin: a.role ? { kind: "role", id: String(a.role._id) } : null, anchor: a, conversationId: a.conversation_id ? String(a.conversation_id) : null, name: agentName(a), subtitle: agentTitle(a) ?? "", isDefault: false };
}

function sessionPin(id: string): ResolvedPin | null {
  const s = (useInboxStore.getState() as any).sessions[id];
  if (!s) return null;
  return { key: `session:${id}`, pin: { kind: "session", id }, anchor: null, conversationId: id, name: s.title || "Session", subtitle: s.short_id ? `session ${s.short_id}` : "session", isDefault: false };
}

/** The header pins (org-staffing.md S30): one face per pinned role or
 *  session, the person's global Chief of Staff by default, else the active
 *  workspace's agent. One glance says whether a role needs you or is
 *  working; one click opens the panel on it. A right click unpins. */
export function HeaderPins() {
  const pins = useHeaderPins();
  const root = useRootAgent();
  const orgOn = useWorkspaceFeature("org");
  if (!orgOn) return null;
  if (!pins.length) return <HirePinChip hasRoot={!!root} />;
  return (
    <span className="inline-flex items-center gap-0.5" data-header-pins>
      {pins.map((p) => <PinChip key={p.key} pin={p} />)}
    </span>
  );
}

function PinChip({ pin }: { pin: ResolvedPin }) {
  const now = useCoarseNow(30_000);
  const open = useInboxStore((st) => st.anchorPanel.open);
  const target = useInboxStore((st) => st.anchorPanel.target);
  const status = pin.anchor ? deriveAnchorStatus(pin.anchor, now) : null;
  const dot = !status ? ""
    : status.tone === "attention" ? "bg-sol-yellow"
    : status.tone === "working" ? "bg-sol-cyan animate-pulse"
    : status.tone === "online" ? "bg-sol-green"
    : "bg-sol-text-dim/50";
  const label = status?.tone === "attention" ? `${pin.name} needs you`
    : status?.tone === "working" ? `${pin.name} is working`
    : `Talk to ${pin.name}`;
  const mine: typeof target = pin.anchor ? { kind: "anchor", id: pin.anchor._id } : { kind: "session", id: pin.conversationId ?? pin.key };
  const active = open && (!target ? pin.isDefault : target.kind === mine.kind && target.id === mine.id);
  return (
    <ShortcutTooltip label={`${label} · ${pin.subtitle}`} action="anchor.toggle">
      <TopbarButton
        onClick={() => {
          const st = useInboxStore.getState();
          if (active) st.closeAnchorPanel(); else st.openAnchorPanel(mine);
        }}
        onContextMenu={(e) => {
          if (!pin.pin) return;
          e.preventDefault();
          toggleHeaderPin(pin.pin.kind, pin.pin.id);
        }}
        aria-label={label}
        aria-pressed={active}
        active={active}
        desktopOnly
        data-header-pin={pin.key}
      >
        {pin.anchor ? <AnchorAvatar anchor={pin.anchor} size={18} /> : <SessionPinFace id={pin.conversationId ?? ""} size={18} />}
        {dot && (
          <span className={`absolute right-1 top-1 w-1.5 h-1.5 rounded-full ring-2 ring-sol-bg ${dot}`} />
        )}
      </TopbarButton>
    </ShortcutTooltip>
  );
}

/** Nothing pinned and nothing to show by default: the way in. */
function HirePinChip({ hasRoot }: { hasRoot: boolean }) {
  const open = useInboxStore((st) => st.anchorPanel.open);
  const label = hasRoot ? "Pin a role or session here" : "Set up the workspace's agent";
  return (
    <ShortcutTooltip label={label} action="anchor.toggle">
      <TopbarButton onClick={() => useInboxStore.getState().toggleAnchorPanel()} aria-label={label} aria-pressed={open} active={open} desktopOnly>
        <AnchorAvatar anchor={null} size={18} />
      </TopbarButton>
    </ShortcutTooltip>
  );
}

/** "Pin to header" / "Unpin": the one gesture, for a role page's or a
 *  session header's menu. */
export function HeaderPinToggle({ kind, id, className = "" }: { kind: "role" | "session"; id: string; className?: string }) {
  const pinned = useInboxStore((st) => isHeaderPinned(st, kind, id));
  return (
    <button
      type="button"
      onClick={() => toggleHeaderPin(kind, id)}
      className={`inline-flex items-center gap-1 text-[11px] text-sol-text-muted hover:text-sol-text ${className}`}
      title={pinned ? "Remove from the app header" : "Keep in the app header, on every page"}
      data-header-pin-toggle={pinned ? "pinned" : "unpinned"}
    >
      {pinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
      {pinned ? "Unpin" : "Pin to header"}
    </button>
  );
}
