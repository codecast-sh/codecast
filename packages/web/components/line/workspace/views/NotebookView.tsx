"use client";
// The Notebook view (line-workspace.md LW1), ported from the Notebook
// prototype: the line as one calm document, a step at a time. On the left the
// outline: the steps a person reads (agents and people) down a spine split
// into its halves, the scripts between them folded small, loops drawn back on
// the left, and the traced run's path lit. On the right the open step: who
// does it, its job in one sentence, where it sends work and how often, then
// its decisions (each labeled right or wrong in one click), its prompt read as
// a document or edited, and improving it with an agent. Above both, the run
// being traced and the line's changes: the prompt texts its runs read, and the
// edits not yet saved. The Notebook draws the step itself, so the shell keeps
// the step drawer closed while it shows.
import { Fragment, memo, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { decisionKey, decisionSaid, decisionsByCase, type CaseDecisions, type LineModel, type LineRunModel, type LineStep, type StepDecision } from "../../../../lib/line/lineModel";
import { notebookOutline, outlineLayout, type NotebookOutline, type OutlineFlow, type OutlineRow } from "../../../../lib/line/notebookOutline";
import { promptDiff } from "../../../../lib/line/promptText";
import type { OutcomeTone as RunTone } from "../../../../lib/line/runReport";
import { useInboxStore } from "../../../../store/inboxStore";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { KeyCap } from "../../../KeyCap";
import {
  LINE_ACTIONS, NavLink, DecisionTag, failureWords, PromptDiffLines, PromptView, ResultFields, dayWords, durationWords, useLineNav, type OutcomeTone,
} from "../../widgets";
import type { LineViewProps } from "./types";
import { setStepDraft, useStepDrafts, type DrawerTab } from "../stepDrafts";
import { stepTabs } from "../stepTabs";
import { usePopover } from "../usePopover";
import { FindBand } from "../FindBand";
import "./notebook.css";

type Tab = DrawerTab;
type StepUi = { tab?: Tab; open?: string | null; editing?: boolean; showDiff?: boolean; limit?: number };

const PAGE = 40;
const RUN_TONE: Record<RunTone, OutcomeTone> = { shipped: "ok", closed: "none", live: "live", waiting: "person", stuck: "warn", failed: "bad", calm: "none" };
const short = (hash: string) => hash.slice(0, 6);
const timeWords = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** A stretch of time in words: "Oct 3 to Oct 7", or "Oct 7, 09:10 to 11:40" within one day. */
const spanWords = (from: number, to: number) => (dayWords(from) === dayWords(to) ? `${dayWords(from)}, ${timeWords(from)} to ${timeWords(to)}` : `${dayWords(from)} to ${dayWords(to)}`);

/** The run the notebook traces: the selected run, else its case's newest. */
function tracedRun(model: LineModel, run: string | null, caseId: string | null): LineRunModel | null {
  if (run) return model.runs.find((r) => r.id === run) ?? null;
  if (caseId) return model.runs.find((r) => r.caseId === caseId) ?? null;
  return null;
}

/** A run's path through the steps a person reads: "Investigate › Propose › Card". */
function pathWords(run: LineRunModel, main: ReadonlySet<string>): string {
  const out: string[] = [];
  for (const v of run.visits) if (main.has(v.node) && out[out.length - 1] !== v.label) out.push(v.label);
  return out.join(" › ");
}

export function NotebookView({ model, workspace, selection, select }: LineViewProps) {
  const nav = useLineNav();
  const outline = useMemo(() => notebookOutline(model), [model]);
  const main = useMemo(() => new Set(outline.main), [outline]);
  const stepId = selection.step && model.steps[selection.step] && model.steps[selection.step].kind !== "end" ? selection.step : outline.main[0] ?? null;
  const step = stepId ? model.steps[stepId] : null;
  const run = useMemo(() => tracedRun(model, selection.run, selection.case), [model, selection.run, selection.case]);
  const walked = useMemo(() => new Set(run?.visits.map((v) => v.node) ?? []), [run]);

  const [ui, setUi] = useState<Record<string, StepUi>>({});
  // Unsaved edits are the window's, shared with the drawer and Replay (stepDrafts).
  const drafts = useStepDrafts();
  const [openSegs, setOpenSegs] = useState<ReadonlySet<string>>(() => new Set());
  const [allScripts, setAllScripts] = useState(false);
  const patchUi = (id: string, p: StepUi) => setUi((m) => ({ ...m, [id]: { ...m[id], ...p } }));

  const open = (id: string) => {
    const owner = outline.ownerOf[id];
    if (owner && !openSegs.has(owner)) setOpenSegs((s) => new Set(s).add(owner));
    select({ step: id });
  };
  const toggleSeg = (key: string) => setOpenSegs((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  // j / k and the up and down arrows walk the steps a person reads.
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      const dir = e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
      if (!dir) return;
      const at = stepId ? outline.main.indexOf(stepId) : -1;
      const to = outline.main[Math.max(0, Math.min(outline.main.length - 1, at < 0 ? 0 : at + dir))];
      if (to && to !== stepId) { e.preventDefault(); select({ step: to }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [outline, stepId, select]);

  const paneRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => { paneRef.current?.scrollTo({ top: 0 }); }, [stepId]);

  const draftCount = Object.keys(drafts).length;

  return (
    <div className="lw-nb" data-line-view="notebook">
      <div className="nb-bar">
        <div className="nb-legend" aria-hidden>
          <span><i className="nb-kd" data-kind="agent" />agent: one prompt</span>
          <span><i className="nb-kd" data-kind="person" />person</span>
          <span><i className="nb-kd" data-kind="script" />script: code</span>
        </div>
        <span className="lw-spacer" />
        <RunPicker model={model} main={main} run={run} onPick={(r) => select({ run: r?.id ?? null, ...(r ? {} : { case: null }) }, r?.caseId ?? null)} />
        <ChangesTray
          model={model}
          drafts={drafts}
          count={draftCount}
          onOpen={(id, tab) => { patchUi(id, { tab, editing: tab === "prompt" && id in drafts ? true : undefined, showDiff: id in drafts }); open(id); }}
          onDrop={(id) => setStepDraft(id, null)}
        />
      </div>

      <aside className="nb-left" aria-label="The line's steps">
        <div className="nb-outline-scroll">
          {/* The loop starts before the line (learning-loop.md LL1): how problems are found, then the line's steps. */}
          <FindBand loop={workspace.loop} projectId={nav.projectId ?? workspace.project?._id ?? null} product={workspace.product} layout="rail" />
          <Outline model={model} outline={outline} selected={stepId} walked={walked} run={run} openSegs={openSegs} all={allScripts} onOpen={open} onSeg={toggleSeg} />
        </div>
        {outline.scripts > 0 && (
          <div className="nb-left-foot">
            <button type="button" className="lw-link" onClick={() => setAllScripts((v) => !v)} aria-pressed={allScripts}>
              {allScripts ? "Fold the scripts" : `Show all ${outline.scripts} scripts`}
            </button>
          </div>
        )}
      </aside>

      <main className="nb-pane" ref={paneRef}>
        {step ? (
          <StepPage
            key={step.id}
            model={model}
            outline={outline}
            step={step}
            run={run}
            ui={ui[step.id] ?? {}}
            patch={(p) => patchUi(step.id, p)}
            draft={drafts[step.id] ?? null}
            setDraft={(text) => setStepDraft(step.id, text == null || text === step.prompt?.text ? null : text)}
            onOpen={open}
          />
        ) : (
          <div className="lw-empty"><b>No steps to read</b>This graph names no steps yet.</div>
        )}
      </main>
    </div>
  );
}

// ── the outline ──────────────────────────────────────────────────────────────

const SPINE_X = 46;

/** Whether the traced run passed a point on the spine: a step it visited, a folded segment holding one, or the start. */
function pointWalked(p: OutlineRow, walked: ReadonlySet<string>, tracing: boolean): boolean {
  if (p.t === "node" || p.t === "script") return walked.has(p.id);
  if (p.t === "seg") return p.ids.some((id) => walked.has(id));
  return p.t === "cap" && !p.end && tracing;
}

type OutlineProps = {
  model: LineModel;
  outline: NotebookOutline;
  selected: string | null;
  walked: ReadonlySet<string>;
  run: LineRunModel | null;
  openSegs: ReadonlySet<string>;
  all: boolean;
  onOpen: (id: string) => void;
  onSeg: (key: string) => void;
};

const Outline = memo(function Outline({ model, outline, selected, walked, run, openSegs, all, onOpen, onSeg }: OutlineProps) {
  const ends = useMemo(() => ({ start: "A problem comes in", end: model.graph.nodes.some((n) => n.end === "shipped") ? "Shipped, then watched" : "Done" }), [model]);
  const { rows, loops, height } = useMemo(() => outlineLayout(model, outline, openSegs, all, ends), [model, outline, openSegs, all, ends]);
  const order = useMemo(() => {
    if (!run) return new Map<string, number[]>();
    const m = new Map<string, number[]>();
    run.visits.forEach((v) => m.set(v.node, [...(m.get(v.node) ?? []), v.index]));
    return m;
  }, [run]);
  const lastAt = (id: string) => { const l = order.get(id); return l ? l[l.length - 1] : -1; };
  const firstAt = (id: string) => order.get(id)?.[0] ?? -1;

  const spine: ReactNode[] = [];
  const points = rows.filter((r) => r.t !== "half");
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const aw = pointWalked(a, walked, !!run);
    const bw = pointWalked(b, walked, !!run);
    spine.push(<line key={`s${i}`} className="nb-spine" data-walked={aw && bw ? "" : undefined} x1={SPINE_X} y1={a.y} x2={SPINE_X} y2={b.y} />);
  }

  return (
    <div className="nb-outline" style={{ height }}>
      <svg width="100%" height={height} aria-hidden>
        <defs>
          <marker id="nb-ah" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L6 3 L0 6 z" className="nb-ah" /></marker>
          <marker id="nb-ah-on" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L6 3 L0 6 z" className="nb-ah" data-on="" /></marker>
        </defs>
        {spine}
        {loops.map((l) => {
          const on = selected === l.from || selected === l.to;
          const took = !!run && walked.has(l.from) && walked.has(l.to) && lastAt(l.to) > firstAt(l.from);
          const dx = 20 + l.lane * 11;
          const d = l.from === l.to
            ? `M${SPINE_X - 9} ${l.toY - 6} C ${SPINE_X - 30} ${l.toY - 22}, ${SPINE_X - 30} ${l.toY + 22}, ${SPINE_X - 9} ${l.toY + 6}`
            : `M${SPINE_X - 8} ${l.fromY} C ${SPINE_X - dx - 10} ${l.fromY}, ${SPINE_X - dx - 10} ${l.toY}, ${SPINE_X - 9} ${l.toY}`;
          return (
            <path key={`${l.from}>${l.to}`} className="nb-loop" data-on={on ? "" : undefined} data-walked={took ? "" : undefined} d={d} markerEnd={`url(#nb-ah${on ? "-on" : ""})`}>
              <title>{`${model.steps[l.from]?.label} back to ${model.steps[l.to]?.label}${l.words.length ? `: ${l.words.join(", ")}` : ""}`}</title>
            </path>
          );
        })}
      </svg>
      {rows.map((r) => {
        if (r.t === "half") return <div key={`h${r.y}`} className="nb-half" style={{ top: r.y - 9 }}>{r.label}</div>;
        if (r.t === "cap") return <div key={`c${r.y}`} className="nb-cap" data-end={r.end ? "" : undefined} style={{ top: r.y - 9 }}><i />{r.label}</div>;
        if (r.t === "seg") {
          const names = r.ids.map((id) => model.steps[id]?.label ?? id);
          return (
            <button key={`g${r.key}`} type="button" className="nb-seg" style={{ top: r.y - 10 }} onClick={() => onSeg(r.key)} title={`Scripts: ${names.join(", ")}`} data-walked={r.ids.some((id) => walked.has(id)) ? "" : undefined}>
              <i />
              <span>{names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ")}</span>
            </button>
          );
        }
        if (r.t === "script") {
          const s = model.steps[r.id];
          return (
            <div key={`x${r.id}`} className="nb-script-row" style={{ top: r.y - 11 }}>
              <button type="button" className="nb-script" data-selected={selected === r.id ? "" : undefined} data-walked={walked.has(r.id) ? "" : undefined} onClick={() => onOpen(r.id)} data-line-outline-step={r.id}>
                <i /><span>{s?.label ?? r.id}</span>
              </button>
              {!all && r.first && <button type="button" className="nb-fold" onClick={() => onSeg(r.seg)}>fold</button>}
            </div>
          );
        }
        const s = model.steps[r.id];
        const node = model.graph.nodes.find((n) => n.id === r.id);
        const n = s.decisions.length;
        const ver = s.prompt?.version;
        const visits = order.get(r.id);
        return (
          <button
            key={`n${r.id}`}
            type="button"
            className="nb-node"
            data-kind={s.kind}
            data-selected={selected === r.id ? "" : undefined}
            data-walked={walked.has(r.id) ? "" : undefined}
            aria-current={selected === r.id ? "step" : undefined}
            style={{ top: r.y - 21 }}
            onClick={() => onOpen(r.id)}
            data-line-outline-step={r.id}
          >
            <span className="nb-glyph" />
            <span className="nb-nm">
              {s.label}
              {ver?.earlier && <sup title={`Changed ${dayWords(ver.since)}`}>new text</sup>}
            </span>
            <span className="nb-sub">
              {s.kind === "person" ? "person" : s.model ?? "agent"}
              {n > 0 && ` · ${n} decided`}
              {failureWords(s.tally) && <em data-cut={s.tally.failed ? undefined : ""}> · {failureWords(s.tally)}</em>}
            </span>
            {visits && <span className="nb-visits" title="Where this step fell in the traced run">{visits.map((i) => i + 1).join(", ")}</span>}
          </button>
        );
      })}
    </div>
  );
});

// ── the traced run ───────────────────────────────────────────────────────────

function RunPicker({ model, main, run, onPick }: { model: LineModel; main: ReadonlySet<string>; run: LineRunModel | null; onPick: (r: LineRunModel | null) => void }) {
  const { open, setOpen, ref } = usePopover();
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    if (!open) return [];
    const needle = q.trim().toLowerCase();
    const by = new Map<string, { title: string; ref: string | null; runs: LineRunModel[] }>();
    for (const r of model.runs) {
      if (needle && !`${r.caseTitle} ${r.caseRef ?? ""}`.toLowerCase().includes(needle)) continue;
      const k = r.caseId ?? r.id;
      const g = by.get(k) ?? { title: r.caseTitle, ref: r.caseRef, runs: [] };
      g.runs.push(r);
      by.set(k, g);
    }
    return [...by.values()].slice(0, 40);
  }, [open, q, model.runs]);
  if (!model.runs.length) return null;
  return (
    <div className="lw-pop-host" ref={ref}>
      <button type="button" className="nb-tracing" aria-expanded={open} onClick={() => setOpen(!open)} data-line-tracing={run?.id ?? ""} title="Light the path one run took">
        <span className="nb-tracing-l">{run ? "Tracing" : "Trace a run"}</span>
        {run && <span className="nb-tracing-t">{run.caseTitle}</span>}
        {run && <span className="lw-oc" data-tone={RUN_TONE[run.outcome.tone]}>{run.outcome.text}</span>}
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {run && (
        <button type="button" className="lw-iconbtn nb-untrace" onClick={() => onPick(null)} aria-label="Stop tracing" title="Stop tracing"><X className="w-3.5 h-3.5" /></button>
      )}
      {open && (
        <div className="lw-pop nb-runmenu" role="dialog" aria-label="Pick a run to trace">
          <label className="nb-search">
            <Search className="w-3.5 h-3.5" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a case" aria-label="Find a case" />
          </label>
          <div className="lw-pop-scroll">
            {groups.length === 0 && <div className="lw-pop-empty">No case matches.</div>}
            {groups.map((g) => (
              <div key={g.runs[0].id}>
                <h6>{g.ref && <span>{g.ref}</span>}{g.title}</h6>
                {g.runs.slice(0, 6).map((r) => (
                  <button key={r.id} type="button" aria-current={run?.id === r.id ? "true" : undefined} onClick={() => { onPick(r); setOpen(false); }}>
                    <span className="nb-runpath">{pathWords(r, main) || "Stopped before the first step"}</span>
                    <span className="nb-runwhen">{dayWords(r.at)}</span>
                    <span className="lw-oc" data-tone={RUN_TONE[r.outcome.tone]}>{r.outcome.text}</span>
                  </button>
                ))}
                {g.runs.length > 6 && <div className="lw-pop-more">{g.runs.length - 6} earlier runs of this case</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── the line's changes ───────────────────────────────────────────────────────

type ChangesProps = {
  model: LineModel;
  drafts: Readonly<Record<string, string>>;
  count: number;
  onOpen: (id: string, tab: Tab) => void;
  onDrop: (id: string) => void;
};

function ChangesTray({ model, drafts, count, onOpen, onDrop }: ChangesProps) {
  const { open, setOpen, ref } = usePopover();
  const steps = useMemo(() => model.order.map((id) => model.steps[id]).filter((s) => s.prompt && s.prompt.versions.length > 0 && s.kind !== "script"), [model]);
  const changed = steps.filter((s) => s.prompt!.versions.length > 1).sort((a, b) => b.prompt!.versions[0].since - a.prompt!.versions[0].since);
  const still = steps.length - changed.length;
  return (
    <div className="lw-pop-host" ref={ref}>
      <button type="button" className="lw-act" data-primary="" aria-expanded={open} onClick={() => setOpen(!open)} data-line-changes={count}>
        Changes
        {count > 0 && <span className="nb-badge">{count}</span>}
      </button>
      {open && (
        <div className="lw-pop nb-changes" role="dialog" aria-label="This line's changes">
          <div className="lw-pop-scroll">
            <h5>Not saved</h5>
            {count === 0 ? <div className="lw-pop-empty">No edits in progress.</div> : Object.entries(drafts).map(([id, text]) => {
              const s = model.steps[id];
              if (!s?.prompt) return null;
              const d = promptDiff(s.prompt.text, text);
              return (
                <div key={id} className="nb-chg">
                  <div className="nb-chg-l1"><b>{s.label}</b><span className="lw-stat-add">+{d.added}</span><span className="lw-stat-del">−{d.removed}</span><span className="lw-spacer" /><span className="nb-chg-st">draft</span></div>
                  <div className="nb-chg-l2">{s.prompt.file ?? "prompt"}</div>
                  <div className="nb-chg-acts">
                    <button type="button" className="lw-act" onClick={() => { onOpen(id, "prompt"); setOpen(false); }}>Open</button>
                    <button type="button" className="lw-link" onClick={() => onDrop(id)}>Discard</button>
                  </div>
                </div>
              );
            })}
            <h5>Prompt texts the runs read</h5>
            {changed.length === 0 && <div className="lw-pop-empty">{steps.length ? `Every run read the same text on all ${steps.length} steps.` : "The runs recorded no prompt texts."}</div>}
            {changed.map((s) => (
              <button key={s.id} type="button" className="nb-chg nb-chg-btn" onClick={() => { onOpen(s.id, "prompt"); setOpen(false); }}>
                <div className="nb-chg-l1"><b>{s.label}</b><span className="lw-spacer" /><span className="nb-chg-st" data-now="">{s.prompt!.versions.length} texts</span></div>
                <ol className="nb-vers">
                  {s.prompt!.versions.slice(0, 4).map((v, i) => (
                    <li key={`${v.hash}:${v.since}`} data-now={i === 0 ? "" : undefined}>
                      <span className="lw-ver" data-new={i === 0 ? "" : undefined}>{short(v.hash)}</span>
                      <span>{i === 0 ? `since ${dayWords(v.since)}` : spanWords(v.since, v.until)}</span>
                      <span className="nb-vers-n">{v.runs} {v.runs === 1 ? "run" : "runs"}</span>
                    </li>
                  ))}
                </ol>
              </button>
            ))}
            {changed.length > 0 && still > 0 && <div className="lw-pop-more">{still} other {still === 1 ? "step" : "steps"} ran one text throughout.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── one step, as a page ──────────────────────────────────────────────────────

const KIND_LINE = { agent: "Agent", person: "Person", script: "Script", end: "End" } as const;

type StepPageProps = {
  model: LineModel;
  outline: NotebookOutline;
  step: LineStep;
  run: LineRunModel | null;
  ui: StepUi;
  patch: (p: StepUi) => void;
  draft: string | null;
  setDraft: (text: string | null) => void;
  onOpen: (id: string) => void;
};

function StepPage({ model, outline, step: s, run, ui, patch, draft, setDraft, onOpen }: StepPageProps) {
  const node = model.graph.nodes.find((n) => n.id === s.id);
  const inRun = !!run && s.decisions.some((d) => d.runId === run.id);
  // The drawer's tabs, words and order (stepTabs); a script reads as one page here, without tabs.
  const tabs = s.kind === "agent" || s.kind === "person" ? stepTabs(s) : [];
  const tab: Tab = ui.tab && tabs.some((t) => t.key === ui.tab) ? ui.tab : "decisions";
  const flows = outline.flows[s.id];
  const typical = durationWords(node?.medianMs);
  const ver = s.prompt?.version;

  return (
    <section className="nb-page" data-kind={s.kind} data-line-notebook-step={s.id}>
      <header className="nb-head">
        <div className="nb-k" data-kind={s.kind}>
          <i />
          {KIND_LINE[s.kind]}{s.kind === "agent" && s.model ? ` · ${s.model}` : ""}
          <span className="nb-k-meta">
            {model.graph.halves.find((h) => h.key === s.half)?.label}
            {node && node.runs > 0 && ` · ${node.runs} of ${model.runs.length} runs reach it`}
            {typical && ` · typically ${typical}`}
          </span>
        </div>
        <h2>
          {s.label}
          {ver?.earlier && <span className="lw-ver" data-new="" title={`${ver.runs} ${ver.runs === 1 ? "run has" : "runs have"} read the new text`}>edited {dayWords(ver.since)}</span>}
          {draft != null && <span className="nb-drafted">edited</span>}
        </h2>
        <p className="nb-job">{s.purpose}</p>
        {flows ? <Flows flows={flows} onOpen={onOpen} /> : <ScriptFlows step={s} onOpen={onOpen} />}
      </header>

      {tabs.length > 0 && (
        <nav className="nb-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => patch({ tab: t.key })} data-line-notebook-tab={t.key}>
              {t.label}
              {t.count != null && <span>{t.count}</span>}
            </button>
          ))}
        </nav>
      )}

      <div className="nb-tabbody" key={tab}>
        {s.kind === "script" ? (
          <ScriptBody model={model} step={s} run={run} ui={ui} patch={patch} />
        ) : tab === "decisions" ? (
          <>
            {s.kind === "person" && s.answers.length > 0 && <Answers step={s} />}
            {s.kind === "agent" && s.decisions.length > 0 && (
              <p className="nb-hint">
                Mark wrong the decisions it got wrong
                {s.decisions.some((d) => d.label?.verdict === "wrong") && <b> ({s.decisions.filter((d) => d.label?.verdict === "wrong").length} marked)</b>}
                , then <button type="button" className="lw-link" onClick={() => patch({ tab: "ask" })}>ask an agent</button> to improve the step
              </p>
            )}
            {s.kind === "person" && <h4 className="nb-subhead">{s.decisions.length ? "Rulings" : ""}</h4>}
            <Decisions step={s} run={run} ui={ui} patch={patch} labels={s.kind === "agent"} inRun={inRun} />
          </>
        ) : tab === "prompt" ? (
          <PromptPage model={model} step={s} ui={ui} patch={patch} draft={draft} setDraft={setDraft} />
        ) : tab === "try" && LINE_ACTIONS.Try ? (
          <LINE_ACTIONS.Try model={model} step={s} draft={draft} />
        ) : (
          <Improve model={model} step={s} draft={draft} onDecision={(d) => patch({ tab: "decisions", open: d.id })} />
        )}
      </div>
    </section>
  );
}

function FlowChip({ kind, words, to, toLabel, count, does, onOpen, ends }: OutlineFlow & { onOpen: (id: string) => void; ends?: boolean }) {
  return (
    <span className="nb-fl" data-kind={kind} title={does ?? undefined}>
      {words && <span className="nb-fl-o">{words}</span>}
      <span className="nb-fl-ar" aria-hidden>{kind === "loop" ? "↺" : "→"}</span>
      {ends || kind === "end" ? <span className="nb-fl-t">{toLabel}</span> : <button type="button" onClick={() => onOpen(to)}>{toLabel}</button>}
      {count > 0 && <span className="nb-fl-n">{count}×</span>}
    </span>
  );
}

function Flows({ flows, onOpen }: { flows: OutlineFlow[]; onOpen: (id: string) => void }) {
  if (!flows.length) return null;
  return <div className="nb-flows" aria-label="Sends work to">{flows.map((f) => <FlowChip key={`${f.kind}${f.to}${f.words}`} {...f} onOpen={onOpen} />)}</div>;
}

/** A script's own ways out, one hop each. */
function ScriptFlows({ step, onOpen }: { step: LineStep; onOpen: (id: string) => void }) {
  if (!step.outcomes.length) return null;
  return (
    <div className="nb-flows" aria-label="Sends work to">
      {step.outcomes.map((o, i) => (
        <FlowChip key={`${o.key}#${i}`} kind={o.kind === "loop" ? "loop" : "next"} to={o.to} toLabel={o.toLabel} words={o.words === "next" ? null : o.words} does={o.does} count={o.count} onOpen={onOpen} ends={step.kind === "end"} />
      ))}
    </div>
  );
}

function Answers({ step }: { step: LineStep }) {
  return (
    <div className="nb-opts">
      {step.answers.map((a, i) => {
        const to = step.outcomes.find((o) => o.words === a.answer);
        return (
          <div key={a.answer} className="nb-opt">
            <div className="nb-opt-h"><KeyCap>{String.fromCharCode(65 + i)}</KeyCap><b>{a.answer}</b>{to && to.count > 0 && <span className="nb-fl-n">{to.count}×</span>}</div>
            {a.does && <p>{a.does}</p>}
            {to && <div className="nb-opt-then">→ {to.toLabel}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ── decisions, one row each ──────────────────────────────────────────────────

function Decisions({ step, run, ui, patch, labels, inRun }: { step: LineStep; run: LineRunModel | null; ui: StepUi; patch: (p: StepUi) => void; labels: boolean; inRun: boolean }) {
  const openId = ui.open !== undefined ? ui.open : inRun && run ? step.decisions.find((d) => d.runId === run.id)?.id ?? null : null;
  const limit = ui.limit ?? PAGE;
  // One toggle for every row, reading the open row as it is now: the memoized rows keep their props while nothing they draw moved.
  const live = useRef({ openId, patch });
  live.current = { openId, patch };
  const toggle = useRef((id: string) => live.current.patch({ open: live.current.openId === id ? null : id })).current;
  if (!step.decisions.length) {
    return <div className="lw-empty" data-line-decisions-empty><b>No decisions yet</b>No run has reached {step.label} on this graph.</div>;
  }
  const cases = decisionsByCase(step.decisions);
  const shown = cases.slice(0, limit);
  const row = (d: StepDecision) => <DecisionRow key={d.id} d={d} step={step} open={openId === d.id} traced={!!run && d.runId === run.id} labels={labels} onToggle={toggle} />;
  return (
    <>
      <div className="nb-dlist" data-line-widget="decisions">
        {shown.map((c) => (
          <Fragment key={c.key}>
            {row(c.latest)}
            {c.earlier.length > 0 && <EarlierRuns c={c} row={row} traced={!!run && c.earlier.some((d) => d.runId === run.id)} />}
          </Fragment>
        ))}
      </div>
      {cases.length > shown.length && (
        <button type="button" className="nb-more" onClick={() => patch({ limit: limit + PAGE })}>
          Show {Math.min(PAGE, cases.length - shown.length)} more of {cases.length - shown.length} older cases
        </button>
      )}
    </>
  );
}

/** A case's earlier runs at this step, folded under its newest: "and 2 earlier runs". */
function EarlierRuns({ c, row, traced }: { c: CaseDecisions; row: (d: StepDecision) => ReactNode; traced: boolean }) {
  const [open, setOpen] = useState(traced);
  return (
    <div className="nb-earlier" data-open={open ? "" : undefined}>
      <button type="button" className="nb-earlier-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "and"} {c.earlier.length} earlier {c.earlier.length === 1 ? "run" : "runs"}{open ? "" : " on this case"}
      </button>
      {open && <div className="nb-earlier-rows">{c.earlier.map(row)}</div>}
    </div>
  );
}

const DecisionRow = memo(function DecisionRow({ d, step, open, traced, labels, onToggle }: { d: StepDecision; step: LineStep; open: boolean; traced: boolean; labels: boolean; onToggle: (id: string) => void }) {
  const nav = useLineNav();
  const mine = d.labels.find((l) => l.mine)?.verdict ?? null;
  const shown = d.label;
  const verdict = mine ?? shown?.verdict ?? null;
  const took = durationWords(d.durationMs);
  const label = (v: "right" | "wrong") => (e: React.MouseEvent) => {
    e.stopPropagation();
    useInboxStore.getState().labelDecision(d.runId, step.id, mine === v ? null : v);
  };
  return (
    <div className="nb-dr" data-open={open ? "" : undefined} data-verdict={verdict ?? undefined} data-line-decision={d.id}>
      <div className="nb-dh" role="button" tabIndex={0} aria-expanded={open} onClick={() => onToggle(d.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(d.id); } }}>
        <DecisionTag d={d} />
        <span className="nb-it">{d.caseTitle}</span>
        {traced && <span className="nb-inrun" title="The run you are tracing">traced run</span>}
        {shown && !shown.mine && <span className="lw-labelmark" data-verdict={shown.verdict} title={shown.note ?? undefined}>{shown.verdict === "right" ? "Right" : "Wrong"}{shown.byName ? `, says ${shown.byName}` : ""}</span>}
        <span className="nb-when">{dayWords(d.at)}</span>
        {labels && decisionKey(d) !== "cut off" && (
          <span className="nb-lb" role="group" aria-label="Was this decision right?">
            <button type="button" className="nb-lab" data-v="right" aria-pressed={mine === "right"} onClick={label("right")} title="Mark right" aria-label="Mark right" data-line-label="right"><Check className="w-3 h-3" /></button>
            <button type="button" className="nb-lab" data-v="wrong" aria-pressed={mine === "wrong"} onClick={label("wrong")} data-text="" data-line-label="wrong">{mine === "wrong" ? "Marked wrong" : "Mark wrong"}</button>
          </span>
        )}
      </div>
      {open && (
        <div className="nb-db">
          <p className="nb-sum">{decisionSaid(d)}</p>
          {d.received.from && (
            <div className="nb-quote"><span>What it was handed</span><p>{d.received.summary}</p></div>
          )}
          <ResultFields result={d.decided.result} />
          {d.reasoning && d.reasoning !== d.decided.words && (
            <details className="nb-why">
              <summary>Its reasoning, in its own words</summary>
              <p className="lw-reason">{d.reasoning}</p>
            </details>
          )}
          {d.labels.filter((l) => l.note).map((l) => (
            <div key={`${l.by}:${l.at}`} className="nb-note" data-verdict={l.verdict}><b>{l.mine ? "Your note" : `${l.byName ?? "A teammate"}'s note`}</b>{l.note}</div>
          ))}
          <div className="nb-dfoot">
            <span>{[d.caseRef, took && `took ${took}`, d.decided.toLabel && `then ${d.decided.toLabel}${d.decided.toWords ? ` (${d.decided.toWords})` : ""}`].filter(Boolean).join(" · ")}</span>
            <span className="lw-spacer" />
            {d.received.href && <a href={d.received.href} className="lw-link">Its session</a>}
            <NavLink className="lw-act" href={nav.runHref(d.runId, d.caseId)} onOpen={() => nav.openRun(d.runId, d.caseId)}>Replay the run</NavLink>
          </div>
        </div>
      )}
    </div>
  );
});

// ── the prompt, as a document ────────────────────────────────────────────────

function PromptPage({ model, step: s, ui, patch, draft, setDraft }: { model: LineModel; step: LineStep; ui: StepUi; patch: (p: StepUi) => void; draft: string | null; setDraft: (t: string | null) => void }) {
  const diff = useMemo(() => (s.prompt && draft != null ? promptDiff(s.prompt.text, draft) : null), [s.prompt, draft]);
  if (!s.prompt) return <div className="lw-empty"><b>No text recorded</b>The graph names this step without its {s.kind === "person" ? "card" : "prompt"}.</div>;
  const editing = !!ui.editing;
  const ver = s.prompt.version;
  return (
    <div data-line-notebook-prompt>
      <div className="nb-ptool">
        {s.prompt.file && <span className="lw-file">{s.prompt.file}</span>}
        {ver && <span className="nb-ptool-v">{ver.runs} {ver.runs === 1 ? "run" : "runs"} on this text{ver.earlier ? ` since ${dayWords(ver.since)}` : ""}</span>}
        {diff && <><span className="lw-stat-add">+{diff.added}</span><span className="lw-stat-del">−{diff.removed}</span></>}
        <span className="lw-spacer" />
        {diff && (
          <>
            <button type="button" className="lw-link" aria-pressed={!!ui.showDiff} onClick={() => patch({ showDiff: !ui.showDiff })}>{ui.showDiff ? "Hide the change" : "Show the change"}</button>
            <button type="button" className="lw-link" onClick={() => { setDraft(null); patch({ editing: false, showDiff: false }); }}>Discard</button>
            {LINE_ACTIONS.Try && <button type="button" className="lw-link" onClick={() => patch({ tab: "try" })}>Try it</button>}
            {LINE_ACTIONS.Save && <LINE_ACTIONS.Save model={model} step={s} draft={draft!} />}
          </>
        )}
        <div className="lw-seg" role="group" aria-label="Read or edit">
          <button type="button" aria-pressed={!editing} onClick={() => patch({ editing: false })}>Read</button>
          <button type="button" aria-pressed={editing} onClick={() => patch({ editing: true })} data-line-notebook-edit>Edit</button>
        </div>
      </div>
      {diff && ui.showDiff && <div className="nb-diffbox"><PromptDiffLines before={s.prompt.text} after={draft!} /></div>}
      <div className={editing ? undefined : "nb-sheet"}>
        <PromptView prompt={s.prompt} nodes={model.graph.nodes} text={draft} changed={diff?.changedAfter ?? null} layout="flat" editing={editing} onEdit={(t) => setDraft(t)} />
      </div>
      {LINE_ACTIONS.Versions && <LINE_ACTIONS.Versions model={model} step={s} />}
    </div>
  );
}

// ── improve it with an agent ─────────────────────────────────────────────────

function Improve({ model, step: s, draft, onDecision }: { model: LineModel; step: LineStep; draft: string | null; onDecision: (d: StepDecision) => void }) {
  const Ask = LINE_ACTIONS.Ask;
  const wrong = s.decisions.filter((d) => d.label?.verdict === "wrong");
  const right = s.decisions.filter((d) => d.label?.verdict === "right");
  const Row = ({ d }: { d: StepDecision }) => (
    <button type="button" className="nb-ex" data-verdict={d.label?.verdict} onClick={() => onDecision(d)}>
      <DecisionTag d={d} />
      <span className="nb-it">{d.caseTitle}</span>
      {d.label?.note && <span className="nb-ex-note">{d.label.note}</span>}
      <span className="nb-when">{dayWords(d.at)}</span>
    </button>
  );
  return (
    <div className="nb-improve">
      {Ask && <Ask model={model} step={s} draft={draft} />}
      <h4 className="nb-subhead">Marked wrong<span>{wrong.length}</span></h4>
      {wrong.length ? <div className="nb-dlist">{wrong.map((d) => <Row key={d.id} d={d} />)}</div>
        : <p className="nb-hint">None yet. Mark the decisions this step got wrong with ✕ on Decisions; they are the cases a change has to fix.</p>}
      <h4 className="nb-subhead">Marked right<span>{right.length}</span></h4>
      {right.length ? <div className="nb-dlist">{right.map((d) => <Row key={d.id} d={d} />)}</div>
        : <p className="nb-hint">None yet. A decision marked right is a case a change must not break.</p>}
    </div>
  );
}

// ── a script ─────────────────────────────────────────────────────────────────

function ScriptBody({ model, step: s, run, ui, patch }: { model: LineModel; step: LineStep; run: LineRunModel | null; ui: StepUi; patch: (p: StepUi) => void }) {
  const node = model.graph.nodes.find((n) => n.id === s.id);
  const typical = durationWords(node?.medianMs);
  return (
    <>
      <h4 className="nb-subhead">Runs</h4>
      {s.prompt ? <pre className="lw-cmd">{s.prompt.text}</pre> : <pre className="lw-cmd">built into the engine</pre>}
      {node && (
        <div className="nb-stat3">
          <div><b>{node.runs}</b>of {model.runs.length} runs reached it</div>
          <div><b>{node.failed}</b>failed</div>
          {node.cutOff > 0 && <div><b>{node.cutOff}</b>cut off</div>}
          {typical && <div><b>{typical}</b>typically</div>}
        </div>
      )}
      <h4 className="nb-subhead">What it printed</h4>
      <Decisions step={s} run={run} ui={ui} patch={patch} labels={false} inRun={!!run && s.decisions.some((d) => d.runId === run.id)} />
    </>
  );
}

