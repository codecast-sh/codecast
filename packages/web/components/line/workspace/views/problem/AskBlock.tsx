"use client";
// The Ask block (line-journeys.md LJ6.2): the question a problem holds on, in
// full, with the answer box and its two outcomes. An answer marks the problem
// ready with the answer as its context (the sweep starts it); "Not a problem"
// closes it.
import { useRef, useState, type KeyboardEvent } from "react";
import { useInboxStore } from "../../../../../store/inboxStore";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { askParts } from "../../../../../lib/line/lineInbox";
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

/** `question` is the ask itself (lineInbox askLine); `why` is grounding's whole note, of which only what the question
 *  leaves out shows under it. `asks`: the work holds on what a person knows, so the answer is required and goes with
 *  the problem as its context; otherwise a new problem asks only to be confirmed, and a note is optional.
 *  `startWords`: what answering does next ("starts now", "queued behind 3"), said on the button when known. */
export function ProblemAsk({ question, why, taskRef, focus, asks: asksAnswer, startWords }: { question: string; why?: string | null; taskRef: string | null; focus: boolean; asks: boolean; startWords?: string | null }) {
  const q = wholeSentences(question);
  // A note stored cut at its cap ends mid-word: it is read to its last full sentence.
  const context = why ? askParts(wholeSentences(why)).context : null;
  // The control takes the shape of what is asked: a question that names parts gets a field for each, and one that
  // asks for content cannot be confirmed with a bare yes.
  const shape = askShape(q);
  const asks = asksAnswer || shape.required;
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
  const answer = (how: ProblemAnswer) => {
    if (asks && how === "confirmed" && !complete) { focusAnswer(); return; }
    answerProblem(taskRef, how, note);
    setSent(how);
  };
  const submitKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer("confirmed"); } };
  return (
    <section className="ask" data-line-ask={sent ?? "open"}>
      <p className="ask-q">{q}</p>
      {sent ? (
        <div className="ask-done"><span className="lw-oc" data-tone={sent === "confirmed" ? "ok" : "none"}>{sent === "confirmed" ? (asks ? "Answered" : "Confirmed") : "Closed: not a problem"}</span></div>
      ) : (
        <>
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
              placeholder={asks ? "Your answer" : "A note for the run (optional)"}
              aria-label={asks ? "Your answer" : "A note for the run"}
              required={asks}
              data-line-ask-box
            />
          )}
          <div className="ask-acts">
            <button type="button" className="lw-act" data-primary="" disabled={asks && !complete} onClick={() => answer("confirmed")} data-line-ask-confirm>{asksAnswer ? "Answer" : "Yes, it is real"}{startWords ? `, ${startWords}` : ""}</button>
            <button type="button" className="lw-act" onClick={() => answer("dropped")} data-line-ask-drop>Not a problem</button>
          </div>
        </>
      )}
      {context && <details className="ask-why"><summary>Why it asks</summary><p>{context}</p></details>}
    </section>
  );
}
