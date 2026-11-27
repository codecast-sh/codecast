// Codecast's registered marks: every glyph of its own icon language, each with
// a name and a meaning. Pure data; the glyphs themselves are whatever the page
// draws inside <Mark id> (components/Mark.tsx), which the icon legend reads.
import { changeMarks } from "./changes";
import { inboxMarks } from "./inbox";
import { priorityMarks } from "./priorities";
import { sessionMarks } from "./sessions";
import type { MarkDef, MarkGroup } from "./types";
import { workMarks } from "./work";

export type { MarkDef, MarkGroup } from "./types";

export const MARKS: readonly MarkDef[] = [...changeMarks, ...sessionMarks, ...inboxMarks, ...priorityMarks, ...workMarks];

export const MARK_BY_ID: ReadonlyMap<string, MarkDef> = new Map(MARKS.map((m) => [m.id, m]));

/** The legend's group order, when no surface asks for its own group first. */
export const GROUP_ORDER: readonly MarkGroup[] = ["Priorities pass", "Sessions", "Inbox", "Priorities", "Work"];
