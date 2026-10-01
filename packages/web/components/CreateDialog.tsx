import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
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
          // An inner control that already took the Enter (a picker choosing a
          // person, an IME composing) keeps it.
          if (e.nativeEvent.isComposing || e.defaultPrevented) return;
          e.preventDefault();
          submit();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`New ${noun}`}
        className={`w-full ${width === "lg" ? "max-w-[640px]" : "max-w-[500px]"} overflow-hidden rounded-xl border border-sol-border/70 bg-sol-bg shadow-[0_24px_64px_-12px_rgba(0,0,0,0.55),0_2px_6px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.04)] animate-in fade-in zoom-in-[0.98] slide-in-from-top-2 duration-200`}
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

        <div className="flex items-center gap-2 border-t border-sol-border/50 bg-sol-bg-alt/40 px-5 py-3">
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
            className="inline-flex items-center gap-2 rounded-lg border border-transparent bg-sol-cyan py-1.5 pl-3 pr-1.5 text-xs font-semibold text-sol-bg shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] transition-[filter,background-color,color] hover:brightness-110 disabled:cursor-not-allowed disabled:border-sol-border/60 disabled:bg-sol-bg-alt disabled:text-sol-text-dim disabled:shadow-none disabled:hover:brightness-100"
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
 *  `set` lifts it once it carries a value the user chose. */
export function createChipClass(set = false): string {
  return `flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${
    set
      ? "border-sol-border bg-sol-bg-alt text-sol-text"
      : "border-sol-border/50 bg-sol-bg-alt/40 text-sol-text-muted hover:border-sol-border hover:bg-sol-bg-alt hover:text-sol-text"
  }`;
}
