"use client";
// The Ask block (line-journeys.md LJ6.2): the question a problem holds on, in
// full, with the answer box and its two outcomes. An answer marks the problem
// ready with the answer as its context (the sweep starts it); "Not a problem"
// closes it.
import { useRef, useState } from "react";
import { useInboxStore } from "../../../../../store/inboxStore";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { askParts } from "../../../../../lib/line/lineInbox";
import { wholeSentences } from "../../../../../lib/line/problemPage";
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
export function ProblemAsk({ question, why, taskRef, focus, asks, startWords }: { question: string; why?: string | null; taskRef: string | null; focus: boolean; asks: boolean; startWords?: string | null }) {
  // A note stored cut at its cap ends mid-word: it is read to its last full sentence.
  const context = why ? askParts(wholeSentences(why)).context : null;
  const [text, setText] = useState("");
  const [sent, setSent] = useState<ProblemAnswer | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useWatchEffect(() => { if (focus) box.current?.focus({ preventScroll: true }); }, [focus]);
  if (!taskRef) return null;
  const answer = (how: ProblemAnswer) => {
    if (asks && how === "confirmed" && !text.trim()) { box.current?.focus(); return; }
    answerProblem(taskRef, how, text);
    setSent(how);
  };
  return (
    <section className="ask" data-line-ask={sent ?? "open"}>
      <p className="ask-q">{wholeSentences(question)}</p>
      {context && <p className="ask-why">{context}</p>}
      {sent ? (
        <div className="ask-done"><span className="lw-oc" data-tone={sent === "confirmed" ? "ok" : "none"}>{sent === "confirmed" ? (asks ? "Answered" : "Confirmed") : "Closed: not a problem"}</span></div>
      ) : (
        <>
          <textarea
            ref={box}
            className="ask-box"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer("confirmed"); } }}
            placeholder={asks ? "Your answer. It goes with the problem to the run" : "A note for the run (optional)"}
            aria-label={asks ? "Your answer" : "A note for the run"}
            required={asks}
            data-line-ask-box
          />
          <div className="ask-acts">
            <button type="button" className="lw-act" data-primary="" onClick={() => answer("confirmed")} data-line-ask-confirm>{asks ? "Answer" : "Yes, it is real"}{startWords ? `, ${startWords}` : ""}</button>
            <button type="button" className="lw-act" onClick={() => answer("dropped")} data-line-ask-drop>Not a problem</button>
          </div>
        </>
      )}
    </section>
  );
}
