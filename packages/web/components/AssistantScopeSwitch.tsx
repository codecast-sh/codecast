// Hosted mode's Assistant/Everything switch (lib/assistantScope), the same
// two words wherever a list follows the scope: the inbox panel's head,
// Approvals and Routines. One switch writes one preference, so flipping it
// on any page flips them all. Ctrl+, flips it too (inbox.toggleFlatView).
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { useAssistantScope } from "../lib/surfaces";
import { moreInEverything } from "../lib/assistantScope";

/** `hidden` is what Everything adds to the list here (MoreInEverything's
 *  count). While the Assistant scope is on and that is nothing, the switch
 *  would only offer the same list again, so it waits until it means
 *  something; with Everything on it stays, as the way back. */
export function AssistantScopeSwitch({ label = "What this lists", hidden }: { label?: string; hidden?: number }) {
  const { only, hosted, setEverything } = useAssistantScope();
  if (!hosted || (only && hidden === 0)) return null;
  const option = (everything: boolean, word: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={only !== everything}
      onClick={() => setEverything(everything)}
      // One selected treatment at every width: the raised chip. nowrap keeps
      // a squeezed header from breaking "Assistant" mid-word.
      className={`shrink-0 whitespace-nowrap rounded-[5px] px-1.5 py-[2px] text-[11.5px] font-medium transition-colors ${
        only !== everything ? "bg-sol-bg text-sol-text shadow-[0_0_0_1px_var(--sol-border)]" : "bg-transparent text-sol-text-dim hover:text-sol-text"
      }`}
    >
      {word}
    </button>
  );
  return (
    <ShortcutTooltip label="Show the assistant's work, or everything" action="inbox.toggleFlatView" side="bottom">
      <div role="radiogroup" aria-label={label} data-cc-scope-switch className="inline-flex w-fit shrink-0 items-center gap-0.5 rounded-md bg-sol-bg-alt/70 p-px">
        {option(false, "Assistant")}
        {option(true, "Everything")}
      </div>
    </ShortcutTooltip>
  );
}

/** The quiet line under a scoped list: what Everything adds, one press away.
 *  `centered` sits it inside an empty state, directly under its words. */
export function MoreInEverything({ hidden, centered }: { hidden: number; centered?: boolean }) {
  const { only, setEverything } = useAssistantScope();
  const line = only ? moreInEverything(hidden) : null;
  if (!line) return null;
  return (
    <button
      type="button"
      onClick={() => setEverything(true)}
      data-cc-more-everything
      className={`${centered ? "mx-auto mt-1" : "mt-3"} block text-[12px] text-sol-text-dim hover:text-sol-text`}
    >
      {line}
    </button>
  );
}
