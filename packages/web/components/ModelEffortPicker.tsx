import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import {
  AGENT_MODEL_CONFIG,
  modelAgentKey,
  isDynamicModelKey,
  dynamicModelOption,
  type ModelOption,
} from "@codecast/shared/contracts";
import { useDynamicModels } from "../hooks/useDynamicModels";
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
import {
  modelOptionKey,
  effortGlyph,
  canControlModel,
  commitModelChange as commitModelChangeCore,
} from "../lib/modelSwitch";
import { useModelCommandWatch } from "../hooks/useModelCommandWatch";

// First-class model/effort control for the web. The commit rails and the
// pending-command reconciliation live in lib/modelSwitch.ts +
// hooks/useModelCommandWatch.ts (shared with the mobile switcher); this module
// owns the web surfaces: the conversation-header badge (HeaderModelControl,
// live sessions), the new-session launch pill (LaunchModelPill, blank
// sessions), and the shared dropdown menu the Cmd+K palette also drives.

export { modelOptionKey, effortGlyph, canControlModel };

const notifyToast = (message: string) => toast.error(message);

/** Web commit path: shared rails + sonner toasts for errors. */
export function commitModelChange(opts: {
  conversationId: string;
  agentType: string | undefined;
  current: { model?: string | null; effort?: string | null };
  sel: { model?: string; effort?: string };
  blank: boolean;
}): Promise<void> {
  return commitModelChangeCore({ ...opts, notify: notifyToast });
}

/**
 * Mounted by the conversation header: supervises pending model commands for
 * this conversation (see useModelCommandWatch). Rendering it where the badge
 * lives means whichever surface fired the switch (badge, launch pill, Cmd+K),
 * the open conversation supervises it.
 */
function ModelCommandWatch({ conversationId }: { conversationId: string }) {
  useModelCommandWatch(conversationId, notifyToast);
  return null;
}

export function ModelEffortMenu({
  agentType,
  modelKey,
  effort,
  midSession,
  onSelect,
  ownerDeviceId,
}: {
  agentType: string | undefined;
  modelKey: string;
  effort: string | undefined | null;
  /** Live-session rail: include midSessionOnly models (Sonnet 1M). */
  midSession: boolean;
  onSelect: (opts: { model?: string; effort?: string }) => void;
  /** Dynamic clients: scope the live inventory to the session's device. */
  ownerDeviceId?: string | null;
}) {
  const { dynamic, featured, all } = useDynamicModels(agentType, ownerDeviceId);
  const [search, setSearch] = useState("");
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!cfg) return null;
  // Dynamic clients: Default + the curated featured head; typing searches the
  // device's full inventory. Static clients: the contract list as before.
  const models = dynamic
    ? [cfg.models[0], ...featured]
    : cfg.models.filter((m: ModelOption) => (midSession ? true : !m.midSessionOnly));
  const q = search.trim().toLowerCase();
  const matches = dynamic && q
    ? all.filter((id) => id.toLowerCase().includes(q) && !models.some((m) => m.key === id)).slice(0, 24)
    : [];
  // The transcript rollup stores the bare model id (no provider), so highlight
  // dynamic rows on a path-suffix match too.
  const isCurrent = (key: string) =>
    key === modelKey || (dynamic && modelKey !== "default" && key.endsWith(`/${modelKey}`));
  const modelRow = (m: ModelOption) => (
    <DropdownMenuItem
      key={m.key}
      onSelect={() => { if (!isCurrent(m.key)) onSelect({ model: m.key }); }}
      className="flex items-start gap-2"
    >
      <span className={`mt-0.5 w-3 text-center text-xs ${isCurrent(m.key) ? "text-sol-cyan" : "text-transparent"}`}>●</span>
      <span className="flex flex-col min-w-0">
        <span className={`text-xs ${isCurrent(m.key) ? "text-sol-text font-medium" : "text-sol-text-secondary"}`}>{m.label}</span>
        {m.hint && <span className="text-[10px] text-sol-text-dim truncate">{m.hint}</span>}
      </span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-1rem)]">
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-sol-text-dim">Model</DropdownMenuLabel>
      {models.map(modelRow)}
      {dynamic && all.length > 0 && (
        <>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            // Keep keystrokes out of Radix's menu typeahead / shortcut layer.
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={`Search ${all.length} models…`}
            className="mx-2 my-1 w-[calc(100%-1rem)] rounded border border-sol-border/40 bg-transparent px-2 py-1 text-xs text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan/60"
          />
          <div className="max-h-48 overflow-y-auto">
            {matches.map((id) => modelRow(dynamicModelOption(id)))}
            {q && matches.length === 0 && (
              <div className="px-3 py-1.5 text-[10px] text-sol-text-dim">No models match "{search}"</div>
            )}
          </div>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-sol-text-dim">Effort</DropdownMenuLabel>
      <div className="grid grid-flow-col auto-cols-fr gap-1 px-2 pb-1.5">
        {/* "default" = no pin, the agent's saved default wins. Launch rail
            only: the live picker has no session-scoped default stop (the
            /effort auto one-shot rewrites the user's GLOBAL config). */}
        {[...(midSession ? [] : ["default"]), ...cfg.efforts].map((level: string) => {
          const active = level === "default" ? !effort : level === effort;
          return (
            <button
              key={level}
              onClick={() => { if (!active) onSelect({ effort: level }); }}
              className={`min-w-0 px-0.5 py-1 rounded text-[10px] border transition-colors ${
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
      | { model?: string | null; effort?: string | null; agent_type?: string; owner_device_id?: string | null }
      | undefined;
    return row
      ? { model: row.model, effort: row.effort, agentType: row.agent_type, ownerDeviceId: row.owner_device_id }
      : undefined;
  }));
  const agentType = live?.agentType ?? "claude_code";
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!cfg) return null;

  const modelKey = modelOptionKey(live?.model, agentType);
  const opt = cfg.models.find((m) => m.key === modelKey)
    ?? (isDynamicModelKey(modelKey) ? dynamicModelOption(modelKey) : undefined);
  const glyph = effortGlyph(live?.effort);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border whitespace-nowrap transition-all border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60 font-mono"
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
        ownerDeviceId={live?.ownerDeviceId}
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
