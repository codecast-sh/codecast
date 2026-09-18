import { useState } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight } from "lucide-react";
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
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { ModelEffortRows } from "./ModelEffortPicker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
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

// ── Agent chips ───────────────────────────────────────────────────────────────

export interface AgentChipSpec {
  type: ConvexAgentType;
  label: string;
  /** Why the chip is unavailable; unset = clickable. */
  disabledReason?: string;
  /** The session's current agent: shown with its ring so the row reads "you are here". */
  current?: boolean;
}

function AgentChip({ spec, onPick }: { spec: AgentChipSpec; onPick: (type: ConvexAgentType) => void }) {
  const accent = agentAccent(spec.type);
  const disabled = !!spec.disabledReason;
  const tip = spec.disabledReason ? `${spec.label} — ${spec.disabledReason}` : spec.label;
  return (
    <ShortcutTooltip label={tip} side="bottom">
      <button
        type="button"
        aria-label={tip}
        aria-disabled={disabled || undefined}
        data-agent-chip={spec.type}
        data-current={spec.current || undefined}
        onClick={(e) => { e.preventDefault(); if (!disabled) onPick(spec.type); }}
        className={`relative flex h-[22px] w-[22px] items-center justify-center rounded-md border transition-all duration-150 ${
          disabled
            ? "cursor-not-allowed border-sol-border/30 opacity-40"
            : "border-sol-border/40 hover:-translate-y-px hover:border-sol-border hover:bg-sol-bg-alt hover:shadow-sm"
        } ${spec.current ? `bg-sol-bg-alt ring-1 ring-offset-0 ${accent.ring}` : ""}`}
      >
        <AgentTypeIcon agentType={spec.type} className="h-3 w-3" />
      </button>
    </ShortcutTooltip>
  );
}

function AgentChipRow({ label, chips, onPick }: { label: string; chips: AgentChipSpec[]; onPick: (type: ConvexAgentType) => void }) {
  return (
    <div data-chip-row={label} className="flex items-center justify-between gap-3 px-3 py-1">
      <span className="whitespace-nowrap text-[11px] text-sol-text-secondary">{label}</span>
      <div className="flex items-center gap-[3px]">
        {chips.map((c) => <AgentChip key={c.type} spec={c} onPick={onPick} />)}
      </div>
    </div>
  );
}

/** The three chip rows' specs from one session state. Exported for tests. */
export function moveChipSpecs(agentType: string | undefined, messageCount: number | undefined) {
  const current = (agentType || "claude_code") as ConvexAgentType;
  const count = messageCount ?? 0;
  const cannotRebuild = (label: string) => `${label} can't rebuild this session's ${count} message${count === 1 ? "" : "s"}`;
  const all = AGENT_LAUNCH_OPTIONS.map((a) => ({ type: a.convexType, label: a.label }));
  return {
    switch: all.map<AgentChipSpec>((a) =>
      a.type === current
        ? { ...a, current: true, disabledReason: "current agent" }
        : canSessionBecomeAgent(a.type, count) ? a : { ...a, disabledReason: cannotRebuild(a.label) },
    ),
    fork: all.filter((a) => a.type !== current).map<AgentChipSpec>((a) =>
      canSessionBecomeAgent(a.type, count) ? a : { ...a, disabledReason: cannotRebuild(a.label) },
    ),
    handoff: all.map<AgentChipSpec>((a) => (a.type === current ? { ...a, current: true } : a)),
  };
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
  const accent = agentAccent(agent);

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
        <span className="flex items-center gap-1.5 text-xs text-sol-text">
          Hand off to
          <span className={`flex h-[18px] w-[18px] items-center justify-center rounded border border-sol-border/40 bg-sol-bg-alt ring-1 ${accent.ring}`}>
            <AgentTypeIcon agentType={agent} className="h-2.5 w-2.5" />
          </span>
          <span className="font-medium">{label}</span>
        </span>
      </div>
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
  const [handoffAgent, setHandoffAgent] = useState<ConvexAgentType | null>(null);
  const blank = (messageCount ?? 0) === 0;
  const controllable = canControlModel(agentType, blank);
  const agentLabel = formatAgentType(agentType);
  const glyph = effortGlyph(effort);
  const chips = moveChipSpecs(agentType, messageCount);

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

  if (handoffAgent) {
    return (
      <HandoffStep
        conversationId={conversationId}
        agent={handoffAgent}
        ownerDeviceId={ownerDeviceId}
        onBack={() => setHandoffAgent(null)}
        onDone={onClose}
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
      <div className="flex flex-col pb-2">
        <AgentChipRow label="Switch agent" chips={chips.switch} onPick={onSwitch} />
        <AgentChipRow label="Fork as" chips={chips.fork} onPick={onFork} />
        <AgentChipRow label="Hand off to" chips={chips.handoff} onPick={setHandoffAgent} />
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
