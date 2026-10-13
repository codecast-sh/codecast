"use client";
// Right or wrong on one decision (line-workspace.md LW4), with a note: the
// step's test set. Two icon toggles that stay out of the way until a row is
// hovered, unless set or suggested; pressing the pressed one takes the label
// back. Wrong asks what it should have decided, in one line, which the label
// carries to Try and to an agent asked to change the step.
import { useState } from "react";
import { Check, X } from "lucide-react";
import { useInboxStore } from "../../../../store/inboxStore";
import type { LabelSlotProps } from "../actionSlots";
import "./actions.css";

export function LabelControl({ step, decision: d }: LabelSlotProps) {
  const mine = d.labels.find((l) => l.mine) ?? null;
  // A close the problem came back after: the answer the record suggests, for a person to confirm.
  const suspect = !!d.closed && !d.closed.held;
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(mine?.note ?? "");
  const label = (verdict: "right" | "wrong" | null, text?: string | null) => useInboxStore.getState().labelDecision(d.runId, step.id, verdict, text ?? null);

  const press = (verdict: "right" | "wrong") => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mine?.verdict === verdict) { label(null); setNoting(false); return; }
    label(verdict, mine?.note ?? null);
    if (verdict === "wrong") { setNote(mine?.note ?? ""); setNoting(true); } else setNoting(false);
  };
  const other = d.label && !d.label.mine ? `, says ${d.label.byName ?? "a teammate"}` : "";

  return (
    <span className="lw-labeler" data-set={mine || suspect || noting ? "" : undefined} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {noting && (
        <input
          className="lw-labeler-note"
          autoFocus
          value={note}
          placeholder="What should it have decided?"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { label("wrong", note); setNoting(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); label("wrong", note); setNoting(false); }
            if (e.key === "Escape") { e.preventDefault(); setNoting(false); }
          }}
        />
      )}
      <button type="button" className="lw-labeler-b" data-verdict="right" aria-pressed={mine?.verdict === "right"} onClick={press("right")} aria-label="Mark right" title={mine?.verdict === "right" ? "You marked it right" : `Mark right${other}`}><Check /></button>
      <button type="button" className="lw-labeler-b" data-verdict="wrong" data-suggest={suspect ? "" : undefined} aria-pressed={mine?.verdict === "wrong"} onClick={press("wrong")} aria-label="Mark wrong" title={mine?.verdict === "wrong" ? mine.note ?? "You marked it wrong" : suspect ? "The problem came back: likely wrong" : `Mark wrong${other}`}><X /></button>
    </span>
  );
}
