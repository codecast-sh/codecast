"use client";
// Right or wrong on one decision (line-workspace.md LW4), with a note: the
// step's test set. Two toggles; pressing the pressed one takes the label
// back. Wrong asks what it should have decided, in one line, which the label
// carries to Try and to an agent asked to change the step.
import { useState } from "react";
import { useInboxStore } from "../../../../store/inboxStore";
import type { LabelSlotProps } from "../actionSlots";
import "./actions.css";

export function LabelControl({ step, decision: d }: LabelSlotProps) {
  const mine = d.labels.find((l) => l.mine) ?? null;
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(mine?.note ?? "");
  const label = (verdict: "right" | "wrong" | null, text?: string | null) => useInboxStore.getState().labelDecision(d.runId, step.id, verdict, text ?? null);

  const press = (verdict: "right" | "wrong") => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mine?.verdict === verdict) { label(null); setNoting(false); return; }
    label(verdict, mine?.note ?? null);
    if (verdict === "wrong") { setNote(mine?.note ?? ""); setNoting(true); } else setNoting(false);
  };

  return (
    <span className="lw-labeler" onClick={(e) => e.stopPropagation()}>
      {noting ? (
        <input
          className="lw-labeler-note"
          autoFocus
          value={note}
          placeholder="What should it have decided?"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { label("wrong", note); setNoting(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); label("wrong", note); setNoting(false); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setNoting(false); }
          }}
        />
      ) : (
        <span className="lw-labeler-q">{mine ? "Your label" : "Was it right?"}</span>
      )}
      <button type="button" className="lw-labeler-b" data-verdict="right" aria-pressed={mine?.verdict === "right"} onClick={press("right")}>Right</button>
      <button type="button" className="lw-labeler-b" data-verdict="wrong" aria-pressed={mine?.verdict === "wrong"} onClick={press("wrong")}>Wrong</button>
    </span>
  );
}
