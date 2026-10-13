"use client";
// The Ask block (line-journeys.md LJ6.2): the question a problem holds on, in
// full, with the answer box and its two outcomes. An answer marks the problem
// ready with the answer as its context (the sweep starts it); "Not a problem"
// closes it.
import { useRef, useState, type KeyboardEvent } from "react";
import { useInboxStore } from "../../../../../store/inboxStore";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { askAsQuestion, askParts } from "../../../../../lib/line/lineInbox";
import type { LineAdmission } from "../../../../../lib/lineFlow";
import { startsAtOnce } from "../../../map/LineStartSwitch";
import { useLineAdmission } from "../../../map/useLineAdmission";
import { askShape, wholeSentences } from "../../../../../lib/line/problemPage";
import "./askBlock.css";

export type ProblemAnswer = "confirmed" | "dropped";

/** A person's answer to grounding's question: confirmed starts it (with the note as its context), dropped closes it. */
export function answerProblem(taskRef: string, how: ProblemAnswer, note = "") {
  const st = useInboxStore.getState();
  const said = note.trim();
  if (said) void st.addTaskComment(taskRef, said);
  void st.updateTask(taskRef, how === "confirmed" ? { readiness: "ready", readiness_note: said ? `Confirmed: ${said}` : "Confirmed by a person." } : { status: "dropped" });
}

/** What answering does next, from the project's admission (said on the answer's button, LJ6.2): "starts now",
 *  "queued behind 3"; `under` "off" when the project's line is off, so nothing starts until it is on. */
export function answerNext(a: LineAdmission | null | undefined, startable: boolean): { words: string | null; under: "off" | null } {
  if (!a) return { words: null, under: null };
  if (!a.on) return { words: null, under: "off" };
  if (!startable) return { words: null, under: null };
  const free = Math.max(0, a.slots - (a.busy ?? 0));
  if (free > 0 && (startsAtOnce({ ...a, queued: (a.queued ?? 0) + 1 }) ?? 1) > (a.queued ?? 0)) return { words: "starts now", under: null };
  return { words: a.queued != null ? `queued behind ${a.queued}` : "queued", under: null };
}

/** The same, for a problem by its row id, where no workspace hands in its project's admission (For you's reader). */
export function useAnswerNext(caseId: string | null, projectId: string | null): string | null {
  const task = useInboxStore((s) => (caseId ? (s.tasks as Record<string, { goal_ref?: string | null; assignee?: string | null } | undefined>)?.[caseId] ?? null : null));
  const { admission } = useLineAdmission(projectId);
  const next = answerNext(admission, !!task?.goal_ref && !task?.assignee);
  return next.words ?? (next.under === "off" ? "starts once its line is on" : null);
}

const IS_REAL = "Is this a real problem?";

/** `question` is the ask itself (lineInbox askLine); `why` is grounding's whole note, of which only what the question
 *  leaves out shows under it. `asks`: the work holds on what a person knows, so an answer is required and goes with
 *  the problem as its context. Otherwise a new problem asks only whether it is real: one press says yes, a note is
 *  optional, and what grounding still does not know is shown as the open question beside it.
 *  The ask is read as a question (askAsQuestion); one that weighs alternatives offers each as a one-press answer.
 *  `startWords`: what answering does next ("starts now", "queued behind 3"), said on the button when known. */
export function ProblemAsk({ question, why, taskRef, focus, asks, startWords }: { question: string; why?: string | null; taskRef: string | null; focus: boolean; asks: boolean; startWords?: string | null }) {
  const read = askAsQuestion(question);
  // A note stored cut at its cap ends mid-word: it is read to its last full sentence.
  const context = why ? askParts(wholeSentences(why)).context : null;
  // A question that names parts gets a field for each (askShape); one that weighs alternatives, a button for each.
  const shape = asks && !read.choices.length ? askShape(read.question) : { required: false, parts: [] as string[] };
  const [text, setText] = useState("");
  const [fields, setFields] = useState<string[]>(() => shape.parts.map(() => ""));
  const [sent, setSent] = useState<ProblemAnswer | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const focusAnswer = () => (shape.parts.length ? first.current : box.current)?.focus({ preventScroll: true });
  useWatchEffect(() => { if (focus) focusAnswer(); }, [focus]);
  if (!taskRef) return null;
  const note = shape.parts.length ? shape.parts.map((k, i) => (fields[i]?.trim() ? `${k}: ${fields[i].trim()}` : null)).filter(Boolean).join("\n") : text;
  const complete = shape.parts.length ? fields.every((f) => f.trim()) : !!text.trim();
  const answer = (how: ProblemAnswer, said = note) => {
    if (asks && how === "confirmed" && !said.trim()) { focusAnswer(); return; }
    answerProblem(taskRef, how, said);
    setSent(how);
  };
  const submitKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer("confirmed"); } };
  const next = startWords ? `, ${startWords}` : "";
  const open = !asks && read.question && read.question !== IS_REAL ? read.question : null;
  return (
    <section className="ask" data-line-ask={sent ?? "open"} data-line-ask-kind={asks ? "question" : "confirm"}>
      <p className="ask-q" data-line-ask-q>{asks ? read.question : IS_REAL}</p>
      {open && <p className="ask-open" data-line-ask-open><span>Still unknown</span>{open}</p>}
      {sent ? (
        <div className="ask-done"><span className="lw-oc" data-tone={sent === "confirmed" ? "ok" : "none"}>{sent === "confirmed" ? (asks ? "Answered" : "Confirmed") : "Closed: not a problem"}</span></div>
      ) : (
        <>
          {read.choices.length > 0 && (
            <div className="ask-choices" role="group" aria-label="Answers" data-line-ask-choices={read.choices.length}>
              {read.choices.map((c) => (
                <button key={c.says} type="button" className="ask-choice" onClick={() => answer("confirmed", c.so ? `${c.says} (${c.so})` : c.says)} data-line-ask-choice>
                  <b>{c.says}</b>{c.so && <span>{c.so.charAt(0).toUpperCase() + c.so.slice(1)}</span>}
                </button>
              ))}
              {startWords && <span className="ask-then" data-line-ask-then>Either answer {startWords.replace(/^starts/, "starts the fix").replace(/^queued/, "queues the fix")}</span>}
            </div>
          )}
          {shape.parts.length > 0 ? (
            <div className="ask-fields" data-line-ask-fields={shape.parts.length}>
              {shape.parts.map((k, i) => (
                <label key={k} className="ask-field">
                  <span>{k}</span>
                  <input ref={i === 0 ? first : undefined} value={fields[i] ?? ""} onChange={(e) => setFields(fields.map((f, j) => (j === i ? e.target.value : f)))} onKeyDown={submitKey} required data-line-ask-field={i} />
                </label>
              ))}
            </div>
          ) : (
            <textarea
              ref={box}
              className="ask-box"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={submitKey}
              placeholder={!asks ? "A note for the run (optional)" : read.choices.length ? "Something else" : "Your answer"}
              aria-label={!asks ? "A note for the run" : read.choices.length ? "Another answer" : "Your answer"}
              required={asks && !read.choices.length}
              data-line-ask-box
            />
          )}
          <div className="ask-acts">
            {asks
              ? (!read.choices.length || text.trim()) && <button type="button" className="lw-act" data-primary="" disabled={!complete} onClick={() => answer("confirmed")} data-line-ask-confirm>Answer{next}</button>
              : <button type="button" className="lw-act" data-primary="" onClick={() => answer("confirmed")} data-line-ask-confirm>Yes, it is real{next}</button>}
            <button type="button" className="lw-act" onClick={() => answer("dropped", text)} data-line-ask-drop>Not a problem</button>
          </div>
        </>
      )}
      {context && <details className="ask-why"><summary>Why it asks</summary><p>{context}</p></details>}
    </section>
  );
}
