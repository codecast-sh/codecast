"use client";

/**
 * Stable-context cards — the session feed injected into an agent at start,
 * rendered as people-readable cards instead of the raw <stable-context> block
 * (which the transcript sync strips as a meta entry).
 *
 * Two surfaces share one card renderer:
 *   - StableContextCards: read-only strip at the TOP of a conversation, fed by
 *     conversations.stable_context (the record `cast stable-context` posts at
 *     injection). A snapshot by design — it shows what the agent actually saw.
 *   - StableContextPicker: the NEW-session null state. Previews what the hook
 *     WILL inject (same feedForCLI query, same params) and lets the user
 *     override the mode or exclude individual cards for this session. Choices
 *     are stamped on the local stub row (setStableContextPrefs) and ride the
 *     createSession dispatch like model/effort.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Layers, Undo2, X } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  isExcludedStableItem,
  parseStableContext,
  type StableMode,
  type StableContextData,
  type StableContextItem,
} from "@codecast/shared/contracts";
import { relTimeShort } from "@/lib/utils";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useDevices } from "./DeviceBadge";
import { LivenessDot, type LivenessState } from "./LivenessDot";
import { SegmentedToggle } from "./SegmentedToggle";
import {
  resolveStableContextPreview,
  selectStableContextPreviewItems,
  stableContextPreviewFeedParams,
} from "./stableContextPreview";

function livenessFor(item: StableContextItem): LivenessState {
  if (item.work_state === "working" || item.is_live) return "active";
  if (item.work_state === "needs_input") return "blocked";
  return "dormant";
}

function projectName(path?: string | null): string | null {
  return path ? path.split("/").pop() || null : null;
}

/** ISO string (feed) or epoch — the record stores whatever the feed returned. */
function toEpoch(ts?: string | number): number | null {
  if (ts == null) return null;
  const value = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(value) ? value : null;
}

function ContextSessionCard({
  item,
  excluded,
  onToggleExclude,
  onOpen,
}: {
  item: StableContextItem;
  excluded?: boolean;
  onToggleExclude?: () => void;
  onOpen?: () => void;
}) {
  const epoch = toEpoch(item.updated_at);
  const meta = [
    epoch ? relTimeShort(epoch) : null,
    item.message_count != null ? `${item.message_count} msgs` : null,
    projectName(item.project_path),
  ].filter(Boolean) as string[];
  const author = item.owned_by_me ? null : item.user_name;

  return (
    <div
      className={`group relative flex-shrink-0 w-[13.5rem] rounded-md border px-2.5 py-2 text-left transition-colors ${
        excluded
          ? "border-sol-border/40 bg-sol-bg-alt/30 opacity-45"
          : "border-sol-border/60 bg-sol-bg-alt/60 hover:border-sol-base1/60"
      } ${onOpen ? "cursor-pointer" : ""}`}
      onClick={onOpen}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={
        onOpen
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <LivenessDot state={livenessFor(item)} size="xs" className="flex-shrink-0" />
        <span className={`text-[11px] font-medium text-sol-text truncate ${excluded ? "line-through" : ""}`}>
          {item.title}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-sol-text-dim font-mono truncate">
        {meta.map((value, index) => (
          <span key={`${value}-${index}`} className="flex items-center gap-1.5 flex-shrink-0">
            {index > 0 && <span className="opacity-50">·</span>}
            {value}
          </span>
        ))}
        {author && (
          <>
            <span className="opacity-50">·</span>
            <span className="text-sol-yellow/80 truncate">{author}</span>
          </>
        )}
      </div>
      {onToggleExclude && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleExclude();
          }}
          title={excluded ? "Include in context" : "Exclude from context"}
          className={`absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full border flex items-center justify-center transition-opacity ${
            excluded
              ? "opacity-100 border-sol-border bg-sol-bg text-sol-text-dim hover:text-sol-text"
              : "opacity-0 group-hover:opacity-100 border-sol-border bg-sol-bg text-sol-text-dim hover:text-sol-red hover:border-sol-red/50"
          }`}
        >
          {excluded ? <Undo2 className="w-2.5 h-2.5" /> : <X className="w-2.5 h-2.5" />}
        </button>
      )}
    </div>
  );
}

function CardRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1.5 [scrollbar-width:thin]">
      {children}
    </div>
  );
}

/**
 * Read-only strip at the top of a conversation: the context this session was
 * started with. Renders nothing when no record exists (pre-feature sessions,
 * stable mode off).
 */
export function StableContextCards({ stableContext }: { stableContext?: string | null }) {
  const [open, setOpen] = useState(false);
  const data: StableContextData | null = useMemo(
    () => parseStableContext(stableContext),
    [stableContext],
  );
  if (!data || data.items.length === 0) return null;

  const openSession = (id: string) => useInboxStore.getState().navigateToSession(id);

  return (
    <div className="conv-col mx-auto px-4 sm:px-5 md:px-6 pt-2 pb-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors mb-1.5"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Layers className="w-3 h-3 text-sol-cyan" />
        <span>
          Started with <span className="text-sol-text font-medium">{data.items.length}</span>{" "}
          {data.items.length === 1 ? "session pointer" : "session pointers"} from the{" "}
          <span className="text-sol-cyan">{data.mode}</span> feed
          {data.global ? " (all projects)" : ""}
        </span>
      </button>
      {open && (
        <CardRow>
          {data.items.map((item) => (
            <ContextSessionCard key={item.id} item={item} onOpen={() => openSession(item.id)} />
          ))}
        </CardRow>
      )}
    </div>
  );
}

const MODE_ITEMS = [
  { key: "auto", label: "Auto", title: "Use this machine's default (cast stable)" },
  { key: "team", label: "Team", title: "Team's recent sessions (14d)" },
  { key: "solo", label: "Solo", title: "Your recent sessions (7d)" },
  { key: "off", label: "Off", title: "Don't inject session history" },
];

/**
 * New-session context adjustment: preview the cards that will be injected and
 * let the user swap the mode or drop individual sessions for THIS session.
 */
export function StableContextPicker({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const state = useTrackedStore([
    (store) => store.sessions[conversationId]?.stable_mode,
    (store) => store.sessions[conversationId]?.stable_exclude,
    (store) => store.sessions[conversationId]?.project_path ?? store.conversations[conversationId]?.project_path,
  ]);
  const row = state.sessions[conversationId] ?? state.conversations[conversationId];
  const chosenMode: StableMode | undefined =
    row?.stable_mode === "team" || row?.stable_mode === "solo" || row?.stable_mode === "off"
      ? row.stable_mode
      : undefined;
  const exclude = row?.stable_exclude ?? [];
  const projectPath = row?.project_path || undefined;

  // "Auto" = whatever the machine that spawns the session has configured.
  // Auto-routing lands on the most-recently-active local device, so its
  // heartbeat-reported stable settings are the honest default to preview.
  const { mostRecentOnlineLocal } = useDevices();
  const deviceDefault = mostRecentOnlineLocal?.settings?.stable_mode ?? "off";
  const deviceGlobal = mostRecentOnlineLocal?.settings?.stable_global === true;

  const { effectiveMode, globalScope } = resolveStableContextPreview(
    chosenMode,
    deviceDefault,
    deviceGlobal,
  );

  const feedArgs = useMemo(
    () =>
      effectiveMode === "off"
        ? ("skip" as const)
        : stableContextPreviewFeedParams(
            effectiveMode,
            globalScope ? undefined : projectPath,
            exclude.length,
          ),
    [effectiveMode, globalScope, projectPath, exclude.length],
  );
  const { data: feed, error: feedError } = useQueryNoThrow(
    api.conversations.feedForCLI,
    feedArgs,
    { breakAfterMs: 20_000 },
  );

  const items: StableContextItem[] = useMemo(() => {
    const conversations: any[] = (feed as any)?.conversations ?? [];
    return conversations.map((conversation) => ({
      id: String(conversation.id),
      title: String(conversation.title ?? "Untitled"),
      project_path: conversation.project_path ?? null,
      updated_at: conversation.updated_at,
      message_count: conversation.message_count,
      work_state: conversation.work_state,
      is_live: conversation.is_live,
      user_name: conversation.user?.name ?? conversation.user?.email ?? null,
      owned_by_me: conversation.owned_by_me,
    }));
  }, [feed]);
  const previewItems = useMemo(
    () =>
      effectiveMode === "off"
        ? []
        : selectStableContextPreviewItems(items, effectiveMode, exclude),
    [items, effectiveMode, exclude],
  );

  const setPrefs = (prefs: { mode?: string | null; exclude?: string[] | null }) =>
    useInboxStore.getState().setStableContextPrefs(conversationId, prefs);

  const toggleExclude = (id: string) => {
    const short = id.slice(0, 7);
    const isExcluded = isExcludedStableItem(id, exclude);
    setPrefs({
      exclude: isExcluded
        ? exclude.filter((value) => !isExcludedStableItem(id, [value]))
        : [...exclude, short],
    });
  };

  const includedCount = previewItems.filter(
    (item) => !isExcludedStableItem(item.id, exclude),
  ).length;

  return (
    <div className="w-full max-w-2xl mx-auto mt-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Layers className="w-3 h-3 text-sol-cyan" />
          <span>Context</span>
          {effectiveMode !== "off" && feed !== undefined && !(feed as any)?.error && (
            <span className="opacity-70">
              — {includedCount} {includedCount === 1 ? "session pointer" : "session pointers"} injected at start
            </span>
          )}
        </button>
        <SegmentedToggle
          value={chosenMode ?? "auto"}
          onChange={(key) => setPrefs({ mode: key === "auto" ? null : key })}
          items={MODE_ITEMS}
        />
      </div>
      {open && (
        effectiveMode === "off" ? (
          <div className="text-[11px] text-sol-text-dim/70 border border-dashed border-sol-border/50 rounded-md px-3 py-2">
            {chosenMode === "off"
              ? "No session history will be injected into this session."
              : "Stable context is off on your machine — pick Team or Solo to inject recent session history for this session."}
          </div>
        ) : previewItems.length > 0 ? (
          <CardRow>
            {previewItems.map((item) => {
              const isExcluded = isExcludedStableItem(item.id, exclude);
              return (
                <ContextSessionCard
                  key={item.id}
                  item={item}
                  excluded={isExcluded}
                  onToggleExclude={() => toggleExclude(item.id)}
                />
              );
            })}
          </CardRow>
        ) : feedError || (feed as any)?.error ? (
          <div className="text-[11px] text-sol-text-dim/70 border border-dashed border-sol-border/50 rounded-md px-3 py-2">
            Context preview unavailable right now — the session will still start with your machine&apos;s configured context.
          </div>
        ) : feed === undefined ? (
          <div className="flex gap-2">
            {[0, 1, 2].map((index) => (
              <div key={index} className="w-[13.5rem] h-[3.25rem] rounded-md border border-sol-border/40 bg-sol-bg-alt/40 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-sol-text-dim/70 border border-dashed border-sol-border/50 rounded-md px-3 py-2">
            No recent sessions to inject{projectPath ? " for this project" : ""}.
          </div>
        )
      )}
    </div>
  );
}
