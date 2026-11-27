// The triage lab: flip a session's facts and watch where today's inbox files
// it and where the triage model files it. Every answer comes from the shipped
// code (placeInboxRow, triageOf) through lib/triage/labModel.
import { useMemo, useState, type ReactNode } from "react";
import {
  TRIAGE_ASKS,
  TRIAGE_LANES,
  TRIAGE_REASONS,
  TRIAGE_SHELF_WORDS,
  triageSectionOf,
  type TriageReason,
  type TriageSection,
} from "@codecast/shared/contracts/triage";
import { LAB_DEFAULTS, LAB_SCENARIOS, runLab, type LabFacts } from "../../lib/triage/labModel";
import { isMove, TODAY_SECTION_WORD } from "../../lib/triage/liveTriage";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { ReasonChip, TriageMark, TriageRowView } from "./triageVisual";
import { ASK_STATUS, ASK_TEXT, LANE_STATUS, LANE_TEXT, askWord, laneWord, textOfTriage } from "../../lib/triage/triageLook";

type Option<T extends string> = [T, string];
type Field =
  | { kind: "bool"; key: keyof LabFacts; label: string }
  | { kind: "pick"; key: keyof LabFacts; label: string; options: Option<string>[] };

const GROUPS: Array<{ title: string; fields: Field[] }> = [
  {
    title: "Agent",
    fields: [
      { kind: "pick", key: "agent", label: "Status", options: [["none", "No daemon"], ["starting", "Starting"], ["working", "Working"], ["compacting", "Compacting"], ["idle", "Turn ended"], ["permission_blocked", "Permission prompt"], ["stopped", "Process died"], ["hibernated", "Hibernated"]] },
      { kind: "bool", key: "messages", label: "Has messages" },
      { kind: "bool", key: "queued", label: "Your message queued" },
    ],
  },
  {
    title: "What it said",
    fields: [
      { kind: "bool", key: "question", label: "Open question" },
      { kind: "bool", key: "decide", label: "Pending cast decide" },
      { kind: "pick", key: "declared", label: "cast state", options: [["none", "Nothing"], ["working", "working"], ["blocked", "blocked"], ["done", "done"], ["dormant", "dormant"]] },
      { kind: "pick", key: "verdict", label: "Reply read as", options: [["none", "Nothing"], ["done", "Done"], ["needs_input", "An ask"]] },
    ],
  },
  {
    title: "Failures",
    fields: [
      { kind: "pick", key: "apiError", label: "API error", options: [["none", "None"], ["limit", "Usage limit"], ["throttle", "Throttled"], ["auth", "Signed out"], ["context", "Context full"], ["fatal", "Won't retry"]] },
      { kind: "bool", key: "sessionError", label: "Session error" },
      { kind: "bool", key: "unresponsive", label: "Unresponsive" },
    ],
  },
  {
    title: "Wakes",
    fields: [
      { kind: "bool", key: "worker", label: "Subagent working" },
      { kind: "bool", key: "loop", label: "/loop armed" },
      { kind: "pick", key: "trigger", label: "Trigger", options: [["none", "None"], ["standing", "Standing"], ["once", "Once"]] },
      { kind: "pick", key: "parked", label: "Server sees", options: [["none", "Nothing"], ["blocker", "Task blocker"], ["wait", "A wait"], ["run", "Workflow run"]] },
      { kind: "bool", key: "backgroundTask", label: "Background task" },
      { kind: "bool", key: "claimOld", label: "Quiet past claim TTL" },
      { kind: "pick", key: "pr", label: "Pull request", options: [["none", "None"], ["open", "Open"], ["draft", "Draft"], ["merged", "Merged"], ["closed", "Closed"]] },
    ],
  },
  {
    title: "You",
    fields: [
      { kind: "bool", key: "unread", label: "Unread" },
      { kind: "pick", key: "rest", label: "Moved to", options: [["none", "Nowhere"], ["needs_input", "Needs you"], ["done", "Done"], ["dormant", "Dormant"]] },
      { kind: "pick", key: "snooze", label: "Snooze", options: [["none", "None"], ["future", "3h from now"], ["due", "Ran out"]] },
      { kind: "bool", key: "pinned", label: "Pinned" },
      { kind: "bool", key: "stashed", label: "Stashed" },
      { kind: "bool", key: "killed", label: "Killed" },
      { kind: "bool", key: "anchor", label: "Role's standing session" },
    ],
  },
];

const SECTION_WORD: Record<TriageSection, string> = {
  pinned: "Pinned", you: laneWord("you"), agent: laneWord("agent"), parked: laneWord("parked"), settled: laneWord("settled"),
  snoozed: "Snoozed", stashed: "Stashed", retired: "Retired",
};

export function TriageLab() {
  const now = useCoarseNow(60_000);
  const [facts, setFacts] = useState<LabFacts>({ ...LAB_DEFAULTS, ...LAB_SCENARIOS[0].facts });
  const [scenarioId, setScenarioId] = useState<string | null>(LAB_SCENARIOS[0].id);
  const result = useMemo(() => runLab(facts, now), [facts, now]);
  const section = triageSectionOf(result.triage);
  const scenario = LAB_SCENARIOS.find((s) => s.id === scenarioId) ?? null;
  const gallery = useMemo(() => LAB_SCENARIOS.map((sc) => ({ sc, r: runLab({ ...LAB_DEFAULTS, ...sc.facts }, now) })), [now]);

  const set = <K extends keyof LabFacts>(key: K, value: LabFacts[K]) => {
    setFacts((f) => ({ ...f, [key]: value }));
    setScenarioId(null);
  };
  const load = (id: string) => {
    const sc = LAB_SCENARIOS.find((s) => s.id === id);
    if (!sc) return;
    setFacts({ ...LAB_DEFAULTS, ...sc.facts });
    setScenarioId(id);
  };
  const loadReason = (reason: TriageReason) => {
    const sc = LAB_SCENARIOS.find((s) => s.expect === reason);
    if (sc) load(sc.id);
  };
  const changed = (k: keyof LabFacts) => facts[k] !== LAB_DEFAULTS[k];

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-5 py-5 lg:grid-cols-[19rem_1fr]">
      <aside className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-mark font-semibold uppercase tracking-[0.08em] text-sol-text-muted">Facts</span>
          <button type="button" onClick={() => { setFacts(LAB_DEFAULTS); setScenarioId(null); }} className="text-meta text-sol-text-muted hover:text-sol-text">Reset</button>
        </div>
        {GROUPS.map((g) => (
          <fieldset key={g.title} className="flex flex-col gap-1.5">
            <legend className="mb-1 text-meta font-medium text-sol-text-muted">{g.title}</legend>
            {g.fields.map((field) => (
              <div key={field.key} className="flex items-center justify-between gap-3">
                <span className={`text-sm ${changed(field.key) ? "text-sol-text" : "text-sol-text-muted"}`}>{field.label}</span>
                {field.kind === "bool" ? (
                  <Toggle on={facts[field.key] as boolean} onChange={(v) => set(field.key, v as never)} />
                ) : (
                  <select
                    value={facts[field.key] as string}
                    onChange={(e) => set(field.key, e.target.value as never)}
                    className="h-7 max-w-[10rem] rounded-md border border-sol-border bg-transparent px-1.5 text-sm text-sol-text"
                  >
                    {field.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                )}
              </div>
            ))}
          </fieldset>
        ))}
      </aside>

      <main className="flex min-w-0 flex-col gap-6">
        <section data-lab-result className="flex flex-col gap-3 rounded-lg border border-sol-border p-4">
          <TriageRowView triage={result.triage} title={scenario?.title ?? "Custom session"} project="codecast" activityAt={now - 4 * 60_000} now={now} />
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Readout label="Lane">
              <span className={`flex items-center gap-1.5 ${LANE_TEXT[result.triage.lane]}`}><SessionStatusMark status={LANE_STATUS[result.triage.lane]} labeled />{laneWord(result.triage.lane)}</span>
            </Readout>
            <Readout label="Ask">
              {result.triage.ask ? <span className={`flex items-center gap-1.5 ${ASK_TEXT[result.triage.ask]}`}><SessionStatusMark status={ASK_STATUS[result.triage.ask]} labeled />{askWord(result.triage.ask)}</span> : <span className="text-sol-text-dim">None</span>}
            </Readout>
            <Readout label="Reason"><ReasonChip triage={result.triage} /></Readout>
            <Readout label="Shelf">
              <span className={result.triage.shelf ? "text-sol-text" : "text-sol-text-dim"}>{result.triage.shelf ? TRIAGE_SHELF_WORDS[result.triage.shelf] : "None"}</span>
            </Readout>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-sol-border pt-3 text-sm">
            <span className="text-sol-text-muted">Shows in <span className="text-sol-text">{section ? SECTION_WORD[section] : "no list (hidden)"}</span>{result.triage.surfaced && <span className="text-sol-text-dim"> · surfaced from Stashed</span>}</span>
            <span className="text-sol-text-muted">Today <span className="text-sol-text">{TODAY_SECTION_WORD[result.today.bucket] ?? result.today.bucket}</span></span>
          </div>
        </section>

        <section data-lab-reasons className="flex flex-col gap-2">
          <span className="text-mark font-semibold uppercase tracking-[0.08em] text-sol-text-muted">Every reason</span>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {TRIAGE_LANES.map((lane) => (
              <div key={lane} className="flex flex-col gap-2">
                <span className={`flex items-center gap-1.5 text-sm font-medium ${LANE_TEXT[lane]}`}><SessionStatusMark status={LANE_STATUS[lane]} labeled />{laneWord(lane)}</span>
                {lane === "you" ? (
                  TRIAGE_ASKS.map((ask) => (
                    <div key={ask} className="flex flex-col gap-1 pl-3">
                      <span className={`text-meta ${ASK_TEXT[ask]}`}>{askWord(ask)}</span>
                      <ReasonPills reasons={reasonsOf(lane, ask)} current={result.triage.reason} onPick={loadReason} />
                    </div>
                  ))
                ) : (
                  <ReasonPills reasons={reasonsOf(lane, null)} current={result.triage.reason} onPick={loadReason} />
                )}
              </div>
            ))}
          </div>
        </section>

        <section data-lab-gallery className="flex flex-col">
          <div className="mb-1 grid grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_minmax(0,11rem)] gap-3 px-2 text-mark font-semibold uppercase tracking-[0.08em] text-sol-text-muted">
            <span>Situation</span><span>Today</span><span>New</span>
          </div>
          {gallery.map(({ sc, r }) => {
            const sec = triageSectionOf(r.triage);
            const moved = isMove(r.today.bucket, sec);
            return (
              <button
                key={sc.id}
                type="button"
                onClick={() => load(sc.id)}
                aria-current={sc.id === scenarioId}
                className={`grid h-8 grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_minmax(0,11rem)] items-center gap-3 rounded-md px-2 text-left text-sm ${sc.id === scenarioId ? "bg-sol-bg-alt" : "hover:bg-sol-bg-alt"}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden title={moved ? "Files somewhere new" : undefined} className={`h-1.5 w-1.5 shrink-0 rounded-full ${moved ? "bg-sol-orange" : "bg-transparent"}`} />
                  <span className="truncate text-sol-text">{sc.title}</span>
                </span>
                <span className={`truncate ${moved ? "text-sol-text-dim line-through decoration-sol-text-dim/40" : "text-sol-text-muted"}`}>{TODAY_SECTION_WORD[r.today.bucket] ?? r.today.bucket}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <TriageMark triage={r.triage} />
                  <span className={`truncate ${textOfTriage(r.triage)}`}>{TRIAGE_REASONS[r.triage.reason].word}</span>
                  <span className="truncate text-meta text-sol-text-dim">{sec ? SECTION_WORD[sec] : "hidden"}</span>
                </span>
              </button>
            );
          })}
        </section>
      </main>
    </div>
  );
}

function reasonsOf(lane: string, ask: string | null): TriageReason[] {
  return (Object.keys(TRIAGE_REASONS) as TriageReason[]).filter((r) => TRIAGE_REASONS[r].lane === lane && TRIAGE_REASONS[r].ask === ask);
}

function ReasonPills({ reasons, current, onPick }: { reasons: TriageReason[]; current: TriageReason; onPick: (r: TriageReason) => void }) {
  const tried = new Set(LAB_SCENARIOS.map((s) => s.expect));
  return (
    <div className="flex flex-wrap gap-1">
      {reasons.map((r) => (
        <button
          key={r}
          type="button"
          disabled={!tried.has(r)}
          onClick={() => onPick(r)}
          aria-current={r === current}
          className={`rounded px-1.5 py-0.5 text-meta ${r === current ? "bg-sol-text text-sol-bg" : tried.has(r) ? "bg-sol-bg-alt text-sol-text-muted hover:text-sol-text" : "bg-sol-bg-alt/50 text-sol-text-dim"}`}
        >
          {TRIAGE_REASONS[r].word}
        </button>
      ))}
    </div>
  );
}

function Readout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-meta text-sol-text-dim">{label}</span>
      <span className="text-sm font-medium">{children}</span>
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${on ? "bg-sol-blue" : "bg-sol-border"}`}
    >
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-sol-bg transition-transform ${on ? "translate-x-3.5" : "translate-x-0.5"}`} />
    </button>
  );
}
