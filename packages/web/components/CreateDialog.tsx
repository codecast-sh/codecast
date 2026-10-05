import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { isMac } from "../shortcuts";

// The one shell every "create" dialog wears: task, doc, plan, channel.
//
// Each used to hand-roll its own overlay, panel and footer, and they drifted:
// three different primary buttons, a disabled state that read as a broken
// button, a bare "⌘+↵" string instead of a keycap, placeholders too faint to
// read. One shell keeps them identical, so a polish pass lands everywhere.
//
// Layout: a context line (what you are making, and in which workspace), the
// body (a big title field first), and a tinted footer with secondary controls
// on the left and Cancel + the primary action on the right. Escape closes;
// Cmd/Ctrl+Enter submits from anywhere in the dialog, and `submitOnEnter`
// lets a dialog with no multi-line field submit on a plain Enter too.

export function CreateDialog({
  icon,
  noun,
  onClose,
  onSubmit,
  canSubmit,
  submitLabel,
  submitOnEnter = false,
  width = "md",
  footerStart,
  children,
}: {
  /** The kind's glyph, already sized and colored by the caller. */
  icon: ReactNode;
  /** "task", "channel", "plan": the context line reads "New <noun> in <workspace>". */
  noun: string;
  onClose: () => void;
  onSubmit: () => void;
  canSubmit: boolean;
  submitLabel: string;
  submitOnEnter?: boolean;
  width?: "md" | "lg";
  /** Secondary controls on the footer's left: "Create another", "Add from Slack". */
  footerStart?: ReactNode;
  children: ReactNode;
}) {
  const workspaceName = useInboxStore((s) => {
    const teamId = s.clientState.ui?.active_team_id;
    if (!teamId) return "Personal";
    return (s.teams ?? []).find((t: any) => t?._id === teamId)?.name ?? null;
  });
  const submit = () => {
    if (canSubmit) onSubmit();
  };

  return (
    <div
      className="fixed inset-0 z-[10001] flex items-start justify-center bg-black/55 backdrop-blur-[3px] pt-[12vh] px-4 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        // mousedown, not click: a text selection dragged out of a field and
        // released over the backdrop must not throw the draft away.
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey || submitOnEnter)) {
          // A plain Enter an inner control already took (a picker choosing a
          // person) stays its own. Cmd/Ctrl+Enter always submits, even though
          // the description editor marks it handled.
          const chord = e.metaKey || e.ctrlKey;
          if (e.nativeEvent.isComposing || (!chord && e.defaultPrevented)) return;
          e.preventDefault();
          submit();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`New ${noun}`}
        className={`w-full ${width === "lg" ? "max-w-[640px]" : "max-w-[500px]"} rounded-xl border border-sol-border/70 bg-sol-bg shadow-[0_24px_64px_-12px_rgba(0,0,0,0.55),0_2px_6px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.04)] animate-in fade-in zoom-in-[0.98] slide-in-from-top-2 duration-200`}
      >
        <div className="flex items-center gap-2 pl-5 pr-3 pt-3.5 text-xs text-sol-text-dim">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-sol-bg-alt">{icon}</span>
          <span>
            New {noun}
            {workspaceName && (
              <>
                <span className="mx-1.5 text-sol-text-dim/50">in</span>
                <span className="text-sol-text-muted">{workspaceName}</span>
              </>
            )}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded-md p-1 text-sol-text-dim transition-colors hover:bg-sol-bg-alt hover:text-sol-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {children}

        <div className="flex items-center gap-2 rounded-b-xl border-t border-sol-border/50 bg-sol-bg-alt/40 px-5 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">{footerStart}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-sol-text-muted transition-colors hover:bg-sol-bg-alt hover:text-sol-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="sol-btn-solid inline-flex items-center gap-2 rounded-lg border border-transparent bg-sol-cyan py-1.5 pl-3 pr-1.5 text-xs font-semibold text-sol-bg disabled:cursor-not-allowed disabled:border-sol-border/60 disabled:bg-sol-bg-alt disabled:text-sol-text-dim"
          >
            {submitLabel}
            <span className="inline-flex gap-0.5 opacity-80">
              {(submitOnEnter ? ["↵"] : [isMac ? "⌘" : "Ctrl", "↵"]).map((k) => (
                <KeyCap key={k} size="xs">{k}</KeyCap>
              ))}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

/** The dialog's headline field: what the thing is called. */
export const CreateDialogTitle = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function CreateDialogTitle({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        autoFocus
        spellCheck={false}
        {...props}
        className={`w-full bg-transparent text-xl font-semibold tracking-[-0.01em] text-sol-text outline-none placeholder:text-sol-text-dim/60 ${className ?? ""}`}
      />
    );
  },
);

/** A one-line field under the title: a topic, a goal. */
export function CreateDialogSubtitle({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full bg-transparent text-sm text-sol-text-muted outline-none placeholder:text-sol-text-dim/55 ${className ?? ""}`}
    />
  );
}

/** A property pill in a create dialog (status, priority, labels, assignee).
 *  `set` lifts it once it carries a value the user chose; `open` marks the
 *  pill whose menu is showing. */
export function createChipClass(set = false, open = false): string {
  return `group/chip flex h-7 items-center gap-1.5 rounded-md border pl-2 pr-1.5 text-xs transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/40 ${
    open
      ? "border-sol-cyan/50 bg-sol-bg-alt text-sol-text shadow-[0_0_0_3px_color-mix(in_srgb,var(--sol-cyan)_12%,transparent)]"
      : set
        ? "border-sol-border bg-sol-bg-alt text-sol-text hover:border-sol-text-dim/50"
        : "border-sol-border/50 bg-sol-bg-alt/40 text-sol-text-muted hover:border-sol-border hover:bg-sol-bg-alt hover:text-sol-text"
  }`;
}

/** The pill's trailing caret: quiet at rest, turns over while the menu is open. */
export function CreateChipCaret({ open }: { open: boolean }) {
  return (
    <ChevronDown
      className={`h-3 w-3 shrink-0 transition-[transform,opacity] duration-150 ${open ? "rotate-180 opacity-90" : "opacity-40 group-hover/chip:opacity-80"}`}
    />
  );
}

/** The menu a pill opens. */
export const CREATE_MENU_CLASS =
  "absolute left-0 top-full z-[250] mt-1.5 min-w-[11rem] origin-top-left rounded-lg border border-sol-border/80 bg-sol-bg p-1 shadow-[0_14px_36px_-10px_rgba(0,0,0,0.55),0_2px_6px_rgba(0,0,0,0.2)] animate-in fade-in zoom-in-95 slide-in-from-top-1 duration-100";

/** A row in that menu; the chosen one carries a soft accent and a check. */
export function createMenuItemClass(selected = false): string {
  return `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
    selected ? "bg-sol-cyan/10 text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text"
  }`;
}

/** The search field at the top of a filterable menu. */
export const CREATE_MENU_SEARCH_CLASS =
  "-mx-1 -mt-1 mb-1 flex items-center gap-2 border-b border-sol-border/40 px-3 py-2";

/** A section heading inside a menu ("People", "Agents"). */
export const CREATE_MENU_SECTION_CLASS =
  "px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-sol-text-dim/80";
