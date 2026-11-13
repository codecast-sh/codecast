"use client";
import { FEATURE_EXPLAINERS, type AgentSetupTool, type AgentToolSetupStatus } from "@codecast/shared/contracts";
import { FeaturePathView, type SetupProbe } from "../../components/agentFeatures/FeaturePath";
import { featureIcon, featureTone } from "../../components/agentFeatures/featureLook";
import { Button } from "../../components/ui/button";

const B = (p: Partial<AgentToolSetupStatus & { tool: "browser" }>): AgentToolSetupStatus => ({ tool: "browser", ready: false, installed: false, paired: false, connected: false, chrome_running: true, ...p });
const C = (p: Partial<AgentToolSetupStatus & { tool: "computer" }>): AgentToolSetupStatus => ({ tool: "computer", ready: false, accessibility: false, screen_recording: false, supported: true, ...p });
const probe = (p: Partial<SetupProbe>): SetupProbe => ({ status: undefined, error: null, checking: false, waiting: false, check: async () => {}, start: async () => {}, ...p });

type State = { label: string; on: boolean; probe: SetupProbe; blocked?: { reason: string; locked?: boolean } };
const STATES: Record<AgentSetupTool, State[]> = {
  browser: [
    { label: "1 · Off", on: false, probe: probe({}) },
    { label: "2 · Checking the machine", on: true, probe: probe({ checking: true }) },
    { label: "3 · Extension not installed", on: true, probe: probe({ status: B({}) }) },
    { label: "4 · Installed, not paired", on: true, probe: probe({ status: B({ installed: true }) }) },
    { label: "5 · Waiting for Pair in Chrome", on: true, probe: probe({ status: B({ installed: true }), waiting: true }) },
    { label: "6 · Paired before, not answering", on: true, probe: probe({ status: B({ installed: true, paired: true }) }) },
    { label: "7 · Connected: try it", on: true, probe: probe({ status: B({ installed: true, paired: true, connected: true, ready: true }) }) },
    { label: "Edge · Machine offline", on: false, probe: probe({}), blocked: { reason: "MacBook-Pro-2 is offline. Its switches come back when it reconnects." } },
    { label: "Edge · Machine did not answer", on: true, probe: probe({ error: "The machine running this session did not answer. Is it online, with codecast up to date?" }) },
  ],
  computer: [
    { label: "1 · Off", on: false, probe: probe({}) },
    { label: "2 · Checking the machine", on: true, probe: probe({ checking: true }) },
    { label: "3 · Accessibility missing", on: true, probe: probe({ status: C({}) }) },
    { label: "4 · Waiting for System Settings", on: true, probe: probe({ status: C({}), waiting: true }) },
    { label: "5 · Screen Recording missing", on: true, probe: probe({ status: C({ accessibility: true }) }) },
    { label: "6 · Granted: try it", on: true, probe: probe({ status: C({ accessibility: true, screen_recording: true, ready: true }) }) },
    { label: "Edge · Not supported here", on: true, probe: probe({ status: C({ supported: false, detail: "cast computer needs macOS." }) }) },
    { label: "Edge · Held off by team", on: false, probe: probe({}), blocked: { reason: "Held off by your team", locked: true } },
  ],
};

export default function Page() {
  return (
    <div className="h-full overflow-y-auto bg-sol-bg-alt p-8">
      {(["browser", "computer"] as const).map((tool) => {
        const e = FEATURE_EXPLAINERS[tool]!;
        const Icon = featureIcon(tool);
        const tone = featureTone(tool);
        return (
          <section key={tool} id={tool} className="mb-12">
            <h1 className="mb-4 text-xl font-semibold capitalize text-sol-text">{tool}</h1>
            <div className="grid grid-cols-3 gap-5">
              {STATES[tool].map((st) => (
                <div key={st.label}>
                  <div className="mb-1.5 font-mono text-meta text-sol-text-dim">{st.label}</div>
                  <div className="overflow-hidden rounded-xl border border-sol-border bg-sol-bg">
                    <div className="flex items-start gap-3 border-b border-sol-border px-5 pb-4 pt-5">
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.tile}`}><Icon className="h-4 w-4" /></div>
                      <div className="min-w-0">
                        <div className="text-base font-semibold capitalize text-sol-text">{tool}</div>
                        <div className="text-[12.5px] text-sol-text-secondary">{e.pitch}</div>
                      </div>
                    </div>
                    <div className="px-5 py-5">
                      <FeaturePathView
                        on={st.on}
                        blocked={st.blocked}
                        machineName="MacBook-Pro-2"
                        setup={{ tool, deviceId: "x" }}
                        tryIt={e.tryIt}
                        onClose={() => {}}
                        probe={st.probe}
                        turnOn={<Button variant="cyan">Turn on {tool === "browser" ? "Browser" : "Computer"}</Button>}
                      />
                    </div>
                    <div className="border-t border-sol-border/50 px-5 py-3 text-xs text-sol-text-muted">› How it works</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
