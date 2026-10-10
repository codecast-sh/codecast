"use client";
// The places the line's actions (line-workspace.md LW4) plug in: trying an
// edited step on past cases, asking an agent to change a step, and marking a
// decision right or wrong. The shell and the widgets draw a slot only when its
// component is set here, so a slot with nothing behind it never shows a
// control that does nothing. The actions fill these in this one file.
import type { ComponentType } from "react";
import type { LineModel, LineStep, StepDecision } from "../../../lib/line/lineModel";

export type TrySlotProps = {
  model: LineModel;
  step: LineStep;
  /** The unsaved edit, when the person has one. */
  draft: string | null;
  /** Only these cases (run ids), when given: Replay re-runs the one case it is playing. */
  runs?: ReadonlyArray<string>;
};
export type AskSlotProps = { model: LineModel; step: LineStep; draft: string | null };
export type LabelSlotProps = { step: LineStep; decision: StepDecision };

export type LineActionSlots = {
  /** A drawer tab: the edit run on chosen past cases, old and new answers side by side. */
  Try: ComponentType<TrySlotProps> | null;
  /** A drawer tab: say what is wrong, attach labeled cases, an agent returns a change. */
  Ask: ComponentType<AskSlotProps> | null;
  /** In a decision card's foot: right or wrong, with a note. */
  Label: ComponentType<LabelSlotProps> | null;
};

export const LINE_ACTIONS: LineActionSlots = { Try: null, Ask: null, Label: null };
