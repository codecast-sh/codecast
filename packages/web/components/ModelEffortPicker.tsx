import { useEffect } from "react";
import { useQuery } from "convex/react";
import { useShallow } from "zustand/react/shallow";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import {
  AGENT_MODEL_CONFIG,
  modelAgentKey,
  type ModelOption,
} from "@codecast/shared/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { formatModel } from "../lib/conversationProcessor";

// First-class model/effort control. Two rails, picked by session state:
//  - blank session (message_count === 0): reconfigureSession — idempotent
//    respawn with --model/--effort launch flags (the NewSessionView rail,
//    rendered by LaunchModelPill next to the agent pills).
//  - live session: set_model — the daemon drives the /model picker inside the
//    session's tmux and commits with `s` (session-only), rendered by
//    HeaderModelControl on the conversation-header badge.
//
// Every initiator (badge, pill, Cmd+K palette) funnels through
// commitModelChange: optimistic local stamp → dispatch → record the command in
// store.pendingModelCommand. The mounted conversation header watches that
// command reactively and reverts + toasts if the daemon refuses ("Session is
// busy…") or never answers (offline / pre-set_model daemon). The durable
// confirmation is the transcript echo flowing back through the model/effort
// rollup — no server-side optimistic state anywhere.

/** Stored model id → picker option key ("claude-opus-4-8" → "opus"). */
export function modelOptionKey(model: string | undefined | null, agentType: string | undefined): string {
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!model || !cfg) return "default";
  const bare = model.startsWith("claude-") ? model.slice("claude-".length) : model;
  const hit = cfg.models.find((m) => m.key !== "default" && (bare === m.key || bare.startsWith(`${m.key}-`)));
  return hit?.key ?? "default";
}

export function effortGlyph(effort: string | undefined | null): string {
  switch (effort) {
    case "low": return "○";
    case "medium": return "◐";
    case "high": return "●";
    case "max": case "xhigh": return "◈";
    default: return "";
  }
}

/** True when this agent/session-state combination has a working rail. */
export function canControlModel(agentType: string | undefined, blank: boolean): boolean {
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  return !!cfg && (blank || cfg.midSession);
}

/**
 * The one commit path for every surface. Optimistically stamps the local
 * store, dispatches the right command for the session state, and (live rail)
 * records the daemon command for the mounted watcher.
 */
export async function commitModelChange(opts: {
  conversationId: string;
  agentType: string | undefined;
  current: { model?: string | null; effort?: string | null };
  sel: { model?: string; effort?: string };
  blank: boolean;
}): Promise<void> {
  const { conversationId, agentType, current, sel, blank } = opts;
  if (!isConvexId(conversationId)) {
    toast.error("Session is still being created — try again in a moment");
    return;
  }
  const store = useInboxStore.getState();
  const agentKey = modelAgentKey(agentType);
  const prev = { model: current.model ?? null, effort: current.effort ?? null };
  store.setConversationModel(conversationId, {
    ...(sel.model !== undefined
      ? { model: sel.model === "default" ? null : (agentKey === "claude" ? `claude-${sel.model}` : sel.model) }
      : {}),
    ...(sel.effort !== undefined ? { effort: sel.effort === "default" ? null : sel.effort } : {}),
  });
  try {
    if (blank) {
      await store.convCommand(conversationId, "reconfigureSession", sel);
    } else {
      const commandId = await store.convCommand(conversationId, "setSessionModel", sel);
      if (commandId) {
        store.setPendingModelCommand({
          convId: conversationId,
          commandId: commandId as string,
          revert: prev,
          startedAt: Date.now(),
        });
      }
    }
  } catch (err) {
    store.setConversationModel(conversationId, prev);
    toast.error(err instanceof Error ? err.message : "Failed to switch model");
  }
}

// Maximum time we let an unanswered set_model keep its optimistic badge. An
// old daemon reports "Unknown command" as an error; an offline one never
// answers at all.
const SET_MODEL_CONFIRM_TIMEOUT_MS = 25000;

/**
 * Mounted by the conversation header: watches store.pendingModelCommand for
 * this conversation and reconciles the optimistic stamp against the daemon's
 * verdict. Rendering it where the badge lives means whichever surface fired
 * the switch (badge, launch pill, Cmd+K), the open conversation supervises it.
 */
function ModelCommandWatch({ conversationId }: { conversationId: string }) {
  const pending = useInboxStore(useShallow((s) =>
    s.pendingModelCommand?.convId === conversationId ? s.pendingModelCommand : null,
  ));
  const result = useQuery(
    api.conversations.getDaemonCommandResult,
    pending ? { command_id: pending.commandId as Id<"daemon_commands"> } : "skip",
  );

  useEffect(() => {
    if (!pending) return;
    const store = useInboxStore.getState();
    if (result?.error) {
      store.setConversationModel(conversationId, pending.revert);
      toast.error(result.error);
      store.setPendingModelCommand(null);
      return;
    }
    if (result?.executed_at) {
      store.setPendingModelCommand(null);
      return;
    }
    const remaining = pending.startedAt + SET_MODEL_CONFIRM_TIMEOUT_MS - Date.now();
    const timer = setTimeout(() => {
      const cur = useInboxStore.getState().pendingModelCommand;
      if (cur?.commandId !== pending.commandId) return;
      useInboxStore.getState().setConversationModel(conversationId, pending.revert);
      toast.error("Model switch not confirmed — the daemon may be offline or outdated");
      useInboxStore.getState().setPendingModelCommand(null);
    }, Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [pending, result, conversationId]);

  return null;
}

export function ModelEffortMenu({
  agentType,
  modelKey,
  effort,
  midSession,
  onSelect,
}: {
  agentType: string | undefined;
  modelKey: string;
  effort: string | undefined | null;
  /** Live-session rail: include midSessionOnly models (Sonnet 1M). */
  midSession: boolean;
  onSelect: (opts: { model?: string; effort?: string }) => void;
}) {
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!cfg) return null;
  const models = cfg.models.filter((m: ModelOption) => (midSession ? true : !m.midSessionOnly));
  return (
    <DropdownMenuContent align="end" className="w-64">
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-sol-text-dim">Model</DropdownMenuLabel>
      {models.map((m: ModelOption) => (
        <DropdownMenuItem
          key={m.key}
          onSelect={() => { if (m.key !== modelKey) onSelect({ model: m.key }); }}
          className="flex items-start gap-2"
        >
          <span className={`mt-0.5 w-3 text-center text-xs ${m.key === modelKey ? "text-sol-cyan" : "text-transparent"}`}>●</span>
          <span className="flex flex-col min-w-0">
            <span className={`text-xs ${m.key === modelKey ? "text-sol-text font-medium" : "text-sol-text-secondary"}`}>{m.label}</span>
            {m.hint && <span className="text-[10px] text-sol-text-dim truncate">{m.hint}</span>}
          </span>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-sol-text-dim">Effort</DropdownMenuLabel>
      <div className="flex items-center gap-1 px-2 pb-1.5">
        {/* "default" = no pin, the agent's saved default wins. Launch rail
            only: the live picker has no session-scoped default stop (the
            /effort auto one-shot rewrites the user's GLOBAL config). */}
        {[...(midSession ? [] : ["default"]), ...cfg.efforts].map((level: string) => {
          const active = level === "default" ? !effort : level === effort;
          return (
            <button
              key={level}
              onClick={() => { if (!active) onSelect({ effort: level }); }}
              className={`flex-1 px-1.5 py-1 rounded text-[11px] border transition-colors ${
                active
                  ? "border-sol-cyan/60 bg-sol-cyan/10 text-sol-cyan"
                  : "border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border"
              }`}
            >
              {level}
            </button>
          );
        })}
      </div>
    </DropdownMenuContent>
  );
}

/**
 * Conversation-header badge, upgraded from a read-only label to the in-place
 * model/effort control for LIVE claude sessions. Blank sessions are owned by
 * LaunchModelPill (the new-session surface); non-editable views keep the
 * static label. Also hosts the command watcher for this conversation.
 */
export function HeaderModelControl({
  conversationId,
  agentType,
  model,
  effort,
  messageCount,
  canEdit,
}: {
  conversationId: string | undefined;
  agentType: string | undefined;
  model: string | undefined;
  effort: string | undefined | null;
  messageCount: number | undefined;
  canEdit: boolean;
}) {
  const busy = useInboxStore((s) => !!conversationId && s.pendingModelCommand?.convId === conversationId);
  const blank = (messageCount ?? 0) === 0;
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];

  const interactive = !!(
    canEdit &&
    !blank &&
    conversationId &&
    isConvexId(conversationId) &&
    cfg?.midSession
  );

  const glyph = effortGlyph(effort);
  const watcher = conversationId && isConvexId(conversationId)
    ? <ModelCommandWatch conversationId={conversationId} />
    : null;

  if (!interactive) {
    if (!model) return watcher;
    return (
      <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
        {watcher}
        <span className="text-sol-text-dim">&middot;</span>
        <span className="font-mono truncate max-w-none" title={model}>{formatModel(model)}</span>
        {glyph && <span className="text-sol-text-dim/80" title={`${effort} effort`}>{glyph}</span>}
      </div>
    );
  }

  return (
    <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
      {watcher}
      <span className="text-sol-text-dim">&middot;</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={`group flex items-center gap-1 font-mono rounded px-1 -mx-1 transition-colors hover:bg-sol-bg-alt hover:text-sol-text-secondary ${busy ? "animate-pulse" : ""}`}
            title={`Model: ${model ?? "default"}${effort ? ` · ${effort} effort` : ""} — click to change`}
          >
            <span className="truncate max-w-none">{model ? formatModel(model) : "model"}</span>
            {glyph && <span className="text-sol-text-dim/80">{glyph}</span>}
            <svg className="w-2.5 h-2.5 opacity-50 group-hover:opacity-80 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </DropdownMenuTrigger>
        <ModelEffortMenu
          agentType={agentType}
          modelKey={modelOptionKey(model, agentType)}
          effort={effort}
          midSession
          onSelect={(sel) => {
            void commitModelChange({
              conversationId: conversationId!,
              agentType,
              current: { model, effort },
              sel,
              blank: false,
            });
          }}
        />
      </DropdownMenu>
    </div>
  );
}

/**
 * Launch model/effort pill for the new-session surface — sits in the agent
 * pill row and relaunches the blank session with --model/--effort flags via
 * reconfigureSession (the same idempotent respawn the agent pills use).
 */
export function LaunchModelPill({ conversationId }: { conversationId: string }) {
  const live = useInboxStore(useShallow((s) => {
    const row = (s.conversations[conversationId] ?? s.sessions[conversationId]) as
      | { model?: string | null; effort?: string | null; agent_type?: string }
      | undefined;
    return row ? { model: row.model, effort: row.effort, agentType: row.agent_type } : undefined;
  }));
  const agentType = live?.agentType ?? "claude_code";
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!cfg) return null;

  const modelKey = modelOptionKey(live?.model, agentType);
  const opt = cfg.models.find((m) => m.key === modelKey);
  const glyph = effortGlyph(live?.effort);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-all border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60 font-mono"
          title="Model and effort for this session"
        >
          {opt?.label ?? "Model"}
          {glyph && <span className="opacity-80">{glyph}</span>}
          <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <ModelEffortMenu
        agentType={agentType}
        modelKey={modelKey}
        effort={live?.effort}
        midSession={false}
        onSelect={(sel) => {
          void commitModelChange({
            conversationId,
            agentType,
            current: { model: live?.model, effort: live?.effort },
            sel,
            blank: true,
          });
        }}
      />
    </DropdownMenu>
  );
}
