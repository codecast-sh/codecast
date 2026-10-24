// What an agent driving this tab may not do in the person's name. A tab the
// cast browser drives carries the agent-tab stamp (lib/desktopHandoff.ts) and
// is signed in as the person, so the server cannot tell its presses from
// theirs: the controls that open an Ask first secret, approve its read, or
// take the guard off stay disabled here, saying who does it.

import { useCallback, useSyncExternalStore } from "react";
import { approvesSecretRead } from "@codecast/shared/contracts/secrets";
import { AGENT_TAB_EVENT, isAgentDrivenTab } from "./desktopHandoff";

export const PERSON_ONLY = {
  reveal: "A person reveals this",
  approve: "A person approves this",
  askFirstOff: "A person turns this off",
} as const;

// A driver that attached to a document already parsing stamps it late and
// announces it with the event, so a mounted control re-reads then.
function subscribe(onChange: () => void) {
  document.addEventListener(AGENT_TAB_EVENT, onChange);
  return () => document.removeEventListener(AGENT_TAB_EVENT, onChange);
}

export function useAgentDrivenTab(): boolean {
  return useSyncExternalStore(subscribe, isAgentDrivenTab, () => false);
}

/** Why option `index` of `decision` is held in an agent's tab, else undefined. */
export function heldOption(decision: { category?: string; options: readonly { label: string }[] }, index: number, agentTab: boolean): string | undefined {
  return agentTab && approvesSecretRead(decision, index) ? PERSON_ONLY.approve : undefined;
}

/** heldOption for this tab, as a per-position reader for an option list. */
export function useHeldOption(decision: { category?: string; options: readonly { label: string }[] } | undefined): (index: number) => string | undefined {
  const agentTab = useAgentDrivenTab();
  return useCallback((index: number) => (decision ? heldOption(decision, index, agentTab) : undefined), [decision, agentTab]);
}
