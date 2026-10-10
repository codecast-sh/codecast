// The line's widgets (docs/architecture/line-workspace.md LW3): every view of
// the workspace and every `line` fence draws from these, over one model.
export { LineGraphWidget, type LineGraphWidgetProps } from "./LineGraphWidget";
export { StepCard, type StepCardProps } from "./StepCard";
export { PromptView, type PromptViewProps } from "./PromptView";
export { PromptDiff, PromptDiffLines, type PromptDiffProps } from "./PromptDiff";
export { DecisionCard, DecisionList, ResultFields, type DecisionCardProps, type DecisionListProps } from "./DecisionCard";
export { BeforeAfterTable, beforeAfterScore, type BeforeAfterRow, type BeforeAfterProps, type Answer } from "./BeforeAfterTable";
export { RunPath, RunTrail, type RunPathProps } from "./RunPath";
export { AlreadyTried } from "./AlreadyTried";
export { ProblemCard } from "./ProblemCard";
export { KindTag, OutcomeTag, DecisionTag, CameBackTag, GroupBackTag, RouteCount, closedTone, NavLink, LineNavProvider, useLineNav, LineFenceScopeProvider, useLineFenceScope, type LineFenceScope, outcomeTone, outcomeWords, durationWords, dayWords, type LineNav, type OutcomeTone } from "./parts";
export { tallyWords, tallyRowWords, failureWords } from "./tallyWords";
export { LINE_ACTIONS, type LineActionSlots, type TrySlotProps, type AskSlotProps, type LabelSlotProps } from "./actionSlots";
