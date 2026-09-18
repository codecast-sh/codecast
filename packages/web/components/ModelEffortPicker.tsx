import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  AGENT_MODEL_CONFIG,
  modelAgentKey,
  findModelOption,
  isDynamicModelKey,
  dynamicModelOption,
  launchRailOptions,
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
import { useInboxStore } from "../store/inboxStore";
import { useLiveSessionMeta } from "../hooks/useLiveSessionMeta";
import { useAgentDefinitions } from "../hooks/useSyncAgentDefinitions";
import { toConvexAgentType } from "@codecast/shared/contracts";
import { modelOptionKey, modelFitsAgent, effortGlyph } from "../lib/modelSwitch";
import { commitModelChange, notifyModelToast as notifyToast } from "../lib/modelSwitchWeb";

// First-class model/effort control for the web. The commit rails live in
// lib/modelSwitch.ts (shared with the mobile switcher); this module owns the
// model/effort rows (ModelEffortRows) every picker composes, the new-session
// launch pill (LaunchModelPill, blank sessions) and the agent-definition pill.
// The conversation-header badge lives in SessionControlMenu.tsx: it wraps the
// same rows in the unified session control panel (model, effort, switch,
// fork, hand off).

/**
 * The user's codecast-wide default model for one agent client, with a
 * local-first setter. The default lives on the user row (users.default_models)
 * and is applied server-side by enqueueStartSession, so every new session
 * launches with an explicit model flag. The optimistic write goes through the
 * currentUser singleton sync (the mutation's echo carries the same value);
 * on failure the snapshot is synced back and the error toasted.
 */
function useDefaultModelPin(agentType: string | undefined) {
  const clientId = modelAgentKey(agentType);
  const defaultKey = useInboxStore(
    (s) => ((s as any).currentUser?.default_models ?? {})[clientId] as string | undefined,
  );
  const update = useMutation(api.users.updateDefaultModel);
  const setDefault = (key: string | null) => {
    const st = useInboxStore.getState() as any;
    const cur = st.currentUser;
    if (cur) {
      const merged: Record<string, string> = { ...(cur.default_models ?? {}) };
      if (key === null) delete merged[clientId];
      else merged[clientId] = key;
      st.syncTable("currentUser", { ...cur, default_models: merged });
    }
    update({ agent: clientId, model: key }).catch((e: any) => {
      notifyToast(`Failed to save default model: ${e?.message ?? e}`);
      if (cur) (useInboxStore.getState() as any).syncTable("currentUser", cur);
    });
  };
  return { defaultKey, setDefault };
}

export interface ModelEffortRowsProps {
  agentType: string | undefined;
  modelKey: string;
  effort: string | undefined | null;
  /** Live-session rail (no "default" effort stop). */
  midSession: boolean;
  onSelect: (opts: { model?: string; effort?: string }) => void;
  /** Dynamic clients: scope the live inventory to the session's device. */
  ownerDeviceId?: string | null;
  /** Keep the surrounding menu open after a model pick (a multi-step panel
   *  that collects the choice instead of committing it). */
  keepOpen?: boolean;
}

/**
 * The model list (static rail or a dynamic client's live inventory with
 * search), the default pin, and the effort chips — the rows themselves, with
 * no menu chrome, so one definition serves the launch pill, the header
 * session control panel, and its hand-off step.
 */
export function ModelEffortRows({
  agentType,
  modelKey,
  effort,
  midSession,
  onSelect,
  ownerDeviceId,
  keepOpen = false,
}: ModelEffortRowsProps) {
  const { dynamic, featured, all } = useDynamicModels(agentType, ownerDeviceId);
  const [search, setSearch] = useState("");
  const { defaultKey, setDefault } = useDefaultModelPin(agentType);
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!cfg) return null;
  // Dynamic clients: Default + the curated featured head; typing searches the
  // device's full inventory. Everything else: the shared curated rail.
  const rail = midSession ? { models: cfg.models, efforts: [...cfg.efforts] } : launchRailOptions(cfg);
  const models = dynamic ? [cfg.models[0], ...featured] : rail.models;
  const q = search.trim().toLowerCase();
  const matches = dynamic && q
    ? all.filter((id) => id.toLowerCase().includes(q) && !models.some((m) => m.key === id)).slice(0, 24)
    : [];
  // The transcript rollup stores the bare model id (no provider), so highlight
  // dynamic rows on a path-suffix match too.
  const isCurrent = (key: string) =>
    key === modelKey || (dynamic && modelKey !== "default" && key.endsWith(`/${modelKey}`));
  const modelRow = (m: ModelOption) => {
    // Only launchable options can be the codecast default (the same bar the
    // server holds).
    const pinnable = m.key !== "default" && !!m.cliAlias;
    const isDefault = m.key === defaultKey;
    // The "Default" row resolves to the user's codecast default at launch —
    // say which model that is.
    const hint = m.key === "default" && defaultKey
      ? `Launches ${findModelOption(agentType, defaultKey)?.label ?? defaultKey} (your default)`
      : m.hint;
    return (
      <DropdownMenuItem
        key={m.key}
        onSelect={(e) => { if (keepOpen) e.preventDefault(); if (!isCurrent(m.key)) onSelect({ model: m.key }); }}
        className="group flex items-start gap-2"
      >
        <span className={`mt-0.5 w-3 text-center text-xs ${isCurrent(m.key) ? "text-sol-cyan" : "text-transparent"}`}>●</span>
        <span className="flex flex-col min-w-0 grow">
          <span className={`text-xs ${isCurrent(m.key) ? "text-sol-text font-medium" : "text-sol-text-secondary"}`}>{m.label}</span>
          {hint && <span className="text-[10px] text-sol-text-dim truncate">{hint}</span>}
        </span>
        {pinnable && (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDefault(isDefault ? null : m.key);
            }}
            className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-[9px] whitespace-nowrap transition-all ${
              isDefault
                ? "border-sol-cyan/50 text-sol-cyan"
                : "border-sol-border/40 text-sol-text-dim opacity-0 group-hover:opacity-100 hover:text-sol-text hover:border-sol-border"
            }`}
            title={isDefault ? "Clear default — new sessions fall back to the agent's own setting" : "Launch every new session with this model"}
          >
            {isDefault ? "default ✓" : "set default"}
          </button>
        )}
      </DropdownMenuItem>
    );
  };
  return (
    <>
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
      {cfg.efforts.length > 0 && <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-sol-text-dim">Effort</DropdownMenuLabel>
        {/* Chips size to their label and wrap — clients with many effort levels
            (pi: off/minimal/low/medium/high/xhigh + default = 7) flow onto a second
            row instead of overflowing narrow equal-width columns. `grow` lets each
            chip expand to fill its row; whitespace-nowrap keeps a label on one line. */}
        <div className="flex flex-wrap gap-1 px-2 pb-1.5">
          {/* "default" = no pin, the agent's saved default wins. Launch rail
              only: the live picker has no session-scoped default stop (the
              /effort auto one-shot rewrites the user's GLOBAL config). */}
          {rail.efforts.map((level: string) => {
            const active = level === "default" ? !effort : level === effort;
            return (
              <button
                key={level}
                onClick={() => { if (!active) onSelect({ effort: level }); }}
                className={`grow whitespace-nowrap px-2 py-1 rounded text-[10px] border transition-colors ${
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
      </>}
    </>
  );
}

/** ModelEffortRows inside their own dropdown content — the launch pill's menu. */
export function ModelEffortMenu(props: ModelEffortRowsProps) {
  return (
    <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-1rem)]">
      <ModelEffortRows {...props} />
    </DropdownMenuContent>
  );
}


/**
 * Launch model/effort pill for the new-session surface — sits in the agent
 * pill row and relaunches the blank session with --model/--effort flags via
 * reconfigureSession (the same idempotent respawn the agent pills use).
 */
export function LaunchModelPill({ conversationId }: { conversationId: string }) {
  const live = useLiveSessionMeta(conversationId);
  const agentType = live?.agentType ?? "claude_code";
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!cfg) return null;

  const modelKey = modelFitsAgent(live?.model, agentType)
    ? modelOptionKey(live?.model, agentType)
    : "default";
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

/** Blank session: launch as a named agent definition (Settings > Agent
 *  Library). Picking one stamps the row; a definition that names a client
 *  flips the agent pill too, and its model rides the create through the
 *  server's resolveSpawnDefinition. Hidden until the workspace has one. */
export function AgentDefinitionPill({ conversationId }: { conversationId: string }) {
  const definitions = useAgentDefinitions();
  const live = useLiveSessionMeta(conversationId);
  if (definitions.length === 0) return null;
  const current = live?.agentDefinition;
  const pick = (name: string | null) => {
    const s = useInboxStore.getState();
    s.setConversationAgentDefinition(conversationId, name);
    const def = name ? definitions.find((d) => d.name === name) : undefined;
    if (def?.agent) s.setConversationAgent(conversationId, toConvexAgentType(def.agent));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border whitespace-nowrap transition-all font-mono ${
            current ? "border-sol-cyan/50 bg-sol-cyan/10 text-sol-cyan" : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
          }`}
          title="Launch as a named agent definition"
        >
          {current ? `as ${current}` : "as…"}
          <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="min-w-[16rem]">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">Agent definition</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => pick(null)} className={!current ? "text-sol-cyan" : ""}>
          <span className="font-mono text-xs">none</span>
          <span className="ml-2 text-[11px] text-sol-text-dim">plain session</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {definitions.map((d) => (
          <DropdownMenuItem key={d._id} onSelect={() => pick(d.name)} className={current === d.name ? "text-sol-cyan" : ""}>
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-xs">{d.name}<span className="ml-2 text-[10px] text-sol-text-dim">{[d.agent, d.model, d.effort].filter(Boolean).join(" · ")}</span></span>
              <span className="truncate text-[11px] text-sol-text-dim">{d.description}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
