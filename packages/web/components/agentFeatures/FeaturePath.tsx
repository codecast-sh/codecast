"use client";

// The way through one feature, as steps with one button lit at a time: turn it
// on, do the one-time step on the machine if it has one (the Chrome extension,
// the macOS grants), then try it in a new session. Done steps collapse to a
// green line, steps not reached yet are only their names.

import { Check, ExternalLink, Loader2, Lock, RotateCw } from "lucide-react";
import type { AgentSetupTool } from "@codecast/shared/contracts";
import { Button } from "../ui/button";
import { agentSetupSteps } from "../../lib/agentToolSetupSteps";
import { useAgentToolSetup } from "../../lib/useAgentToolSetup";
import { useInboxStore } from "../../store/inboxStore";

const SETUP_TITLE: Record<AgentSetupTool, { todo: string; done: string }> = {
  browser: { todo: "Connect your Chrome", done: "Chrome connected" },
  computer: { todo: "Allow your Mac's apps", done: "Permissions granted" },
};

type StepState = "done" | "current" | "later";

type FeaturePathProps = {
  on: boolean;
  /** The Turn on button, wired to the feature's review by the page. */
  turnOn: React.ReactNode;
  /** Why it cannot be turned on from here (machine offline, held off by the team). */
  blocked?: { reason: string; locked?: boolean } | null;
  machineName: string;
  setup?: { tool: AgentSetupTool; deviceId: string } | null;
  tryIt: string;
  onClose: () => void;
};

export type SetupProbe = Pick<ReturnType<typeof useAgentToolSetup>, "status" | "error" | "checking" | "waiting" | "check" | "start">;

export function FeaturePath(props: FeaturePathProps) {
  const { setup, on, blocked } = props;
  const probe = useAgentToolSetup(setup ? { deviceId: setup.deviceId } : null, setup?.tool ?? "browser", !!setup && on && !blocked);
  return <FeaturePathView {...props} probe={probe} />;
}

/** The steps drawn from a setup probe, so every state can be drawn without a machine. */
export function FeaturePathView({ on, turnOn, blocked, machineName, setup, tryIt, onClose, probe: s }: FeaturePathProps & { probe: SetupProbe }) {
  const setupDone = !setup || !!s.status?.ready;
  const unsupported = setup?.tool === "computer" && s.status?.tool === "computer" && !s.status.supported;

  const steps: Array<{ key: string; title: string; state: StepState; body?: React.ReactNode }> = [
    {
      key: "on",
      title: on ? `On for ${machineName}` : "Turn it on",
      state: on ? "done" : "current",
      body: blocked ? (
        <p className="flex items-center gap-1.5 text-[12.5px] text-sol-yellow">
          {blocked.locked && <Lock className="h-3 w-3" />}
          {blocked.reason}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {turnOn}
          <span className="text-meta text-sol-text-dim">for agents on {machineName}</span>
        </div>
      ),
    },
  ];

  if (setup) {
    const sub = agentSetupSteps(setup.tool, s.status);
    const next = sub.find((st) => !st.done);
    steps.push({
      key: "setup",
      title: setupDone && on ? `${SETUP_TITLE[setup.tool].done} on ${machineName}` : SETUP_TITLE[setup.tool].todo,
      state: !on ? "later" : setupDone ? "done" : "current",
      body: unsupported ? (
        <p className="text-[12.5px] text-sol-text-muted">{(s.status as { detail?: string }).detail ?? "Not available on this machine."}</p>
      ) : s.checking ? (
        <p className="flex items-center gap-2 text-[12.5px] text-sol-text-dim">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking {machineName}…
        </p>
      ) : (
        <div className="space-y-3">
          <ul className="space-y-1.5">
            {sub.map((st) => (
              <li key={st.label} className="flex items-start gap-2 text-[12.5px]">
                {st.done ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sol-green" strokeWidth={2.5} />
                ) : (
                  <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${st === next ? "bg-sol-cyan" : "bg-sol-border"} mx-1`} />
                )}
                <span className={st.done ? "text-sol-text-muted" : st === next ? "text-sol-text" : "text-sol-text-dim"}>
                  {st.label}
                  {st === next && st.hint && <span className="block text-sol-text-dim">{st.hint}</span>}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            {next?.action &&
              ("href" in next.action ? (
                <Button asChild variant="cyan">
                  <a href={next.action.href} target="_blank" rel="noopener noreferrer">
                    {next.action.label} <ExternalLink />
                  </a>
                </Button>
              ) : (
                <Button variant="cyan" disabled={s.waiting} onClick={() => void s.start()}>
                  {s.waiting && <Loader2 className="animate-spin" />}
                  {s.waiting ? (setup.tool === "browser" ? "Click Pair in Chrome…" : "Waiting for System Settings…") : next.action.label}
                </Button>
              ))}
            <Button variant="ghost" size="sm" onClick={() => void s.check()} className="text-sol-text-muted">
              <RotateCw /> Check again
            </Button>
          </div>
          {s.error && <p className="text-meta text-sol-red/90">{s.error}</p>}
        </div>
      ),
    });
  }

  const ready = on && setupDone && !unsupported;
  steps.push({
    key: "try",
    title: "Try it",
    state: ready ? "current" : "later",
    body: (
      <div className="space-y-3">
        <p className="text-[13px] text-sol-text-secondary">&ldquo;{tryIt}&rdquo;</p>
        <Button
          variant="cyan"
          onClick={() => {
            onClose();
            useInboxStore.getState().openCompose(tryIt);
          }}
          data-feature-try
        >
          Ask an agent
        </Button>
      </div>
    ),
  });

  return (
    <ol className="space-y-0" data-feature-path>
      {steps.map((st, i) => (
        <li key={st.key} className="relative flex gap-3.5 pb-5 last:pb-0">
          {i < steps.length - 1 && <span aria-hidden className="absolute left-[11px] top-7 bottom-1 w-px bg-sol-border/70" />}
          <span
            className={`relative z-[1] mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] ${
              st.state === "done"
                ? "border-sol-green/60 bg-sol-green/10 text-sol-green"
                : st.state === "current"
                  ? "border-sol-cyan bg-sol-cyan/15 text-sol-cyan"
                  : "border-sol-border text-sol-text-dim"
            }`}
          >
            {st.state === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div
              className={`text-[14px] font-medium ${
                st.state === "done" ? "text-sol-text-muted" : st.state === "current" ? "text-sol-text" : "text-sol-text-dim"
              }`}
            >
              {st.title}
            </div>
            {st.state === "current" && st.body && <div className="mt-2.5">{st.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
