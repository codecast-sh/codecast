import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Source guards for the new-session page's default (Alex, 2026-11-07): the
// message box, and under it one quiet line, "in <folder> · <agent> ·
// <machine>", each part opening its existing picker; effort, where it runs,
// context and label behind Options. No headline, no folder chip row.
const source = readFileSync(new URL("./sessionControls.tsx", import.meta.url), "utf8");
const slice = (from: string, to: string) => {
  const a = source.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = source.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
};

test("no headline over the composer", () => {
  expect(source).not.toContain("What should we build");
  expect(source).not.toMatch(/<ProjectSwitcher[^>]*\bheadline\b/);
});

test("the page's line: folder, agent and machine parts, then Options; nothing portaled into the composer foot", () => {
  const page = slice("  if (slots) {", "  // Project picker sits up top");
  expect(page).toContain("folderSlot={folderSlot} noteSlot={noteSlot} modeSlot={modeSlot}");
  expect(page).not.toContain("slots.foot &&");
  const line = slice("data-new-session-line", "slots.below,");
  // In the order the line reads.
  const order = ["setFolderSlot", "agentSwitcher(true, true)", "setMachineSlot", "setNoteSlot", "<NewSessionNotes", "<NewSessionOptions"];
  const at = order.map((s) => line.indexOf(s));
  expect(at.every((i) => i > -1)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});

test("Options holds the existing controls unchanged, and the line names any set away from its default", () => {
  const options = slice("function NewSessionOptions(", "/** The hosted assistant's intro");
  for (const control of ["<LaunchEffortPill", "ref={modeSlotRef}", "<AgentDefinitionPill", "<NewSessionBucketPill", "<StableContextPicker"]) {
    expect(options).toContain(control);
  }
  const notes = slice("function NewSessionNotes(", "function NewSessionOptions(");
  for (const note of ["effortNote(effort)", "contextNote(contextMode)", "`as ${definition}`", "assigned?.name"]) {
    expect(notes).toContain(note);
  }
  // Where it runs is ProjectSwitcher's note, from the same props its menu reads.
  expect(source).toContain("sessionPlacementNotes(modeProps)");
});

test("on the line the folder chip row rests hidden: the folder search opens only while picking", () => {
  expect(source).toContain("{(!inLine || picking) && <div");
  // A label chip still files a pre-warmed blank while the pill sits closed in Options.
  expect(slice("function NewSessionNotes(", "function NewSessionOptions(")).toContain("useNewSessionBucket(convId)");
});
