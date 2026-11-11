/**
 * The setup card under a `cast browser` / `cast computer` command that failed
 * for want of the Chrome extension or the macOS grants. The agent cannot do
 * either step, so the card does them with the person reading: it reads where
 * setup stands on the session's machine, starts each step there, follows it
 * until it lands, and then offers to tell the agent to carry on.
 */

import { useRef, useState } from "react";
import { Check, ExternalLink, Loader2, RotateCw } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AGENT_SETUP_CONTINUE_MESSAGE, deviceDisplayName, type AgentSetupTool } from "@codecast/shared/contracts";
import { agentSetupSteps, type AgentSetupStep } from "../../../lib/agentToolSetupSteps";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useAgentToolSetup, type AgentSetupTarget } from "../../../lib/useAgentToolSetup";
import { useInboxStore } from "../../../store/inboxStore";

const TITLE: Record<AgentSetupTool, string> = {
  browser: "Connect your Chrome",
  computer: "Let the agent use your Mac's apps",
};

const READY_LINE: Record<AgentSetupTool, string> = {
  browser: "Chrome extension connected",
  computer: "Accessibility and Screen Recording granted",
};

export function AgentToolSetupCard({ tool, conversationId }: { tool: AgentSetupTool; conversationId: string }) {
  // Enrichment only: without it the card still shows the steps, just unnamed.
  const machineQuery = useQueryNoThrow(api.devices.getConversationMachine, { conversation_id: conversationId as any });
  const machine = machineQuery.data as { is_mine?: boolean; label?: string; platform?: string } | null | undefined;
  const [continued, setContinued] = useState(false);
  return (
    <AgentToolSetupPanel
      tool={tool}
      target={{ conversationId }}
      machineName={machine ? deviceDisplayName(machine as any) : null}
      canAct={machine?.is_mine !== false}
      className="mt-1 ml-1"
      afterReady={(sawMissing) =>
        sawMissing && !continued && (
          <button
            type="button"
            className="ml-1 px-2 py-0.5 rounded border border-sol-green/40 bg-sol-green/10 text-sol-green hover:bg-sol-green/20"
            onClick={() => {
              setContinued(true);
              useInboxStore.getState().sendMessage(conversationId, AGENT_SETUP_CONTINUE_MESSAGE[tool]);
            }}
          >
            Tell the agent to continue
          </button>
        )
      }
    />
  );
}

/**
 * The steps themselves, for one machine: under a failed command in a
 * conversation, and in the Browser and Computer features on the Agent
 * features page. `afterReady` adds to the done line; it is told whether this
 * panel watched setup go from missing to done.
 */
export function AgentToolSetupPanel({
  tool,
  target,
  machineName,
  canAct = true,
  compact = false,
  className = "",
  afterReady,
}: {
  tool: AgentSetupTool;
  target: AgentSetupTarget;
  machineName: string | null;
  canAct?: boolean;
  /** One line and the buttons for what is left, for a feature card. */
  compact?: boolean;
  className?: string;
  afterReady?: (sawMissing: boolean) => React.ReactNode;
}) {
  const setup = useAgentToolSetup(target, tool, canAct);
  const status = setup.status;
  const ready = !!status?.ready;

  // Remembered so an old row whose setup was finished long ago stays a quiet receipt.
  const sawMissing = useRef(false);
  if (status && !status.ready) sawMissing.current = true;

  if (ready) {
    return (
      <div className={`${className} flex items-center gap-2 text-[12px] text-sol-green`}>
        <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
        <span>{READY_LINE[tool]}{machineName ? ` on ${machineName}` : ""}</span>
        {afterReady?.(sawMissing.current)}
      </div>
    );
  }

  if (!canAct) {
    return (
      <div className={`${className} border-l-2 border-sol-cyan/40 pl-2.5 text-[12px] text-sol-text-muted`}>
        {tool === "browser" ? "The agent needs the Codecast Chrome extension" : "The agent needs macOS permissions for cast computer"}
        {machineName ? ` on ${machineName}` : ""}. Whoever runs this session can set it up from here.
      </div>
    );
  }

  if (status && status.tool === "computer" && !status.supported) {
    return (
      <div className={`${className} border-l-2 border-sol-yellow/40 pl-2.5 text-[12px] text-sol-text-muted`}>
        {status.detail ?? "cast computer is not available on this machine."}
      </div>
    );
  }

  const steps = agentSetupSteps(tool, status);
  const next = steps.findIndex((st) => !st.done);
  const action = (st: AgentSetupStep) => st.action && <StepAction action={st.action} waiting={setup.waiting} onStart={() => void setup.start()} />;

  if (compact) {
    const left = steps.filter((st) => !st.done);
    return (
      <div data-cc-agent-setup className={`${className} space-y-1.5`}>
        <div className="flex items-center gap-1.5 text-meta text-sol-yellow">
          {setup.checking || setup.waiting ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          <span>
            {setup.checking
              ? "Checking setup…"
              : setup.waiting
                ? tool === "computer" ? "Turn on \"codecast computer\" in System Settings" : "Click Pair in Chrome"
                : `Next: ${left.map((st) => st.next).join(", then ")}`}
          </span>
        </div>
        {!setup.checking && (
          <div className="flex flex-wrap gap-1.5 text-meta">
            {/* One button per action: both grants open the same System Settings flow. */}
            {left.filter((st, i) => st.action && left.findIndex((o) => o.action?.label === st.action!.label) === i).map((st) => <span key={st.label}>{action(st)}</span>)}
          </div>
        )}
        {setup.error && <p className="text-meta text-sol-red/90">{setup.error}</p>}
      </div>
    );
  }

  return (
    <div data-cc-agent-setup className={`${className} border-l-2 border-sol-cyan/50 pl-2.5 py-1 space-y-2 max-w-xl`}>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] text-sol-text">{TITLE[tool]}</span>
        {machineName && <span className="text-meta text-sol-text-dim">on {machineName}</span>}
        <button
          type="button"
          aria-label="Check again"
          title="Check again"
          className="ml-auto text-sol-text-dim hover:text-sol-text"
          onClick={() => void setup.check()}
        >
          {setup.checking || setup.waiting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
        </button>
      </div>
      <ol className="space-y-1.5">
        {steps.map((st, i) => {
          const current = i === next && !setup.checking;
          return (
            <li key={st.label} className="flex items-start gap-2 text-[12px]">
              <span className={`mt-[1px] shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border text-mark font-mono ${st.done ? "border-sol-green/60 text-sol-green" : current ? "border-sol-cyan/70 text-sol-cyan" : "border-sol-border text-sol-text-dim"}`}>
                {st.done ? <Check className="w-2.5 h-2.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={st.done ? "text-sol-text-muted line-through decoration-sol-text-dim/40" : "text-sol-text"}>{st.label}</span>
                {!st.done && st.hint && <span className="block text-sol-text-dim">{st.hint}</span>}
              </span>
              {!st.done && action(st)}
            </li>
          );
        })}
      </ol>
      {setup.waiting && tool === "computer" && (
        <p className="text-meta text-sol-text-dim">Turn on "codecast computer" in the pane that opened{machineName ? ` on ${machineName}` : ""}. This card updates when it lands.</p>
      )}
      {setup.error && <p className="text-meta text-sol-red/90">{setup.error}</p>}
    </div>
  );
}

function StepAction({ action, waiting, onStart }: { action: NonNullable<AgentSetupStep["action"]>; waiting: boolean; onStart: () => void }) {
  if ("href" in action) {
    return (
      <a
        href={action.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-sol-cyan/50 bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/20"
      >
        {action.label} <ExternalLink className="w-3 h-3" />
      </a>
    );
  }
  return (
    <button
      type="button"
      disabled={waiting}
      onClick={(e) => {
        e.stopPropagation();
        onStart();
      }}
      className="shrink-0 px-2 py-0.5 rounded border border-sol-cyan/50 bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/20 disabled:opacity-50"
    >
      {waiting ? "Waiting…" : action.label}
    </button>
  );
}
