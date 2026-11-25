// The rows of the "who said this" picker, in the order both apps list them
// (packages/shared/contracts/speakerTurns.ts): teammates, this recording's
// voices, Someone else, Unknown. Pure, so the order and the filter are tested
// without a DOM.
import { speakerNameMatches, type SpeakerChip, type SpeakerChoice, type WireCallSpeaker } from "@codecast/shared/contracts";
import type { SpeakerPickTarget } from "./speakerContext";

import type { PickerPerson } from "./speakerRoster";
export type { PickerPerson };

export type SpeakerPickerItem = {
  id: string;
  section: "confirm" | "team" | "recording" | "other";
  label: string;
  /** null: "Someone else" with nothing typed yet; Enter puts the caret in the box. */
  choice: SpeakerChoice | null;
  /** "Yes, it's <name>": confirms the voice match instead of choosing. */
  confirm?: true;
  person?: PickerPerson;
  /** A voice of this recording: its key, for its color. */
  voice?: string;
  current: boolean;
};

export function speakerPickerItems({
  target,
  query,
  people,
  chips,
  speakers,
}: {
  target: SpeakerPickTarget;
  query: string;
  people: ReadonlyArray<PickerPerson>;
  chips: ReadonlyArray<SpeakerChip>;
  speakers: ReadonlyArray<WireCallSpeaker> | undefined;
}): SpeakerPickerItem[] {
  const line = target.kind === "line";
  // The voice the picker was opened on: for a line, the one it is in now.
  const entry = speakers?.find((s) => s.key === target.key);
  const items: SpeakerPickerItem[] = [];
  const suggested = !line && !query.trim() ? chips.find((c) => c.key === target.key && c.suggested) : undefined;
  if (suggested) items.push({ id: "yes", section: "confirm", label: `Yes, it's ${suggested.name}`, choice: null, confirm: true, current: false });
  for (const p of people) {
    if (!speakerNameMatches(p.name, query)) continue;
    items.push({
      id: `u:${p._id}`,
      section: "team",
      label: p.name || "Teammate",
      choice: { user_id: p._id },
      person: p,
      current: entry?.user_id === p._id,
    });
  }
  // A voice: in a move, the line joins it; in an assignment, a typed name
  // another voice already has is offered again. A teammate's voice is the
  // teammate's row above, never listed twice.
  const seen = new Set<string>();
  for (const c of chips) {
    if (!speakerNameMatches(c.name, query)) continue;
    if (line) {
      if (c.user_id) continue;
      items.push({ id: `k:${c.key}`, section: "recording", label: c.name, choice: { key: c.key }, voice: c.key, current: c.key === target.key });
      continue;
    }
    if (c.key === target.key || c.user_id) continue;
    const name = speakers?.find((s) => s.key === c.key)?.name;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    items.push({ id: `k:${c.key}`, section: "recording", label: name, choice: { name }, voice: c.key, current: entry?.name === name && !entry?.user_id });
  }
  const typed = query.trim();
  items.push({ id: "else", section: "other", label: typed ? `“${typed}”` : "Someone else", choice: typed ? { name: typed } : null, current: false });
  items.push({
    id: "unknown",
    section: "other",
    label: "Unknown",
    choice: { clear: true },
    current: !line && !!entry && !entry.user_id && !entry.name,
  });
  return items;
}
