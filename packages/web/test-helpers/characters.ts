// Characters (show_characters) defaults off (lib/uiPrefDefaults.ts). A test
// about how a personified session or a role's character reads turns it on
// first, on top of whatever ui the test already seeded.
import { useInboxStore } from "../store/inboxStore";

export function setCharacters(on: boolean): void {
  useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { ...s.clientState?.ui, show_characters: on } } }) as never);
}
