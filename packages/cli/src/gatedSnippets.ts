// The decision half of the daemon's team-gated snippet reconcile (chat, calls):
// given what the machine last applied and what the heartbeat now says, which
// snippets to install or disable, and what to record afterwards. Pure, so it
// is testable without a daemon; daemon.ts runs the `cast install` calls.
//
// The rule lives in @platform/snippets; what codecast supplies is the predicate
// that reads a slug's enabled flag out of the local config through the catalog.
//
// Only CHANGES act. A slug the server reports the same as last time is left
// alone even if the local flag disagrees, so a human's hand `--disable` sticks
// until the team flips the feature again. A machine with nothing recorded
// treats every reported slug as a change — that is what brings a fleet that
// installed the chat snippet before the flag existed into line on its first
// beat after the upgrade. A slug this binary's catalog does not know is
// recorded but never acted on: the server may report features it does not ship.
import { snippetBySlug } from "@codecast/shared/contracts";
import { planGatedSnippets as planGatedSnippetsWith } from "@platform/snippets";

export type { GatedSnippetPlan } from "@platform/snippets";

export function planGatedSnippets(
  prev: Record<string, boolean> | undefined,
  avail: Record<string, boolean>,
  config: Record<string, unknown>,
) {
  return planGatedSnippetsWith(prev, avail, (slug) => {
    const desc = snippetBySlug(slug);
    return desc ? config[desc.enabledKey] === true : undefined;
  });
}
