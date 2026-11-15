import { useCallback } from "react";
import { hasOpenModal, usePaneShortcutAction } from "../shortcuts";
import { stepEffort } from "../lib/effortStep";

/** The attribute a composer surface carries, naming the session its effort
 *  keys act on (the compose popup and each docked composer). */
export const EFFORT_SCOPE_ATTR = "data-effort-scope";

/** Whether a surface for `conversationId` takes an effort key, given the
 *  scope focus sits in (null: in no marked surface) and whether a modal is up. */
export function ownsEffortKey(o: { scope: string | null | undefined; conversationId: string; focusOnly: boolean; modalOpen: boolean }): boolean {
  return o.scope ? o.scope === o.conversationId : !o.focusOnly && !o.modalOpen;
}

/**
 * Alt+. / Alt+, (conv.effortUp / conv.effortDown) for one session. Several
 * surfaces can be up at once (a conversation, a compose popup over it, docked
 * composers), and the key belongs to the one holding focus: a surface marked
 * with EFFORT_SCOPE_ATTR answers only while focus is inside it, and the
 * conversation answers only when focus is in no such surface and no modal
 * sits over it. `focusOnly` is the marked surface's side of that rule.
 */
export function useEffortKeys(
  conversationId: string | null | undefined,
  opts: { blank: boolean; enabled: boolean; focusOnly: boolean },
): void {
  const { blank, enabled, focusOnly } = opts;
  const step = useCallback((dir: 1 | -1) => {
    if (!enabled || !conversationId) return false;
    const scope = (document.activeElement as HTMLElement | null)?.closest?.(`[${EFFORT_SCOPE_ATTR}]`)?.getAttribute(EFFORT_SCOPE_ATTR);
    if (!ownsEffortKey({ scope, conversationId, focusOnly, modalOpen: hasOpenModal() })) return false;
    return stepEffort(conversationId, dir, blank);
  }, [enabled, conversationId, focusOnly, blank]);
  // Pane-scoped: of a split's conversations only the active pane's answers.
  usePaneShortcutAction("conv.effortUp", useCallback(() => step(1), [step]));
  usePaneShortcutAction("conv.effortDown", useCallback(() => step(-1), [step]));
}
