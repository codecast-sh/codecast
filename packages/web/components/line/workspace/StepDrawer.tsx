"use client";
// The step drawer every view opens (line-workspace.md LW1), ported from
// Studio's step workspace: who does the step and how often runs reach it, its
// name and version, its job in one line, where it sends work (each route a
// step away), then tabs. An agent reads Prompt and Decisions, plus Try and Ask
// an agent when the actions fill those slots; a person's gate reads its
// question and its answers; a script its command and its runs. An unsaved
// edit is kept per step for the window (stepDrafts), so moving between steps
// and views never loses it, and a view can re-run a case with it.
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { LineModel, LineStep } from "../../../lib/line/lineModel";
import type { LineSelection, LineSelectionPatch } from "../../../lib/line/lineWorkspaceUrl";
import { promptDiff } from "../../../lib/line/promptText";
import { KeyCap } from "../../KeyCap";
import { DecisionList, KindTag, LINE_ACTIONS, PromptDiffLines, PromptView, dayWords, durationWords } from "../widgets";
import { setStepDraft, useDrawerRequest, useStepDrafts, type DrawerTab } from "./stepDrafts";

type Tab = DrawerTab;

const HALF_WORDS = { diagnose: "Diagnose", fix: "Fix" } as const;

/** The tabs a step's kind has, in order, with their words. */
function tabsOf(step: LineStep): Array<{ key: Tab; label: string; count?: number; tone?: "person" }> {
  const n = step.decisions.length;
  if (step.kind === "agent") {
    return [
      { key: "prompt" as const, label: "Prompt" },
      { key: "decisions" as const, label: "Decisions", count: n },
      ...(LINE_ACTIONS.Try ? [{ key: "try" as const, label: "Try" }] : []),
      ...(LINE_ACTIONS.Ask ? [{ key: "ask" as const, label: "Ask an agent", tone: "person" as const }] : []),
    ];
  }
  if (step.kind === "person") return [{ key: "prompt", label: "Question" }, { key: "decisions", label: "Answers", count: n, tone: "person" }];
  if (step.kind === "script") return [{ key: "prompt", label: "Command" }, { key: "decisions", label: "Runs", count: n }];
  return [{ key: "decisions", label: "Runs", count: n }];
}

export type StepDrawerProps = {
  model: LineModel | null;
  selection: LineSelection;
  select: (patch: LineSelectionPatch, runCase?: string | null) => void;
};

export function StepDrawer({ model, selection, select }: StepDrawerProps) {
  const step = model && selection.step ? model.steps[selection.step] ?? null : null;
  // An unsaved edit is kept per step for the window (stepDrafts, which views read too); the tab last read, while the drawer lives.
  const drafts = useStepDrafts();
  const [tabs, setTabs] = useState<Record<string, Tab>>({});
  const [editing, setEditing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  // A view asked for a tab (Replay's Edit and Ask an agent): take it once.
  const ask = useDrawerRequest();
  const [took, setTook] = useState(ask?.n ?? 0);
  if (ask && ask.n !== took) {
    setTook(ask.n);
    setTabs((m) => ({ ...m, [ask.step]: ask.tab }));
    setEditing(ask.edit);
  }

  // The step stays drawn while the drawer slides out.
  const [shown, setShown] = useState<LineStep | null>(step);
  if (step && step !== shown) setShown(step);
  const s = step ?? shown;
  const open = !!step;

  const idx = model && s ? model.order.indexOf(s.id) : -1;
  const prev = model && idx > 0 ? model.order[idx - 1] : null;
  const next = model && idx >= 0 && idx < model.order.length - 1 ? model.order[idx + 1] : null;
  const node = model && s ? model.graph.nodes.find((n) => n.id === s.id) ?? null : null;

  const draft = s ? drafts[s.id] ?? null : null;
  const dirty = !!s?.prompt && draft != null && draft !== s.prompt.text;
  const diff = useMemo(() => (dirty && s?.prompt ? promptDiff(s.prompt.text, draft!) : null), [dirty, s, draft]);

  if (!model || !s) return <aside className="lw-drawer" aria-hidden />;

  const kindTabs = tabsOf(s);
  // A run selected elsewhere opens on its decision here.
  const runHere = !!selection.run && s.decisions.some((d) => d.runId === selection.run);
  const wanted = tabs[s.id] ?? (runHere || !s.prompt ? "decisions" : "prompt");
  const tab = kindTabs.some((t) => t.key === wanted) ? wanted : kindTabs[0].key;
  const setTab = (t: Tab) => setTabs((m) => ({ ...m, [s.id]: t }));
  const setDraft = (text: string) => setStepDraft(s.id, text);
  const reset = () => {
    setStepDraft(s.id, null);
    setEditing(false);
    setShowDiff(false);
  };
  const go = (id: string | null) => { if (id) { setEditing(false); select({ step: id }); } };
  const reached = node ? `${node.runs} of ${model.runs.length} runs` : null;
  const typical = durationWords(node?.medianMs);
  const ver = s.prompt?.version;
  const Try = LINE_ACTIONS.Try;
  const Ask = LINE_ACTIONS.Ask;

  return (
    <aside className="lw-drawer" data-open={open ? "" : undefined} aria-hidden={!open} aria-label={`${s.label}, a step`} data-line-drawer={s.id}>
      <div className="lw-dh">
        <div className="lw-dh-top">
          <KindTag kind={s.kind}>{s.kind === "agent" ? `Agent${s.model ? ` · ${s.model}` : ""}` : undefined}</KindTag>
          <span>{HALF_WORDS[s.half]}</span>
          {node && node.runs > 0 && <span>· reached in {reached}{typical ? `, typically ${typical}` : ""}</span>}
          {node && node.failed > 0 && <span style={{ color: "var(--lw-bad)" }}>· {node.failed} failed</span>}
          <span className="lw-dh-nav">
            <button type="button" className="lw-iconbtn" onClick={() => go(prev)} disabled={!prev} aria-label="The step before" title={prev ? model.steps[prev]?.label : undefined}><ChevronLeft className="w-4 h-4" /></button>
            <button type="button" className="lw-iconbtn" onClick={() => go(next)} disabled={!next} aria-label="The step after" title={next ? model.steps[next]?.label : undefined}><ChevronRight className="w-4 h-4" /></button>
            <button type="button" className="lw-iconbtn" onClick={() => select({ step: null })} aria-label="Close the step" title="Close"><X className="w-4 h-4" /></button>
          </span>
        </div>
        <h2>
          {s.label}
          {ver && <span className="lw-ver" data-new={ver.earlier ? "" : undefined} title={ver.earlier ? `Changed ${dayWords(ver.since)}: ${ver.runs} ${ver.runs === 1 ? "run has" : "runs have"} read this text` : `Every run read this text`}>{ver.hash.slice(0, 6)}</span>}
          {s.fileLabel && <small>{s.fileLabel}</small>}
        </h2>
        <p className="lw-job">{s.purpose}</p>
        {s.outcomes.length > 0 && (
          <div className="lw-routes">
            <span className="lw-routes-lead">Sends work to</span>
            {s.outcomes.map((o, i) => (
              <button key={`${o.key}#${i}`} type="button" className="lw-route" data-kind={o.kind} data-gate={s.kind === "person" ? "" : undefined} onClick={() => go(o.to)} title={o.does ?? undefined}>
                {o.words !== "next" && <span className="lw-route-w">{o.words}</span>}
                <span className="lw-route-to">{o.kind === "loop" ? "↺" : "→"} {o.toLabel}</span>
                {o.count > 0 && <span className="lw-route-n">{o.count}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="lw-tabs" role="tablist">
          {kindTabs.map((t) => (
            <button key={t.key} type="button" role="tab" className="lw-tab" data-tone={t.tone} aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
              {t.count != null && <span className="lw-count">{t.count}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="lw-db" role="tabpanel" key={`${s.id}:${tab}`}>
        {tab === "prompt" && (
          <>
            {s.kind === "person" && s.answers.length > 0 && (
              <div className="lw-answers">
                {s.answers.map((a, i) => {
                  const to = s.outcomes.find((o) => o.words === a.answer)?.to;
                  const times = to ? s.decisions.filter((d) => d.decided.to === to).length : 0;
                  return (
                    <div key={a.answer} className="lw-answer">
                      <b><KeyCap>{String.fromCharCode(65 + i)}</KeyCap> {a.answer}</b>
                      <span>{a.does ?? ""}</span>
                      <span className="lw-route-n">{times ? `${times}×` : ""}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {s.prompt ? (
              <>
                {dirty && diff && (
                  <div className="lw-editbanner" data-line-prompt-dirty>
                    <span>Edited, not saved</span>
                    <span className="lw-plus-n">+{diff.added}</span>
                    <span className="lw-minus-n">−{diff.removed}</span>
                    <span className="lw-spacer" />
                    <button type="button" className="lw-act" aria-pressed={showDiff} onClick={() => setShowDiff((v) => !v)}>{showDiff ? "Hide the change" : "Show the change"}</button>
                    <button type="button" className="lw-act" onClick={reset}>Reset</button>
                    {Try && <button type="button" className="lw-act" onClick={() => setTab("try")}>Try it</button>}
                  </div>
                )}
                {dirty && showDiff && <div className="lw-obj" data-flat="" style={{ marginBottom: 14 }}><PromptDiffLines before={s.prompt.text} after={draft!} /></div>}
                <div className="lw-doctools">
                  {s.prompt.file && <span className="lw-file">{s.prompt.file}</span>}
                  <span className="lw-spacer" />
                  {s.kind !== "end" && (
                    <div className="lw-seg" role="group" aria-label="Read or edit">
                      <button type="button" aria-pressed={!editing} onClick={() => setEditing(false)}>Read</button>
                      <button type="button" aria-pressed={editing} onClick={() => setEditing(true)}>Edit</button>
                    </div>
                  )}
                </div>
                <PromptView
                  prompt={s.prompt}
                  nodes={model.graph.nodes}
                  text={draft}
                  changed={diff?.changedAfter ?? null}
                  editing={editing}
                  onEdit={setDraft}
                />
              </>
            ) : (
              s.kind !== "person" && <div className="lw-empty"><b>No text recorded</b>The graph names this step without its {s.kind === "script" ? "command" : "prompt"}.</div>
            )}
            {s.kind !== "agent" && node && (
              <div className="lw-facts">
                <div className="lw-fact"><span>Runs reached it</span><b>{node.runs}</b></div>
                <div className="lw-fact"><span>Failed</span><b>{node.failed}</b></div>
                <div className="lw-fact"><span>Typically takes</span><b>{typical ?? "-"}</b></div>
              </div>
            )}
          </>
        )}
        {tab === "decisions" && <DecisionList step={s} selectedRun={selection.run} />}
        {tab === "try" && Try && <Try model={model} step={s} draft={dirty ? draft : null} />}
        {tab === "ask" && Ask && <Ask model={model} step={s} draft={dirty ? draft : null} />}
      </div>
    </aside>
  );
}
