import { useState, type ReactNode } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, ArrowRightLeft, ChevronRight, Split, Send } from "lucide-react";
import {
  AGENT_LAUNCH_OPTIONS,
  AGENT_MODEL_CONFIG,
  canSessionBecomeAgent,
  findModelOption,
  modelAgentKey,
  type ConvexAgentType,
} from "@codecast/shared/contracts";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useLiveSessionMeta } from "../hooks/useLiveSessionMeta";
import { useInboxStore, type InboxSession } from "../store/inboxStore";
import { formatModel } from "../lib/conversationProcessor";
import { modelOptionKey, modelFitsAgent, effortGlyph, canControlModel } from "../lib/modelSwitch";
import { commitModelChange } from "../lib/modelSwitchWeb";
import { switchSessionAgent, forkSessionAsAgent } from "../lib/sessionAgentActions";
import { startHandoff, HANDOFF_EXPLAINER } from "../lib/handoffWeb";
import { agentAccent } from "../lib/agentColors";
import { AgentTypeIcon, formatAgentType } from "./AgentTypeIcon";
import { ModelEffortRows } from "./ModelEffortPicker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// The unified session control: one panel behind the conversation-header badge
// holding everything that moves a session between rails — model and effort
// (in place), switch agent (in place), fork as another agent (a copy), and
// hand off (a fresh session on any agent/model, seeded with a Haiku brief).
// The overflow menu and the Cmd+K palette point at the same actions; this is
// the surface designed as one piece.

const SECTION_LABEL = "px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-sol-text-dim";

type SessionRow = Pick<InboxSession, "_id" | "title" | "agent_type" | "project_path" | "git_root">;

/** The row the move actions act on: the live store row, else a minimal
 *  stand-in from what the header already knows. */
function sessionRowFor(conversationId: string, agentType: string | undefined): SessionRow {
  const s = useInboxStore.getState();
  const id = s.getConvexId(conversationId) ?? conversationId;
  const row = (s.sessions[id] ?? s.conversations[id]) as SessionRow | undefined;
  return row ?? ({ _id: conversationId, agent_type: agentType } as SessionRow);
}

function modelStampForPick(agentType: string | undefined, key: string): string | undefined {
  if (key === "default") return undefined;
  return modelAgentKey(agentType) === "claude" ? `claude-${key}` : key;
}

// ── Moving a session ──────────────────────────────────────────────────────────
//
// Three verbs, each one calm row on the main panel that slides to a list of
// agents written out in full (icon, name, and the reason when one is not
// available). A list reads in one pass; a grid of icons has to be decoded.

export interface AgentOption {
  type: ConvexAgentType;
  label: string;
  /** Why the row is unavailable; unset = pickable. */
  disabledReason?: string;
  /** The session's current agent: ringed, so the list says where you are. */
  current?: boolean;
}

export type MoveVerb = "switch" | "fork" | "handoff";

export const MOVE_VERBS: Record<MoveVerb, { label: string; hint: string; icon: typeof Split }> = {
  switch: { label: "Switch agent", hint: "Same session, another agent", icon: ArrowRightLeft },
  fork: { label: "Fork as", hint: "A copy of this session on another agent", icon: Split },
  handoff: { label: "Hand off to", hint: "A fresh session, seeded with a brief", icon: Send },
};

/** The agent list for each verb from one session state. Exported for tests. */
export function moveAgentOptions(agentType: string | undefined, messageCount: number | undefined): Record<MoveVerb, AgentOption[]> {
  const current = (agentType || "claude_code") as ConvexAgentType;
  const count = messageCount ?? 0;
  // Short, because it sits at the end of a row: the count is on the badge already.
  const cannotRebuild = "can't rebuild history";
  const all = AGENT_LAUNCH_OPTIONS.map((a) => ({ type: a.convexType, label: a.label }));
  return {
    switch: all.map<AgentOption>((a) =>
      a.type === current
        ? { ...a, current: true, disabledReason: "current" }
        : canSessionBecomeAgent(a.type, count) ? a : { ...a, disabledReason: cannotRebuild },
    ),
    fork: all.filter((a) => a.type !== current).map<AgentOption>((a) =>
      canSessionBecomeAgent(a.type, count) ? a : { ...a, disabledReason: cannotRebuild },
    ),
    handoff: all.map<AgentOption>((a) => (a.type === current ? { ...a, current: true } : a)),
  };
}

/** A framed agent icon; the accent ring marks the session's current agent. */
function AgentMark({ type, current, size = "md" }: { type: string; current?: boolean; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-[18px] w-[18px] rounded" : "h-6 w-6 rounded-md";
  const icon = size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3";
  return (
    <span className={`flex shrink-0 items-center justify-center border border-sol-border/40 bg-sol-bg-alt ${box} ${current ? `ring-1 ${agentAccent(type).ring}` : ""}`}>
      <AgentTypeIcon agentType={type} className={icon} />
    </span>
  );
}

/** The slide-in header every second step shares: Back, then what this step is. */
function StepHeader({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-sol-border/30 px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-sol-text-dim transition-colors hover:bg-sol-bg-alt hover:text-sol-text"
      >
        <ArrowLeft className="h-3 w-3" />
        Back
      </button>
      <span className="text-sol-text-dim/50">·</span>
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-sol-text">{children}</span>
    </div>
  );
}

/** One verb's agent list: pick a row to act (switch, fork) or to go on (hand off). */
function AgentPickStep({
  verb,
  options,
  onPick,
  onBack,
  keepOpen,
}: {
  verb: MoveVerb;
  options: AgentOption[];
  onPick: (type: ConvexAgentType) => void;
  onBack: () => void;
  /** The pick advances inside the panel instead of closing the menu. */
  keepOpen?: boolean;
}) {
  const meta = MOVE_VERBS[verb];
  return (
    <div data-pick-step={verb} className="animate-in fade-in-0 slide-in-from-right-4 duration-200 motion-reduce:animate-none">
      <StepHeader onBack={onBack}>
        <span className="whitespace-nowrap font-medium">{meta.label}</span>
      </StepHeader>
      <div className="py-1">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.type}
            disabled={!!o.disabledReason}
            data-agent-row={o.type}
            data-current={o.current || undefined}
            onSelect={(e) => { if (keepOpen) e.preventDefault(); onPick(o.type); }}
            className="mx-1 flex items-center gap-2.5 px-2 py-1.5"
          >
            <AgentMark type={o.type} current={o.current} />
            <span className={`whitespace-nowrap text-xs ${o.disabledReason ? "text-sol-text-secondary" : "text-sol-text"}`}>{o.label}</span>
            {o.disabledReason && <span className="ml-auto shrink truncate pl-2 text-[10px] text-sol-text-dim">{o.disabledReason}</span>}
            {!o.disabledReason && o.current && <span className="ml-auto text-[10px] text-sol-text-dim">current</span>}
          </DropdownMenuItem>
        ))}
      </div>
    </div>
  );
}

// ── Hand-off step ─────────────────────────────────────────────────────────────

function HandoffStep({
  conversationId,
  agent,
  ownerDeviceId,
  onBack,
  onDone,
}: {
  conversationId: string;
  agent: ConvexAgentType;
  ownerDeviceId?: string | null;
  onBack: () => void;
  onDone: () => void;
}) {
  const convex = useConvex();
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agent)];
  const [modelKey, setModelKey] = useState("default");
  const [effort, setEffort] = useState<string | undefined>(undefined);
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const label = formatAgentType(agent);

  const submit = () => {
    if (busy) return;
    setBusy(true);
    const s = useInboxStore.getState();
    const real = s.getConvexId(conversationId) ?? conversationId;
    startHandoff(convex, { conversation_id: real, agent_type: agent, model: modelKey, effort, direction })
      .then((res) => {
        toast.success(`Handed off to ${res.short_id} on ${label}`);
        useInboxStore.getState().requestNavigate(res.conversation_id);
        onDone();
      })
      .catch((error) => {
        setBusy(false);
        toast.error(error instanceof Error ? error.message : "Failed to hand off");
      });
  };

  const modelLabel = modelKey === "default" ? "default model" : (findModelOption(agent, modelKey)?.label ?? modelKey);

  return (
    <div data-handoff-step={agent} className="animate-in fade-in-0 slide-in-from-right-4 duration-200 motion-reduce:animate-none">
      <StepHeader onBack={onBack}>
        Hand off to
        <AgentMark type={agent} current size="sm" />
        <span className="font-medium">{label}</span>
      </StepHeader>
      {cfg ? (
        <div className="py-1">
          <ModelEffortRows
            agentType={agent}
            modelKey={modelKey}
            effort={effort}
            midSession={false}
            ownerDeviceId={ownerDeviceId}
            keepOpen
            onSelect={(sel) => {
              if (sel.model !== undefined) setModelKey(sel.model);
              if (sel.effort !== undefined) setEffort(sel.effort === "default" ? undefined : sel.effort);
            }}
          />
        </div>
      ) : (
        <div className="px-3 py-2 text-[10px] text-sol-text-dim">{label} launches with its own configured model.</div>
      )}
      <DropdownMenuSeparator />
      <div className={SECTION_LABEL}>Direction</div>
      <div className="px-3 pb-2">
        <textarea
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          // Keep keystrokes out of Radix's menu typeahead / shortcut layer;
          // Cmd+Enter submits, the way the composer does.
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }}
          rows={3}
          placeholder="What should the next session do first?"
          className="w-full resize-none rounded-md border border-sol-border/40 bg-sol-bg-alt/40 px-2 py-1.5 text-xs text-sol-text placeholder:text-sol-text-dim/60 outline-none transition-colors focus:border-sol-cyan/50"
        />
        <p className="mt-1.5 text-[10px] leading-snug text-sol-text-dim">{HANDOFF_EXPLAINER}</p>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          data-handoff-submit
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-sol-cyan/30 bg-sol-cyan/15 px-3 py-1.5 text-xs font-medium text-sol-cyan transition-colors hover:bg-sol-cyan/25 disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? "Starting the brief…" : `Hand off on ${modelLabel}`}
          {!busy && <ArrowRight className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}

// ── The panel ─────────────────────────────────────────────────────────────────

export interface SessionControlPanelProps {
  conversationId: string;
  agentType: string | undefined;
  /** The model the badge shows (full id, e.g. claude-opus-4-8). */
  model: string | undefined;
  effort: string | undefined;
  messageCount: number | undefined;
  ownerDeviceId?: string | null;
  onModelSelect: (sel: { model?: string; effort?: string }) => void;
  /** Close the surrounding menu after a move action fires. */
  onClose: () => void;
}

export function SessionControlPanel({
  conversationId,
  agentType,
  model,
  effort,
  messageCount,
  ownerDeviceId,
  onModelSelect,
  onClose,
}: SessionControlPanelProps) {
  // Which second step is showing: an agent list for a verb, or the hand-off
  // configuration once its agent is chosen.
  const [view, setView] = useState<{ step: "main" } | { step: "pick"; verb: MoveVerb } | { step: "handoff"; agent: ConvexAgentType }>({ step: "main" });
  const blank = (messageCount ?? 0) === 0;
  const controllable = canControlModel(agentType, blank);
  const agentLabel = formatAgentType(agentType);
  const glyph = effortGlyph(effort);
  const options = moveAgentOptions(agentType, messageCount);

  const stateLine = !controllable
    ? `${agentLabel} keeps the model it launched with`
    : blank
      ? "Blank session · picks apply at launch"
      : "Live session · picks apply in place";

  const onSwitch = (type: ConvexAgentType) => {
    onClose();
    void switchSessionAgent(sessionRowFor(conversationId, agentType), type)
      .catch((error) => toast.error(error instanceof Error ? error.message : "Failed to switch agent"));
  };
  const onFork = (type: ConvexAgentType) => {
    onClose();
    try {
      const fork = forkSessionAsAgent(sessionRowFor(conversationId, agentType), type);
      useInboxStore.getState().requestNavigate(fork.sessionId);
      void fork.ready.catch((error) => toast.error(error instanceof Error ? error.message : "Failed to fork session"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to fork session");
    }
  };

  if (view.step === "handoff") {
    return (
      <HandoffStep
        conversationId={conversationId}
        agent={view.agent}
        ownerDeviceId={ownerDeviceId}
        onBack={() => setView({ step: "pick", verb: "handoff" })}
        onDone={onClose}
      />
    );
  }
  if (view.step === "pick") {
    const verb = view.verb;
    return (
      <AgentPickStep
        verb={verb}
        options={options[verb]}
        onBack={() => setView({ step: "main" })}
        keepOpen={verb === "handoff"}
        onPick={(type) => {
          if (verb === "switch") onSwitch(type);
          else if (verb === "fork") onFork(type);
          else setView({ step: "handoff", agent: type });
        }}
      />
    );
  }

  return (
    <div data-session-control-panel>
      <div className="flex items-center gap-2.5 border-b border-sol-border/30 bg-sol-bg-alt/40 px-3 py-2.5">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-sol-border/40 bg-sol-bg ring-1 ${agentAccent(agentType).ring}`}>
          <AgentTypeIcon agentType={agentType || "claude_code"} className="h-3.5 w-3.5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
            <span className="font-medium text-sol-text">{agentLabel}</span>
            {model && <span className="truncate font-mono text-sol-text-secondary" title={model}>{formatModel(model)}</span>}
            {glyph && <span className="text-sol-text-dim/80" title={`${effort} effort`}>{glyph}</span>}
          </div>
          <span data-session-state className="text-[10px] text-sol-text-dim">{stateLine}</span>
        </div>
      </div>

      {controllable && (
        <div className="py-1">
          <ModelEffortRows
            agentType={agentType}
            modelKey={modelOptionKey(model, agentType)}
            effort={effort}
            ownerDeviceId={ownerDeviceId}
            midSession={!blank}
            onSelect={onModelSelect}
          />
        </div>
      )}

      <DropdownMenuSeparator className={controllable ? "" : "hidden"} />
      <div className={SECTION_LABEL}>Move this session</div>
      <div className="pb-1">
        {(Object.keys(MOVE_VERBS) as MoveVerb[]).map((verb) => {
          const meta = MOVE_VERBS[verb];
          const Icon = meta.icon;
          return (
            <DropdownMenuItem
              key={verb}
              data-move-row={verb}
              onSelect={(e) => { e.preventDefault(); setView({ step: "pick", verb }); }}
              className="group mx-1 flex items-center gap-2.5 px-2 py-1.5"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-sol-text-dim transition-colors group-focus:text-sol-cyan" />
              <span className="flex min-w-0 flex-col">
                <span className="text-xs text-sol-text">{meta.label}</span>
                <span className="truncate text-[10px] text-sol-text-dim">{meta.hint}</span>
              </span>
              <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-sol-text-dim/60 transition-transform group-focus:translate-x-0.5" />
            </DropdownMenuItem>
          );
        })}
      </div>
    </div>
  );
}

// ── The header badge ──────────────────────────────────────────────────────────

/**
 * Conversation-header badge. Reads the live store row so an agent or model
 * switch updates the chip immediately. Leftover models from the previous
 * agent are hidden. A local pick overlay holds until the transcript rollup
 * lands the full id (claude-opus → claude-opus-4-8). Owners get the unified
 * session control panel behind it; everyone else a passive readout.
 */
export function HeaderModelControl({
  conversationId,
  agentType: agentTypeProp,
  model: modelProp,
  effort: effortProp,
  messageCount,
  canEdit,
  open,
  onOpenChange,
}: {
  conversationId: string | undefined;
  agentType: string | undefined;
  model: string | undefined;
  effort: string | undefined | null;
  messageCount: number | undefined;
  canEdit: boolean;
  /** Controlled open state, so the overflow menu can open the same panel. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const live = useLiveSessionMeta(conversationId);
  // Controlled by the header when the overflow menu also opens the panel;
  // self-owned otherwise, so a bare mount still opens and closes.
  const [selfOpen, setSelfOpen] = useState(false);
  const isOpen = open ?? selfOpen;
  const setOpen = onOpenChange ?? setSelfOpen;
  const agentType = live?.agentType ?? agentTypeProp;
  const storeModel = (live ? live.model : modelProp) ?? undefined;
  const storeEffort = (live ? live.effort : effortProp) ?? undefined;
  const ownerDeviceId = live?.ownerDeviceId;
  const [picked, setPicked] = useState<{ model?: string; effort?: string } | null>(null);

  useWatchEffect(() => {
    if (!picked) return;
    const modelAck = picked.model === undefined
      || modelOptionKey(storeModel, agentType) === (picked.model === "default" ? "default" : picked.model);
    const effortAck = picked.effort === undefined
      || (picked.effort === "default" ? !storeEffort : storeEffort === picked.effort);
    if (modelAck && effortAck) setPicked(null);
  }, [picked, storeModel, storeEffort, agentType]);

  // Agent switch: drop a pick aimed at the previous agent's catalog.
  useWatchEffect(() => { setPicked(null); }, [agentType]);

  const blank = (messageCount ?? 0) === 0;
  const overlayModel = picked?.model !== undefined
    ? modelStampForPick(agentType, picked.model)
    : (modelFitsAgent(storeModel, agentType) ? storeModel : undefined);
  const overlayEffort = picked?.effort !== undefined
    ? (picked.effort === "default" ? undefined : picked.effort)
    : storeEffort;

  // The panel is the owner's; a blank session still gets it (switch agent,
  // hand off, launch-rail model), so the only gate is ownership.
  const interactive = !!(canEdit && conversationId);
  const glyph = effortGlyph(overlayEffort);

  if (!interactive) {
    if (!overlayModel) return null;
    return (
      <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
        <span className="text-sol-text-dim">&middot;</span>
        <span className="font-mono truncate max-w-none" title={overlayModel}>{formatModel(overlayModel)}</span>
        {glyph && <span className="text-sol-text-dim/80" title={`${overlayEffort} effort`}>{glyph}</span>}
      </div>
    );
  }

  return (
    <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
      <span className="text-sol-text-dim">&middot;</span>
      <DropdownMenu open={isOpen} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            data-session-control-trigger
            className="group flex items-center gap-1 font-mono rounded px-1 -mx-1 transition-colors hover:bg-sol-bg-alt hover:text-sol-text-secondary"
            title={`Model: ${overlayModel ?? "default"}${overlayEffort ? ` · ${overlayEffort} effort` : ""} — model, agent, fork, hand off`}
          >
            <span className="truncate max-w-none">{overlayModel ? formatModel(overlayModel) : "model"}</span>
            {glyph && <span className="text-sol-text-dim/80">{glyph}</span>}
            <svg className="w-2.5 h-2.5 opacity-50 group-hover:opacity-80 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[21rem] max-w-[calc(100vw-1rem)] p-0">
          <SessionControlPanel
            conversationId={conversationId!}
            agentType={agentType}
            model={overlayModel}
            effort={overlayEffort}
            messageCount={messageCount}
            ownerDeviceId={ownerDeviceId}
            onClose={() => setOpen(false)}
            onModelSelect={(sel) => {
              setPicked((prev) => ({ ...prev, ...sel }));
              void commitModelChange({
                conversationId: conversationId!,
                agentType,
                current: { model: storeModel, effort: storeEffort },
                sel,
                blank,
              });
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
