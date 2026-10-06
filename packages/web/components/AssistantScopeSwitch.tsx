// Hosted mode's Assistant/Everything switch (lib/assistantScope), the same
// two words wherever a list follows the scope: the inbox panel's head,
// Approvals and Routines. One switch writes one preference, so flipping it
// on any page flips them all. Ctrl+, flips it too (inbox.toggleFlatView).
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { useAssistantScope } from "../lib/surfaces";
import { moreInEverything } from "../lib/assistantScope";

export function AssistantScopeSwitch({ label = "What this lists" }: { label?: string }) {
  const { only, hosted, setEverything } = useAssistantScope();
  if (!hosted) return null;
  const option = (everything: boolean, word: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={only !== everything}
      onClick={() => setEverything(everything)}
      className={`rounded-[5px] px-1.5 py-[2px] text-[11.5px] font-medium transition-colors ${
        only !== everything ? "bg-sol-card text-sol-text shadow-[0_0_0_1px_var(--sol-border)]" : "text-sol-text-dim hover:text-sol-text"
      }`}
    >
      {word}
    </button>
  );
  return (
    <ShortcutTooltip label="Show the assistant's work, or everything" action="inbox.toggleFlatView" side="bottom">
      <div role="radiogroup" aria-label={label} data-cc-scope-switch className="flex items-center gap-0.5 rounded-md bg-sol-bg-alt/70 p-px">
        {option(false, "Assistant")}
        {option(true, "Everything")}
      </div>
    </ShortcutTooltip>
  );
}

/** The quiet line under a scoped list: what Everything adds, one press away. */
export function MoreInEverything({ hidden }: { hidden: number }) {
  const { only, setEverything } = useAssistantScope();
  const line = only ? moreInEverything(hidden) : null;
  if (!line) return null;
  return (
    <button
      type="button"
      onClick={() => setEverything(true)}
      data-cc-more-everything
      className="mt-3 block text-[12px] text-sol-text-dim hover:text-sol-text"
    >
      {line}
    </button>
  );
}
