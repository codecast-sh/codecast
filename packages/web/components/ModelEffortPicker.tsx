import { useRef, useState } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useShallow } from "zustand/react/shallow";
import {
  AGENT_MODEL_CONFIG,
  modelAgentKey,
  cloudAgentProviderForLaunch,
  findModelOption,
  isDynamicModelKey,
  dynamicModelOption,
  launchRailOptions,
  liveRailOptions,
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
import { stepEffort, stepEffortLevel, useEffortPulse } from "../lib/effortStep";
import { MenuKeyCaps } from "./KeyboardShortcutsHelp";

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
 * launches with an explicit model flag. The store's setDefaultModel action
 * paints currentUser (a localFirst singleton) and dispatches the write; a
 * refusal puts the old pin back and toasts like any dispatch.
 */
export function useDefaultModelPin(agentType: string | undefined) {
  const clientId = modelAgentKey(agentType);
  const defaultKey = useInboxStore(
    (s) => ((s as any).currentUser?.default_models ?? {})[clientId] as string | undefined,
  );
  const setDefault = (key: string | null) => useInboxStore.getState().setDefaultModel(clientId, key);
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
  /** Only the model list, or only the effort levels (the new-session foot
   *  gives each its own menu). Omitted, both. */
  part?: "model" | "effort";
  /** ←/→ while the menu is open: one effort level down or up. Given, the
   *  step goes through the session's own stepping (lib/effortStep: one switch
   *  per run of presses); omitted, it is an ordinary effort pick. */
  onStepEffort?: (dir: 1 | -1) => void;
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
  part,
  onStepEffort,
}: ModelEffortRowsProps) {
  const { dynamic, featured, all } = useDynamicModels(agentType, ownerDeviceId);
  const [search, setSearch] = useState("");
  const { defaultKey, setDefault } = useDefaultModelPin(agentType);
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  // Dynamic clients: Default + the curated featured head; typing searches the
  // device's full inventory. Everything else: the shared curated rail.
  const rail = cfg && (midSession ? liveRailOptions(cfg) : launchRailOptions(cfg));
  // A client with cloud agent providers (Cursor; Codex: Codex Cloud and the
  // Agents API) lists its local models and each provider's side by side; the
  // composer's "run in the cloud" switch and its choice of provider pick
  // which, so show only those (local ones for a local launch). No cloud
  // agent takes an effort from codecast, so a cloud launch offers none.
  const lane = cloudAgentProviderForLaunch(agentType, modelKey)?.id ?? null;
  // Claude Code's picker: ←/→ move effort while the menu is open, whichever
  // row holds focus. Only where this rail offers effort levels.
  const stepsEffort = !!cfg && part !== "model" && cfg.efforts.length > 0 && !lane;
  // Heard on the whole menu: a menu opened by the pointer holds focus on its
  // content, above these rows. Latest props through a ref, one listener.
  const rowsRef = useRef<HTMLDivElement>(null);
  const onArrow = useRef<(dir: 1 | -1) => void>(() => {});
  onArrow.current = (dir) => {
    if (onStepEffort) { onStepEffort(dir); return; }
    const next = cfg && stepEffortLevel(cfg.efforts, effort, dir);
    if (next) onSelect({ effort: next });
  };
  useWatchEffect(() => {
    const menu = stepsEffort ? rowsRef.current?.closest<HTMLElement>("[role=menu]") : null;
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      onArrow.current(dir);
    };
    menu.addEventListener("keydown", onKey, true);
    return () => menu.removeEventListener("keydown", onKey, true);
  }, [stepsEffort]);
  if (!cfg || !rail) return null;
  const effortLabel = (
    <DropdownMenuLabel className="flex items-center gap-2 text-mark uppercase tracking-wider text-sol-text-dim">
      Effort
      <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal" title="Lower, raise (←/→ while open)">
        <MenuKeyCaps action="conv.effortDown" className="flex items-center gap-[2px]" />
        <MenuKeyCaps action="conv.effortUp" className="flex items-center gap-[2px]" />
      </span>
    </DropdownMenuLabel>
  );
  const laneModels = (dynamic ? [cfg.models[0], ...featured] : rail.models)
    .filter((m) => (cloudAgentProviderForLaunch(agentType, m.key)?.id ?? null) === lane);
  // A launch with a pinned default has no separate "Default" row: the pinned
  // model's own row is the default, badged, and reads as current until another
  // is picked. (A pin outside the listed rows keeps the row, under its name.)
  const pinListed = !!defaultKey && laneModels.some((m) => m.key === defaultKey);
  const models = !midSession && pinListed ? laneModels.filter((m) => m.key !== "default") : laneModels;
  const q = search.trim().toLowerCase();
  const matches = dynamic && q
    ? all.filter((id) => id.toLowerCase().includes(q) && !models.some((m) => m.key === id)).slice(0, 24)
    : [];
  // The transcript rollup stores the bare model id (no provider), so highlight
  // dynamic rows on a path-suffix match too.
  const isCurrent = (key: string) =>
    key === modelKey
    || (!midSession && pinListed && modelKey === "default" && key === defaultKey)
    || (dynamic && modelKey !== "default" && key.endsWith(`/${modelKey}`));
  const modelRow = (m: ModelOption) => {
    // Only launchable options can be the codecast default (the same bar the
    // server holds).
    const pinnable = m.key !== "default" && !!m.cliAlias;
    const isDefault = m.key === defaultKey;
    // The "default" row: named after the pinned model when there is one, and
    // "No default" when there is none (the agent's own setting decides).
    const isDefaultRow = m.key === "default";
    const label = !isDefaultRow ? m.label
      : defaultKey ? findModelOption(agentType, defaultKey)?.label ?? defaultKey
      : m.label === "Default" ? "No default" : m.label;
    const hint = !isDefaultRow ? m.hint
      : defaultKey ? "Your default"
      : m.label === "Default" ? "The agent's own setting picks the model" : m.hint;
    return (
      <DropdownMenuItem
        key={m.key}
        onSelect={(e) => { if (keepOpen) e.preventDefault(); if (!isCurrent(m.key)) onSelect({ model: m.key }); }}
        className="group flex items-start gap-2"
      >
        <span className={`mt-0.5 w-3 text-center text-xs ${isCurrent(m.key) ? "text-sol-cyan" : "text-transparent"}`}>●</span>
        <span className="flex flex-col min-w-0 grow">
          <span className={`text-xs ${isCurrent(m.key) ? "text-sol-text font-medium" : "text-sol-text-secondary"}`}>{label}</span>
          {hint && <span className="text-meta text-sol-text-dim truncate">{hint}</span>}
        </span>
        {pinnable && (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDefault(isDefault ? null : m.key);
            }}
            className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 text-meta whitespace-nowrap transition-all ${
              isDefault
                ? "border-sol-cyan/50 text-sol-cyan"
                : `border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border ${defaultKey ? "opacity-0 group-hover:opacity-100" : ""}`
            }`}
            title={isDefault ? "Clear default — new sessions fall back to the agent's own setting" : "Launch every new session with this model"}
          >
            {isDefault ? "default" : "make default"}
          </button>
        )}
      </DropdownMenuItem>
    );
  };
  if (part === "effort") {
    return (
      <div ref={rowsRef}>
        {effortLabel}
        {rail.efforts.map((level: string) => {
          const active = level === "default" ? !effort : level === effort;
          return (
            <DropdownMenuItem key={level} onSelect={() => { if (!active) onSelect({ effort: level }); }} className="flex items-center gap-2 text-xs">
              <span className={`w-3 text-center ${active ? "text-sol-cyan" : "text-transparent"}`}>●</span>
              <span className={active ? "text-sol-text font-medium" : "text-sol-text-secondary"}>{level}</span>
              {level !== "default" && <EffortMeter levels={cfg.efforts} effort={level} className="ml-auto text-sol-text-muted" />}
            </DropdownMenuItem>
          );
        })}
      </div>
    );
  }
  return (
    <div ref={rowsRef}>
      <DropdownMenuLabel className="text-mark uppercase tracking-wider text-sol-text-dim">Model</DropdownMenuLabel>
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
              <div className="px-3 py-1.5 text-meta text-sol-text-dim">No models match "{search}"</div>
            )}
          </div>
        </>
      )}
      {part !== "model" && cfg.efforts.length > 0 && !lane && <>
        <DropdownMenuSeparator />
        {effortLabel}
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
            // A menu item (a pick closes the menu, as a model pick does), drawn
            // as a chip: asChild keeps the button's own look.
            return (
              <DropdownMenuPrimitive.Item key={level} asChild onSelect={(e) => { if (keepOpen) e.preventDefault(); if (!active) onSelect({ effort: level }); }}>
                <button
                  className={`grow whitespace-nowrap outline-none px-2 py-1 rounded text-meta border transition-colors ${
                    active
                      ? "border-sol-cyan/60 bg-sol-cyan/10 text-sol-cyan"
                      : "border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border data-[highlighted]:text-sol-text data-[highlighted]:border-sol-border"
                  }`}
                >
                  {level}
                </button>
              </DropdownMenuPrimitive.Item>
            );
          })}
        </div>
      </>}
    </div>
  );
}

/** Tracks whether `at` was less than `ms` ago, re-rendering when it lapses. */
function useRecent(at: number | undefined, ms: number): boolean {
  const [, tick] = useState(0);
  const left = at ? at + ms - Date.now() : 0;
  const recent = left > 0;
  useWatchEffect(() => {
    if (!recent) return;
    const t = setTimeout(() => tick((n) => n + 1), left);
    return () => clearTimeout(t);
  }, [at, recent]);
  return recent;
}

/**
 * An effort level as rising bars, one per level the agent has, filled up to
 * the current one, so where it sits on the scale (and that it can move) reads
 * at a glance. With a conversation it answers the effort keys: the bars light
 * cyan for a moment on each step, and shake when the scale has no further level.
 */
export function EffortMeter({ levels, effort, conversationId, className = "" }: {
  levels: readonly string[];
  effort: string | null | undefined;
  conversationId?: string;
  className?: string;
}) {
  const pulse = useEffortPulse(conversationId);
  const lit = useRecent(pulse?.at, 700);
  if (levels.length === 0) return null;
  const at = effort ? levels.indexOf(effort) : -1;
  const span = Math.max(levels.length - 1, 1);
  return (
    <span
      key={pulse?.edge ? pulse.at : "meter"}
      aria-hidden
      className={`inline-flex h-2.5 shrink-0 items-end gap-[1.5px] transition-colors duration-500 ${lit ? "!text-sol-cyan" : ""} ${lit && pulse?.edge ? "motion-safe:animate-effort-bump" : ""} ${className}`}
    >
      {levels.map((level, i) => (
        <span
          key={level}
          className={`w-[2px] rounded-[1px] bg-current transition-opacity duration-150 ${i <= at ? "opacity-100" : "opacity-25"}`}
          style={{ height: `${35 + (65 * i) / span}%` }}
        />
      ))}
    </span>
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


/** A picker trigger in the new-session composer foot: a quiet text button. */
export const FOOT_PICK = "inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs whitespace-nowrap text-sol-text-muted hover:text-sol-text hover:bg-sol-bg/60 data-[state=open]:bg-sol-bg/60 data-[state=open]:text-sol-text transition-colors";

/**
 * A blank session's launch model and effort, read off the live row, with the
 * rows' props (including the commit) and the words a trigger shows: the model
 * that launches, or that none is pinned.
 */
export function useLaunchModel(conversationId: string) {
  const live = useLiveSessionMeta(conversationId);
  const agentType = live?.agentType ?? "claude_code";
  const { defaultKey } = useDefaultModelPin(agentType);
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  const modelKey = modelFitsAgent(live?.model, agentType)
    ? modelOptionKey(live?.model, agentType)
    : "default";
  const opt = cfg?.models.find((m) => m.key === modelKey)
    ?? (isDynamicModelKey(modelKey) ? dynamicModelOption(modelKey) : undefined);
  // A cloud agent launch runs at its provider's effort, whatever one was picked before.
  const cloudLaunch = !!cloudAgentProviderForLaunch(agentType, modelKey);
  const pinLabel = defaultKey ? findModelOption(agentType, defaultKey)?.label ?? defaultKey : undefined;
  // What the trigger says: the model that launches; with no pin and no pick,
  // that no default is set.
  const noDefault = modelKey === "default" && !pinLabel && opt?.label === "Default";
  const label = modelKey === "default" && pinLabel ? pinLabel : noDefault ? "no default" : opt?.label ?? "Model";
  const rowProps: ModelEffortRowsProps = {
    agentType,
    modelKey,
    effort: live?.effort,
    midSession: false,
    ownerDeviceId: live?.ownerDeviceId,
    onSelect: (sel) => {
      void commitModelChange({
        conversationId,
        agentType,
        current: { model: live?.model, effort: live?.effort },
        sel,
        blank: true,
      });
    },
  };
  return { cfg, rowProps, label, noDefault, cloudLaunch, effort: live?.effort ?? null };
}

/** The launch model as a trigger shows it: "Opus", or a dim "no default". */
export function LaunchModelLabel({ label, noDefault }: { label: string; noDefault: boolean }) {
  return <span className={noDefault ? "text-sol-text-dim" : undefined}>{label}</span>;
}

const Chevron = () => (
  <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
  </svg>
);

/**
 * Launch model/effort pill for the new-session surface — sits in the agent
 * pill row and relaunches the blank session with --model/--effort flags via
 * reconfigureSession (the same idempotent respawn the agent pills use).
 */
export function LaunchModelPill({ conversationId }: { conversationId: string }) {
  const { cfg, rowProps, label, noDefault, cloudLaunch, effort } = useLaunchModel(conversationId);
  if (!cfg) return null;
  const glyph = cloudLaunch ? null : effortGlyph(effort);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border whitespace-nowrap transition-all border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60 font-mono"
          title="Model and effort for this session"
        >
          <LaunchModelLabel label={label} noDefault={noDefault} />
          {glyph && <span className="opacity-80">{glyph}</span>}
          <Chevron />
        </button>
      </DropdownMenuTrigger>
      <ModelEffortMenu {...rowProps} />
    </DropdownMenu>
  );
}

/** The new-session foot's effort menu. Hidden where the agent takes no effort
 *  from codecast (a cloud agent launch, a client without levels). */
export function LaunchEffortPill({ conversationId }: { conversationId: string }) {
  const { cfg, rowProps, cloudLaunch, effort } = useLaunchModel(conversationId);
  if (!cfg || cfg.efforts.length === 0 || cloudLaunch) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={FOOT_PICK} title="Effort for this session">
          <EffortMeter levels={cfg.efforts} effort={effort} conversationId={conversationId} />
          <span className={effort ? "capitalize" : "text-sol-text-dim"}>{effort ?? "effort"}</span>
          <Chevron />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[11rem]">
        <ModelEffortRows {...rowProps} part="effort" onStepEffort={(dir) => stepEffort(conversationId, dir, true)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Blank session: launch as a named agent definition (Settings > Agent
 *  Library). Picking one stamps the row; a definition that names a client
 *  flips the agent pill too, and its model rides the create through the
 *  server's resolveSpawnDefinition. Hidden until the workspace has one. */
export function AgentDefinitionPill({ conversationId, variant = "chip" }: { conversationId: string; variant?: "chip" | "ghost" }) {
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
          type="button"
          className={variant === "ghost" ? `${FOOT_PICK} ${current ? "!text-sol-cyan" : ""}` : `inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border whitespace-nowrap transition-all font-mono ${
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
        <DropdownMenuLabel className="text-mark uppercase tracking-wide text-sol-text-dim">Agent definition</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => pick(null)} className={!current ? "text-sol-cyan" : ""}>
          <span className="font-mono text-xs">none</span>
          <span className="ml-2 text-meta text-sol-text-dim">plain session</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {definitions.map((d) => (
          <DropdownMenuItem key={d._id} onSelect={() => pick(d.name)} className={current === d.name ? "text-sol-cyan" : ""}>
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-xs">{d.name}<span className="ml-2 text-meta text-sol-text-dim">{[d.agent, d.model, d.effort].filter(Boolean).join(" · ")}</span></span>
              <span className="truncate text-meta text-sol-text-dim">{d.description}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
