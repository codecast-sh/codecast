// A cloud host waking up, shown where the person waits on it: under the
// message that is waiting (HostWakeNote) and in the session header
// (SessionHostWakeChip). Both read one stage (hooks/useHostWake) and draw the
// same steps, so the header and the bubble never disagree about where the
// wake is.
import { Check, Moon } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { WAKE_STEPS, wakeElapsed } from "../lib/hostWake";
import { WAKE_PHASES } from "@codecast/shared/contracts";
import type { HostWake } from "../hooks/useHostWake";
import { StatusDot } from "./StatusDot";
import { TopbarChip } from "./TopbarButton";
import { HoverCard } from "./ui/HoverCard";
import { StatusPanelHeader, StatusPanelSection } from "./StatusPanel";

const STEP_LABEL: Record<(typeof WAKE_STEPS)[number], string> = {
  requested: "Requested",
  starting: "Starting machine",
  connecting: "Connecting",
};

const HEADLINE: Record<HostWake["stage"], string> = {
  asleep: "Asleep",
  requested: "Wake requested",
  starting: "Starting the machine",
  connecting: "Connecting to sessions",
  failed: "Couldn't start",
  no_waker: "Asleep, can't wake",
};

function wakeColor(w: HostWake): string {
  if (w.stage === "failed") return "var(--sol-red)";
  if (w.stage === "no_waker") return "var(--sol-yellow)";
  if (w.stage === "asleep") return "var(--sol-text-dim)";
  return "var(--sol-cyan)";
}

const isWaking = (w: HostWake) => w.stage === "requested" || w.stage === "starting" || w.stage === "connecting";

/**
 * The three steps of a wake, the current one lit and pulsing, the ones behind
 * it checked: in a row under a message, in a column in the header's panel.
 */
function WakeSteps({ w, column = false }: { w: HostWake; column?: boolean }) {
  const at = isWaking(w) ? WAKE_STEPS.indexOf(w.stage as (typeof WAKE_STEPS)[number]) : 0;
  // Where the boot is inside the current step, as the laptop running it reports.
  const phaseKey = "phase" in w ? w.phase : undefined;
  const phase = phaseKey ? WAKE_PHASES[phaseKey].label : null;
  return (
    <span className={column ? "flex flex-col gap-1.5" : "inline-flex items-center gap-1.5"} data-wake-steps={w.stage}>
      {WAKE_STEPS.map((step, i) => {
        const done = i < at;
        const current = i === at;
        return (
          <span key={step} className={column ? "flex flex-col gap-0.5" : "inline-flex items-center gap-1.5"}>
            {i > 0 && !column && <span className={`h-px w-3 ${done || current ? "bg-sol-cyan/50" : "bg-sol-border"}`} aria-hidden />}
            <span
              className={`inline-flex items-center gap-1.5 whitespace-nowrap ${current ? "font-medium text-sol-cyan" : done ? "text-sol-text-muted" : "text-sol-text-dim/70"}`}
              aria-current={current ? "step" : undefined}
            >
              <span className="flex w-3 justify-center">
                {done ? <Check className="h-3 w-3" /> : current ? <StatusDot color="var(--sol-cyan)" ping /> : <span className="h-1.5 w-1.5 rounded-full border border-current" aria-hidden />}
              </span>
              {STEP_LABEL[step]}
              {current && phase && !column && <span className="font-normal text-sol-text-muted" data-wake-phase={phaseKey}>· {phase}</span>}
            </span>
            {current && phase && column && <span className="block pl-[18px] text-sol-text-muted" data-wake-phase={phaseKey}>{phase}</span>}
          </span>
        );
      })}
    </span>
  );
}

function WakeAgainButton({ w }: { w: HostWake }) {
  if (w.stage !== "failed" || !w.retry) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); useInboxStore.getState().cloudHostAction(w.deviceId, "wake"); }}
      className="rounded border border-sol-border px-2 py-0.5 text-xs text-sol-text-muted transition-colors hover:border-sol-text-dim hover:text-sol-text"
      data-testid="host-wake-again"
    >
      Wake again
    </button>
  );
}

const elapsed = (w: HostWake) => ("since" in w ? wakeElapsed(w.now - w.since) : "");

/** What the line under a waiting message says, beyond the steps. */
function WakeLine({ w }: { w: HostWake }) {
  const color = wakeColor(w);
  if (w.stage === "failed") {
    return (
      <>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium" style={{ color }}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
          Couldn't start
        </span>
        <span className="whitespace-nowrap modern:font-mono text-sol-text-dim">{w.host}</span>
        <span className="line-clamp-2 basis-full break-words pl-3 font-mono text-meta text-sol-text-dim" title={w.error}>{w.error}</span>
      </>
    );
  }
  if (w.stage === "no_waker") {
    return (
      <>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium" style={{ color }}>
          <Moon className="h-3 w-3 shrink-0" />
          Can't wake: {w.waker} offline
        </span>
        <span className="whitespace-nowrap modern:font-mono text-sol-text-dim">{w.host}</span>
      </>
    );
  }
  return (
    <>
      <WakeSteps w={w} />
      {isWaking(w) && <span className="font-mono text-meta tabular-nums text-sol-text-dim">{elapsed(w)}</span>}
      <span className="whitespace-nowrap modern:font-mono text-sol-text-dim">{w.host}</span>
    </>
  );
}

/**
 * Under a message waiting on a host that is asleep or waking. Replaces the
 * "daemon offline, run cast restart" note there: nothing on this machine is
 * broken, it is booting, and a restart command cannot reach it.
 */
export function HostWakeNote({ wake, onCancel, cancelling }: { wake: HostWake; onCancel?: () => void; cancelling?: boolean }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-xs" data-testid="pending-message-host-wake" data-stage={wake.stage}>
      <WakeLine w={wake} />
      <WakeAgainButton w={wake} />
      {onCancel && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          disabled={cancelling}
          data-testid="pending-message-cancel"
          className="text-meta text-sol-text-dim/70 underline underline-offset-2 transition-colors hover:text-sol-orange disabled:opacity-60"
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      )}
    </div>
  );
}

/** The header's short word for the stage. */
function chipText(w: HostWake): string {
  if (isWaking(w)) return `waking · ${elapsed(w)}`;
  if (w.stage === "failed") return "wake failed";
  return "asleep";
}

/**
 * The session header's mark for a host that is asleep or waking, in place of
 * the daemon's "offline 1h": a host that sleeps is not broken. Lit and pulsing
 * only while a wake runs or has failed; a plain asleep host is a quiet word.
 */
export function SessionHostWakeChip({ wake }: { wake: HostWake }) {
  const color = wakeColor(wake);
  const loud = wake.stage !== "asleep";
  const panel = (
    <div className="min-w-0">
      <StatusPanelHeader kicker="Cloud host" color={color} headline={HEADLINE[wake.stage]} sub={wake.host} aside={isWaking(wake) ? elapsed(wake) : undefined} />
      <StatusPanelSection>
        {isWaking(wake) ? (
          <div className="text-xs"><WakeSteps w={wake} column /></div>
        ) : wake.stage === "asleep" ? (
          <div className="text-xs text-sol-text-muted">Wakes on your next message</div>
        ) : wake.stage === "failed" ? (
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-words font-mono text-meta text-sol-red/90">{wake.error}</code>
            <WakeAgainButton w={wake} />
          </div>
        ) : (
          <div className="text-xs text-sol-text-muted">Starts from {wake.waker}, offline</div>
        )}
      </StatusPanelSection>
    </div>
  );
  return (
    <HoverCard card={panel} side="bottom" align="end" className="w-[280px]" focusable>
      <TopbarChip data-host-wake={wake.stage} aria-label={`${wake.host}: ${HEADLINE[wake.stage]}`} tone={color} alert={loud} className="hidden md:flex">
        {wake.stage === "asleep" ? <Moon className="h-3 w-3 shrink-0" /> : <StatusDot color={color} ping={isWaking(wake)} />}
        <span className="max-w-[112px] truncate">{chipText(wake)}</span>
      </TopbarChip>
    </HoverCard>
  );
}

