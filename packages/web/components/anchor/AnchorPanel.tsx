"use client";

// The global anchor slide-over: the anchor from anywhere, without leaving the
// page. One anchor at a time — the header names WHICH (face, name, scope pill)
// and switches between them; the body is its live conversation. Ephemeral
// state in the store (`anchorPanel`), opened by the header chip, ⌘⇧A, or the
// palette; the /anchor page remains the full home (settings, Slack, routines).

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, ChevronDown, Plus, X } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useAnchors, anchorScopeLabel, defaultAnchorKey, deriveAnchorStatus, type AnchorRow } from "../../hooks/useSyncAnchors";
import { AnchorAvatar, AnchorGlyph, AnchorScopePill } from "./AnchorIdentity";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { TeamIcon } from "../TeamIcon";

const AnchorConversation = lazy(() =>
  import("./AnchorConversation").then((module) => ({ default: module.AnchorConversation })),
);
const AnchorOnboarding = lazy(() =>
  import("./AnchorConversation").then((module) => ({ default: module.AnchorOnboarding })),
);

// A pending "create" choice, encoded in anchorPanel.anchorId so the picker
// and the body agree without a second field.
const NEW_USER = "new:user";
const newTeamKey = (teamId: string) => `new:team:${teamId}`;

export function AnchorPanel() {
  const s = useTrackedStore([
    (st) => st.anchorPanel.open,
    (st) => st.anchorPanel.anchorId,
    (st) => st.clientState.ui?.active_team_id,
    (st) => st.teams,
  ]);
  const open = s.anchorPanel.open;
  const anchors = useAnchors();
  const teams: any[] = s.teams ?? [];
  const activeTeamId = (s.clientState.ui?.active_team_id as string | undefined) ?? null;
  const key = s.anchorPanel.anchorId ?? defaultAnchorKey(anchors, activeTeamId);
  const current = anchors.find((a) => a._id === key) ?? null;
  const router = useRouter();

  // Keep mounted after first open so the conversation's scroll/composer state
  // survives close/reopen; slide via transform.
  const [everOpen, setEverOpen] = useState(false);
  useEffect(() => { if (open) setEverOpen(true); }, [open]);
  const rootRef = useRef<HTMLDivElement>(null);
  if (!everOpen) return null;

  const close = () => useInboxStore.getState().closeAnchorPanel();
  const pick = (id: string) => useInboxStore.getState().openAnchorPanel(id);
  const openFull = () => {
    const q = current
      ? (current.scope_type === "team" ? `?scope=team&team=${current.team_id}` : "?scope=user")
      : key.startsWith("new:team:") ? `?scope=team&team=${key.slice("new:team:".length)}` : "?scope=user";
    router.push(`/anchor${q}`);
    close();
  };

  return (
    <div
      ref={rootRef}
      role="complementary"
      aria-label="Anchor"
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
        <AnchorPicker
          anchors={anchors}
          teams={teams}
          currentKey={key}
          onPick={pick}
        />
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <button
            onClick={openFull}
            className="cc-panel__btn"
            title="Open the Anchor page (settings, Slack, routines)"
            aria-label="Open Anchor page"
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
          <ShortcutTooltip label="Close" action="anchor.toggle">
            <button onClick={close} className="cc-panel__btn is-close" aria-label="Close anchor panel">
              <X className="w-3.5 h-3.5" />
            </button>
          </ShortcutTooltip>
        </div>
      </header>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<div className="h-full flex items-center justify-center text-sol-text-dim text-sm">Loading your anchor…</div>}>
          {current ? (
            current.conversation_id
              ? <AnchorConversation conversationId={String(current.conversation_id)} hideHeader />
              : <div className="h-full flex items-center justify-center text-sol-text-dim text-sm">Coming online…</div>
          ) : key === NEW_USER ? (
            <AnchorOnboarding scope="user" compact />
          ) : key.startsWith("new:team:") ? (
            <AnchorOnboarding
              scope="team"
              teamId={key.slice("new:team:".length)}
              teamName={teams.find((t) => t?._id === key.slice("new:team:".length))?.name ?? null}
              compact
            />
          ) : (
            <div className="h-full flex items-center justify-center text-sol-text-dim text-sm">Loading your anchors…</div>
          )}
        </Suspense>
      </div>
    </div>
  );
}

/** The header identity, doubling as the switcher: face + name + scope pill +
 *  status, and a menu of every anchor you can talk to (and the scopes that
 *  still lack one). */
function AnchorPicker({
  anchors, teams, currentKey, onPick,
}: { anchors: AnchorRow[]; teams: any[]; currentKey: string; onPick: (id: string) => void }) {
  const now = useCoarseNow(30_000);
  const current = anchors.find((a) => a._id === currentKey) ?? null;
  const [openMenu, setOpenMenu] = useState(false);
  const status = deriveAnchorStatus(current, now);
  const teamsWithout = useMemo(
    () => teams.filter((t) => t?._id && !anchors.some((a) => a.scope_type === "team" && a.team_id === t._id)),
    [teams, anchors],
  );
  const hasPersonal = anchors.some((a) => a.scope_type === "user");
  const pendingTeam = currentKey.startsWith("new:team:") ? teams.find((t) => t?._id === currentKey.slice("new:team:".length)) : null;

  return (
    <Popover open={openMenu} onOpenChange={setOpenMenu}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-2.5 min-w-0 rounded-md px-1 py-0.5 -ml-1 hover:bg-sol-bg-highlight/60 transition-colors text-left"
          title="Switch anchor"
        >
          <AnchorAvatar anchor={current} size={28} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 min-w-0 leading-tight">
              <span className="font-semibold text-sm truncate">
                {current ? current.bot_name : pendingTeam ? `New ${pendingTeam.name} Anchor` : "New Anchor"}
              </span>
              {current
                ? <AnchorScopePill anchor={current} />
                : <AnchorScopePill anchor={{ bot_name: "", bot_avatar: null, scope_type: pendingTeam ? "team" : "user", team_name: pendingTeam?.name ?? null }} />}
              <ChevronDown className="w-3 h-3 text-sol-text-dim shrink-0" />
            </span>
            {current && (
              <span className="flex items-center gap-1.5 text-[11px] leading-tight">
                <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                <span className={status.text}>{status.label}</span>
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5 bg-sol-bg border-sol-border">
        <div className="px-2 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-sol-text-dim">Your anchors</div>
        <ul className="space-y-0.5">
          {anchors.map((a) => {
            const st = deriveAnchorStatus(a, now);
            const active = a._id === currentKey;
            return (
              <li key={a._id}>
                <button
                  onClick={() => { onPick(a._id); setOpenMenu(false); }}
                  className={`w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sol-bg-highlight/70 ${active ? "bg-sol-bg-highlight/50" : ""}`}
                >
                  <AnchorAvatar anchor={a} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm truncate">{a.bot_name}</span>
                      <AnchorScopePill anchor={a} />
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px]">
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
                      <span className={st.text}>{st.label}</span>
                    </span>
                  </span>
                  {active && <Check className="w-3.5 h-3.5 text-sol-cyan shrink-0" />}
                </button>
              </li>
            );
          })}
          {anchors.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-sol-text-dim">None yet.</li>
          )}
        </ul>
        {(!hasPersonal || teamsWithout.length > 0) && (
          <>
            <div className="px-2 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-sol-text-dim">Add</div>
            <ul className="space-y-0.5">
              {!hasPersonal && (
                <li>
                  <button
                    onClick={() => { onPick(NEW_USER); setOpenMenu(false); }}
                    className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sol-bg-highlight/70 text-sm text-sol-text-muted"
                  >
                    <span className="w-6 h-6 rounded-md border border-dashed border-sol-border flex items-center justify-center"><Plus className="w-3 h-3" /></span>
                    <span>Personal Anchor</span>
                  </button>
                </li>
              )}
              {teamsWithout.map((t) => (
                <li key={t._id}>
                  <button
                    onClick={() => { onPick(newTeamKey(t._id)); setOpenMenu(false); }}
                    className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sol-bg-highlight/70 text-sm text-sol-text-muted"
                  >
                    <span className="w-6 h-6 rounded-md border border-dashed border-sol-border flex items-center justify-center">
                      <TeamIcon icon={t.icon} color={t.color} className="w-3 h-3" />
                    </span>
                    <span className="truncate">Anchor for {t.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The header chip: one glance says whether any anchor needs you or is
 *  working; one click opens the panel. Deliberately quiet — a glyph and a dot. */
export function AnchorChip() {
  const anchors = useAnchors();
  const now = useCoarseNow(30_000);
  const open = useInboxStore((st) => st.anchorPanel.open);
  const summary = useMemo(() => {
    const statuses = anchors.map((a) => deriveAnchorStatus(a, now));
    const tone = statuses.some((st) => st.tone === "attention") ? "attention"
      : statuses.some((st) => st.tone === "working") ? "working"
      : statuses.some((st) => st.tone === "online") ? "online"
      : anchors.length > 0 ? "dormant" : "none";
    return { tone, count: anchors.length };
  }, [anchors, now]);
  const dot = summary.tone === "attention" ? "bg-sol-yellow"
    : summary.tone === "working" ? "bg-sol-cyan animate-pulse"
    : summary.tone === "online" ? "bg-sol-green"
    : summary.tone === "dormant" ? "bg-sol-text-dim/50"
    : "";
  const label = summary.count === 0
    ? "Anchor — set up your standing agent"
    : summary.tone === "attention" ? "Anchor needs you"
    : summary.tone === "working" ? "Anchor is working"
    : "Talk to Anchor";
  return (
    <ShortcutTooltip label={label} action="anchor.toggle">
      <button
        onClick={() => useInboxStore.getState().toggleAnchorPanel()}
        aria-label={label}
        aria-pressed={open}
        className={`relative hidden md:flex items-center p-1.5 rounded-md transition-colors ${
          open ? "text-sol-cyan bg-sol-cyan/10" : "text-sol-text-dim/60 hover:text-sol-text-muted"
        }`}
      >
        <AnchorGlyph className="w-[18px] h-[18px]" />
        {dot && (
          <span className={`absolute right-1 top-1 w-1.5 h-1.5 rounded-full ring-2 ring-sol-bg ${dot}`} />
        )}
      </button>
    </ShortcutTooltip>
  );
}
