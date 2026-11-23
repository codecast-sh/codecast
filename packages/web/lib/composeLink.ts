// A link from outside the app that opens a NEW session's composer with a
// draft already typed (`/inbox?compose=<text>[&task=ct-N][&agent=…][&project=…]`),
// ready to edit or send. Nothing is ever sent by the link: the person presses
// Enter. A day view, a doc or a bookmark builds these; every value is untrusted
// text from whoever wrote the link, so each one either resolves to something
// the viewer could have picked by hand or is dropped, and the composer still
// opens with the draft.
//
// `?prefill=` (lib/composerPrefill) is the existing-session sibling: it quotes
// its text for a notification reply. This one types the text as written.

import { fromConvexAgentType, toConvexAgentType, type ConvexAgentType } from "@codecast/shared/contracts";
import { PREFILL_MAX_LENGTH } from "./composerPrefill";

export const COMPOSE_LINK_PARAMS = ["compose", "task", "agent", "project"] as const;

export type ComposeLink = {
  /** The text the composer opens with, as written (capped, controls stripped). */
  draft: string;
  /** A task short id (`ct-…`), lowercased; resolved against the viewer's access later. */
  task?: string;
  agent?: ConvexAgentType;
  /** A folder path or a project name; resolved against the viewer's machines later. */
  project?: string;
};

const TASK_SHORT_ID = /^ct-[a-z0-9]{1,32}$/;
const PROJECT_MAX_LENGTH = 512;
// C0 and C1 controls and DEL, except tab and newline: they only reach a
// textarea's value, but a NUL or an escape sequence is never part of a draft
// worth keeping.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Characters that draw nothing, which can carry text the person cannot see to
// the agent that reads the message they send: every default-ignorable code
// point (format characters, the tag block, variation selectors, fillers, the
// unassigned rest of plane 14), and the few blank-drawing format characters
// Unicode leaves out of that set (braille blank, Egyptian format controls,
// interlinear annotation marks, the object replacement character, the null
// notehead). Joiners and the two emoji
// selectors are judged by what they follow instead (dropStrayMarks).
const IGNORABLE = /(?![\u200c\u200d\ufe0e\ufe0f])\p{Default_Ignorable_Code_Point}|[\u2800\ufff9-\ufffc\u{13430}-\u{1343f}\u{1d159}]/gu;
// What a joiner may follow: a letter or mark of a script that joins with it,
// an emoji, a skin tone, or an emoji selector. After anything else, Latin
// included, a joiner only hides a bit.
const JOINER_BASE = /[\p{sc=Arabic}\p{sc=Syriac}\p{sc=Thaana}\p{sc=Nko}\p{sc=Hebrew}\p{sc=Devanagari}\p{sc=Bengali}\p{sc=Gurmukhi}\p{sc=Gujarati}\p{sc=Oriya}\p{sc=Tamil}\p{sc=Telugu}\p{sc=Kannada}\p{sc=Malayalam}\p{sc=Sinhala}\p{sc=Myanmar}\p{sc=Khmer}\p{sc=Tibetan}\p{sc=Mongolian}\p{sc=Javanese}\p{sc=Balinese}\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f]/u;
// What an emoji selector (FE0E, FE0F) may follow: a pictograph, or a digit,
// # or * that the keycap mark (U+20E3) completes.
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const KEYCAP_BASE = /[0-9#*]/;
const KEYCAP = "\u20e3";
const MARK = /\p{M}/u;
// More than eight nonspacing or enclosing marks on one character: a pile
// that draws over the text around it. Spacing marks (Burmese, Tibetan)
// stack in ordinary words and never count.
const MARK_PILES = /([\p{Mn}\p{Me}]{8})[\p{Mn}\p{Me}]+/gu;
// A run of blanks other than the plain space and tab: one no-break or wide
// space draws like a space, a run of them wraps into lines that look empty.
const BLANK_PILES = /[^\S\n\t ]{2,}/g;
// Three or more line breaks in a row, with only blanks of any kind between
// them: a short draft could push a line below the box's edge, out of sight
// of the person about to press Enter.
const BLANK_RUNS = /\n[^\S\n]*\n(?:[^\S\n]*\n)+/g;

/** Joiners and emoji selectors kept only right after a character they
 *  belong to, judged against what was kept (a mark is read through to the
 *  letter it sits on), so a run keeps at most its first. A loop, not a
 *  lookbehind: JavaScriptCore's lookbehind misreads a character outside
 *  the BMP (every emoji) before the mark. */
function dropStrayMarks(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  let letter: string | undefined; // the last kept character that is not a mark
  chars.forEach((ch, i) => {
    const prev = out[out.length - 1];
    if (ch === "\u200c" || ch === "\u200d") {
      const base = prev && MARK.test(prev) && !JOINER_BASE.test(prev) ? letter : prev;
      if (!base || !JOINER_BASE.test(base)) return;
    } else if (ch === "\ufe0e" || ch === "\ufe0f") {
      const keycap = !!prev && KEYCAP_BASE.test(prev) && chars[i + 1] === KEYCAP;
      if (!prev || !(PICTOGRAPH.test(prev) || keycap)) return;
    } else if (!MARK.test(ch)) {
      letter = ch;
    }
    out.push(ch);
  });
  return out.join("");
}

/** The first `max` UTF-16 units, never ending on half of an emoji. */
function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function cleanText(raw: string, max: number): string {
  // Marks go before the fold: a line of stray marks is a blank line once
  // they are gone.
  const plain = dropStrayMarks(raw
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(IGNORABLE, ""))
    .replace(MARK_PILES, "$1")
    .replace(BLANK_PILES, (run) => run[0]);
  return clip(plain.replace(BLANK_RUNS, "\n\n"), max);
}

/** An agent the registry knows, in either spelling (`claude` or `claude_code`). */
function knownAgent(raw: string | null): ConvexAgentType | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  const id = fromConvexAgentType(v);
  const convex = toConvexAgentType(id);
  return v === id || v === convex ? convex : undefined;
}

/** The link's parameters, or null when the address carries no compose link.
 *  A repeated parameter takes its first value. A task alone is a link too. */
export function parseComposeLink(params: Pick<URLSearchParams, "get" | "has">): ComposeLink | null {
  const rawTask = params.get("task")?.trim().toLowerCase();
  const task = rawTask && TASK_SHORT_ID.test(rawTask) ? rawTask : undefined;
  if (!params.has("compose") && !task) return null;
  const draft = cleanText(params.get("compose") ?? "", PREFILL_MAX_LENGTH);
  const agent = knownAgent(params.get("agent"));
  const project = cleanText(params.get("project") ?? "", PROJECT_MAX_LENGTH).replace(/\s+/g, " ").trim() || undefined;
  return { draft, ...(task ? { task } : {}), ...(agent ? { agent } : {}), ...(project ? { project } : {}) };
}

/** The draft with the task named in it: a task-only link reads like the task
 *  list's own start ("Let's do this task ct-N"); a draft that does not mention
 *  the task gets its id appended, so the first message says which task. Only
 *  called once the task resolved for the viewer. */
export function draftForTask(draft: string, shortId: string): string {
  if (!draft.trim()) return `Let's do this task ${shortId} `;
  // The id as a word: "ct-993591" does not name ct-99359.
  if (new RegExp(`(^|[^a-z0-9-])${shortId}(?![a-z0-9])`, "i").test(draft)) return draft;
  const tail = ` ${shortId} `;
  return `${clip(draft.trimEnd(), PREFILL_MAX_LENGTH - tail.length)}${tail}`;
}

/** A link's project, as a folder one of the viewer's machines can start in,
 *  or undefined when it names nothing they have. A path matches a known folder
 *  or sits inside one; a bare name matches a project by its folder name. */
export function resolveLinkProject(
  project: string | undefined,
  known: { paths: string[]; byName: (name: string) => string | undefined },
): string | undefined {
  if (!project) return undefined;
  if (!project.startsWith("/")) return project.includes("/") ? undefined : known.byName(project);
  const path = project.replace(/\/+$/, "") || "/";
  if (path.split("/").includes("..")) return undefined;
  return known.paths.some((k) => {
    const root = k.replace(/\/+$/, "");
    return !!root && (path === root || path.startsWith(`${root}/`));
  }) ? path : undefined;
}

/** The address with the link's parameters taken out, so a reload or Back
 *  never opens a second composer. */
export function stripComposeLink(pathname: string, search: string): string {
  const sp = new URLSearchParams(search);
  for (const k of COMPOSE_LINK_PARAMS) sp.delete(k);
  const rest = sp.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
