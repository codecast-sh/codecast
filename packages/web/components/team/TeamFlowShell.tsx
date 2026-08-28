import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Check } from "lucide-react";
import { TeamCrest } from "./TeamCrest";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { cn } from "../../lib/utils";
import "./teamFlow.css";

export interface TeamFlowStep {
  key: string;
  label: string;
}

export interface TeamFlowCrest {
  icon?: string | null;
  color?: string | null;
  name?: string;
}

interface TeamFlowShellProps {
  /** Small line above the heading, names the flow ("New team", "Join a team"). */
  eyebrow: string;
  steps: TeamFlowStep[];
  stepIndex: number;
  crest: TeamFlowCrest;
  heading: string;
  description?: string;
  onBack: () => void;
  backLabel?: string;
  onSkip?: () => void;
  skipLabel?: string;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  /** When set, Continue submits this form, so Enter inside its inputs advances. */
  formId?: string;
  /** Enter anywhere outside a text field or button runs onContinue. */
  enterAdvances?: boolean;
  children: ReactNode;
}

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]);

/**
 * Shared shell for the create and join team flows: progress rail on the
 * left with the live crest, the step on the right, and one footer with
 * Back, Skip and Continue. Esc goes back. The crest color is the accent
 * for the whole surface through --team-flow-accent.
 */
export function TeamFlowShell({
  eyebrow,
  steps,
  stepIndex,
  crest,
  heading,
  description,
  onBack,
  backLabel = "Back",
  onSkip,
  skipLabel = "Skip",
  onContinue,
  continueLabel = "Continue",
  continueDisabled,
  formId,
  enterAdvances,
  children,
}: TeamFlowShellProps) {
  // Each step change remounts the section (key={stepIndex}), which drops
  // keyboard focus on document.body. Re-target the new heading: a focused
  // heading also gets announced, so screen readers hear the step change.
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Focus the heading only when the step actually changes. A boolean "first
  // paint" guard breaks under StrictMode's double effect run in dev: the
  // second run would steal focus from the step's autofocused field.
  const lastStep = useRef(stepIndex);
  useEffect(() => {
    if (lastStep.current !== stepIndex) headingRef.current?.focus();
    lastStep.current = stepIndex;
  }, [stepIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        const el = e.target as HTMLElement | null;
        // Esc inside a text field only leaves the field. A second Esc goes back.
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
          e.preventDefault();
          el.blur();
          return;
        }
        e.preventDefault();
        onBack();
        return;
      }
      if (e.key === "Enter" && enterAdvances && onContinue && !continueDisabled) {
        const el = e.target as HTMLElement | null;
        if (el && (TEXT_TAGS.has(el.tagName) || el.isContentEditable || el.getAttribute("role") === "radio")) return;
        e.preventDefault();
        onContinue();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, onContinue, continueDisabled, enterAdvances]);

  const accent = crest.color ? `var(--sol-${crest.color})` : undefined;
  const style = accent ? ({ "--team-flow-accent": accent } as CSSProperties) : undefined;
  const showEnterHint = enterAdvances || !!formId;

  return (
    <div className="tf-root flex flex-col sm:flex-row gap-6 sm:gap-10" style={style}>
      <aside className="sm:w-40 shrink-0 tf-reveal" style={{ "--tf-i": 0 } as CSSProperties}>
        <div className="flex sm:flex-col items-center sm:items-start gap-3 sm:gap-2 mb-4 sm:mb-6">
          <TeamCrest icon={crest.icon} color={crest.color} size="lg" className="tf-crest" />
          <div className="min-w-0">
            <div className="tf-eyebrow text-[11px] uppercase tracking-wider">{eyebrow}</div>
            {/* No aria-live: on step 1 this mirrors the name field on every
                keystroke, and a live region would announce each character a
                second time on top of the input's own echo. */}
            <div className="text-sm font-medium text-sol-text truncate max-w-[10rem]">
              {crest.name?.trim() || "Team name"}
            </div>
          </div>
        </div>
        {/* flex-wrap: below sm the rail is a horizontal row, and four labels
            outgrow a 390px viewport; wrapping keeps every step readable
            without clipping or page-level horizontal scroll. */}
        <ol className="flex flex-wrap sm:flex-col gap-x-4 gap-y-2 sm:gap-0" aria-label="Steps">
          {steps.map((s, i) => {
            const state = i < stepIndex ? "done" : i === stepIndex ? "active" : "todo";
            return (
              <li key={s.key} className="flex sm:flex-row items-center sm:items-stretch gap-2 sm:gap-3">
                <div className="flex sm:flex-col items-center">
                  <div
                    className={cn(
                      "tf-marker flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold shrink-0",
                      state === "todo" && "bg-sol-bg-alt text-sol-text-dim border border-sol-border/60",
                    )}
                    data-state={state}
                    aria-current={state === "active" ? "step" : undefined}
                  >
                    {state === "done" ? <Check className="w-3.5 h-3.5" /> : i + 1}
                  </div>
                  {i < steps.length - 1 && (
                    <div className="tf-connector hidden sm:block w-px h-6 my-1" data-done={i < stepIndex} />
                  )}
                </div>
                <span
                  className={cn(
                    "text-sm leading-6 sm:mt-0",
                    state === "active" ? "text-sol-text font-medium" : "text-sol-text-dim",
                  )}
                >
                  {s.label}
                </span>
              </li>
            );
          })}
        </ol>
      </aside>

      <section className="flex-1 min-w-0 flex flex-col" key={stepIndex}>
        <header className="tf-reveal mb-6" style={{ "--tf-i": 1 } as CSSProperties}>
          <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold text-sol-text focus:outline-none">
            {heading}
          </h1>
          {description && <p className="mt-1.5 text-sm text-sol-text-dim">{description}</p>}
        </header>

        <div className="tf-reveal flex-1 min-w-0" style={{ "--tf-i": 2 } as CSSProperties}>
          {children}
        </div>

        <footer
          className="tf-reveal mt-8 pt-4 border-t border-sol-border/60 flex items-center gap-2"
          style={{ "--tf-i": 3 } as CSSProperties}
        >
          <button
            type="button"
            onClick={onBack}
            className="tf-ghost -ml-3 inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-sm text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--team-flow-accent)]"
          >
            {backLabel}
            <KeyCap size="xs">Esc</KeyCap>
          </button>
          <div className="flex-1" />
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="tf-ghost h-9 px-3 rounded-md text-sm text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--team-flow-accent)]"
            >
              {skipLabel}
            </button>
          )}
          {(onContinue || formId) && (
            <button
              type={formId ? "submit" : "button"}
              form={formId}
              onClick={formId ? undefined : onContinue}
              disabled={continueDisabled}
              className="tf-primary inline-flex items-center gap-2 h-9 px-4 rounded-md text-sm font-medium disabled:opacity-50 disabled:pointer-events-none"
            >
              {continueLabel}
              {showEnterHint && <KeyCap size="xs">↵</KeyCap>}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
