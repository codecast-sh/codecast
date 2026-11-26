// A link from outside the app that opens a NEW session's composer with a
// draft already typed (`/inbox?compose=<text>[&task=ct-N][&agent=…][&project=…]
// [&priority=pri-N[&step=<key>]][&plan=pl-N]`),
// ready to edit or send. Nothing is ever sent by the link: the person presses
// Enter. A day view, a doc or a bookmark builds these; every value is untrusted
// text from whoever wrote the link, so each one either resolves to something
// the viewer could have picked by hand or is dropped, and the composer still
// opens with the draft.
//
// An existing session takes the same `compose` param
// (`/conversation/<id>?compose=<text>`, conversationLinkDraft below): text to
// continue, where `?prefill=` (lib/composerPrefill) quotes its text for a
// notification reply.

import { fromConvexAgentType, toConvexAgentType, type ConvexAgentType } from "@codecast/shared/contracts";
import { PREFILL_MAX_LENGTH, buildPrefillText, type ComposerSeed } from "./composerPrefill";

export const COMPOSE_LINK_PARAMS = ["compose", "task", "agent", "project", "priority", "step", "plan"] as const;

export type ComposeLink = {
  /** The text the composer opens with, as written (capped, controls stripped). */
  draft: string;
  /** A task short id (`ct-…`), lowercased; resolved against the viewer's access later. */
  task?: string;
  agent?: ConvexAgentType;
  /** A folder path or a project name; resolved against the viewer's machines later. */
  project?: string;
  /** A priority (`pri-…`) and one of its milestones' keys: the session is mapped to it when created, if the priority is the viewer's (server: linkFromStart). */
  priority?: string;
  step?: string;
  /** A plan (`pl-…`) the session is bound to when created, if the viewer can open it. */
  plan?: string;
};

/** What a compose link starts the session in, beside its draft. */
export type ComposeLinkStart = Pick<ComposeLink, "task" | "priority" | "step" | "plan">;

const LEADING_BANG = /^[\s!]+/;
const TASK_SHORT_ID = /^ct-[a-z0-9]{1,32}$/;
const PRIORITY_SHORT_ID = /^pri-[a-z0-9]{1,32}$/;
const STEP_KEY = /^[a-z0-9_-]{1,32}$/;
const PLAN_SHORT_ID = /^pl-[a-z0-9]{1,32}$/;
const PROJECT_MAX_LENGTH = 512;
// C0 and C1 controls and DEL, except tab and newline: they only reach a
// textarea's value, but a NUL or an escape sequence is never part of a draft
// worth keeping.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Characters that draw nothing, which can carry text the person cannot see to
// the agent that reads the message they send: every default-ignorable code
// point (format characters, the tag block, variation selectors, fillers, the
// unassigned rest of plane 14), and the few blank-drawing format characters
// Unicode leaves out of that set (braille blank, Egyptian format controls,
// interlinear annotation marks, the object replacement character, the null
// notehead). Joiners and the two emoji
// selectors are judged by what they follow instead (dropStrayMarks).
const IGNORABLE = /(?!\u200c|\u200d|\ufe0e|\ufe0f)\p{Default_Ignorable_Code_Point}|[\u2800\ufff9-\ufffc\u{13430}-\u{1343f}\u{1d159}]/gu;
// Private-use and unassigned code points: no font this text will meet draws
// them as words, and some draw as nothing at all (Apple's U+F860 family, the
// unassigned Mongolian and Thai slots) or shift the text after them.
const UNDRAWABLE = /[\p{Co}\p{Cn}]/gu;
// What a joiner may follow: a letter or mark of a script that joins with it,
// an emoji, a skin tone, or an emoji selector. After anything else, Latin
// included, a joiner only hides a bit.
const JOINER_BASE = /[\p{sc=Arabic}\p{sc=Syriac}\p{sc=Thaana}\p{sc=Nko}\p{sc=Hebrew}\p{sc=Devanagari}\p{sc=Bengali}\p{sc=Gurmukhi}\p{sc=Gujarati}\p{sc=Oriya}\p{sc=Tamil}\p{sc=Telugu}\p{sc=Kannada}\p{sc=Malayalam}\p{sc=Sinhala}\p{sc=Myanmar}\p{sc=Khmer}\p{sc=Tibetan}\p{sc=Mongolian}\p{sc=Javanese}\p{sc=Balinese}\p{sc=Adlam}\p{sc=Mandaic}\p{sc=Hanifi_Rohingya}\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f]/u;
// What an emoji selector (FE0E, FE0F) may follow: a pictograph, or a digit,
// # or * that the keycap mark (U+20E3) completes.
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const KEYCAP_BASE = /[0-9#*]/;
const KEYCAP = "\u20e3";
const MARK = /\p{M}/u;
// Nonspacing and enclosing marks: more than eight on one letter is a pile
// that draws over the text around it. Spacing marks (Burmese, Tibetan)
// stack in ordinary words and never count.
const PILING_MARK = /[\p{Mn}\p{Me}]/u;
const PILE_MAX = 8;
// A blank other than the plain space and tab (no-break, wide, ideographic):
// one plain space for each. A run of plain spaces hangs at the end of a line
// in the box; a run of no-break spaces wraps into lines that look empty.
const ODD_BLANK = /[^\S\n\t ]/g;
// Sixteen or more blanks after text on a line: they wrap into lines that look
// empty and push the words after them out of the box. Indentation at the start
// of a line is left alone.
const MIDLINE_BLANKS = /(?<=\S)[^\S\n]{16,}/g;
// A line holding no letter, number, punctuation or symbol looks empty
// whatever it is made of. Two in a row are kept as written (code puts two
// blank lines between definitions; a patch's blank context line is a space);
// more fold away: a short draft could otherwise push text out of the box,
// out of sight of the person about to press Enter.
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
const BLANK_LINES_MAX = 2;

function foldBlankLines(text: string): string {
  const out: string[] = [];
  let blanks = 0;
  for (const line of text.split("\n")) {
    blanks = VISIBLE.test(line) ? 0 : blanks + 1;
    if (blanks <= BLANK_LINES_MAX) out.push(line);
  }
  return out.join("\n");
}

/** What may sit on a letter, judged per letter against what was kept: one
 *  joiner, only after a character it belongs to (a mark is read through to
 *  the letter under it); an emoji selector only right after a pictograph or
 *  a keycap's digit; at most PILE_MAX nonspacing marks. A run of any of them
 *  keeps no more than that, however it is interleaved. A loop, not a
 *  lookbehind: JavaScriptCore's lookbehind misreads a character outside the
 *  BMP (every emoji) before the mark. */
function dropStrayMarks(text: string): string {
  const chars = Array.from(text);
  const out: string[] = [];
  let letter: string | undefined; // the last kept character that is not a mark
  let joined = false; // a joiner kept since that letter
  let piled = 0; // nonspacing marks kept on that letter
  chars.forEach((ch, i) => {
    const prev = out[out.length - 1];
    if (ch === "\u200c" || ch === "\u200d") {
      const base = prev && MARK.test(prev) && !JOINER_BASE.test(prev) ? letter : prev;
      if (joined || !base || !JOINER_BASE.test(base)) return;
      joined = true;
    } else if (ch === "\ufe0e" || ch === "\ufe0f") {
      const keycap = !!prev && KEYCAP_BASE.test(prev) && chars[i + 1] === KEYCAP;
      if (!prev || !(PICTOGRAPH.test(prev) || keycap)) return;
    } else if (PILING_MARK.test(ch)) {
      if (++piled > PILE_MAX) return;
    } else if (!MARK.test(ch)) {
      letter = ch;
      joined = false;
      piled = 0;
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
    .replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(IGNORABLE, "")
    .replace(UNDRAWABLE, ""))
    .replace(ODD_BLANK, " ")
    .replace(MIDLINE_BLANKS, " ");
  return clip(foldBlankLines(plain), max);
}

/** An agent the registry knows, in either spelling (`claude` or `claude_code`). */
function knownAgent(raw: string | null): ConvexAgentType | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  const id = fromConvexAgentType(v);
  const convex = toConvexAgentType(id);
  return v === id || v === convex ? convex : undefined;
}

/** A link's draft as plain text, capped. No leading "!": an agent that takes
 *  typed keys (Gemini's CLI) reads "!" in an empty input as its shell, and the
 *  line would run as a command. Leading blanks and line breaks go with it: the
 *  composer trims them on send, which would put the "!" first again. */
function cleanDraft(raw: string): string {
  return cleanText(raw, PREFILL_MAX_LENGTH).replace(LEADING_BANG, "");
}

/** What a link into an existing session (`/conversation/<id>`) puts in its
 *  composer: `prefill` quoted, then `compose` as text to continue. The quote
 *  only fills an empty composer; text to continue also goes under a draft
 *  already there (seedComposer). Null when the link carries neither. */
export function conversationLinkDraft(prefill: string | null, compose: string | null): ComposerSeed | null {
  const fill = buildPrefillText(prefill) ?? "";
  const add = compose ? cleanDraft(compose) : "";
  return fill || add ? { fill, add } : null;
}

/** The link's parameters, or null when the address carries no compose link.
 *  A repeated parameter takes its first value. A task alone is a link too. */
export function parseComposeLink(params: Pick<URLSearchParams, "get" | "has">): ComposeLink | null {
  const id = (name: string, shape: RegExp) => {
    const raw = params.get(name)?.trim().toLowerCase();
    return raw && shape.test(raw) ? raw : undefined;
  };
  const task = id("task", TASK_SHORT_ID);
  if (!params.has("compose") && !task) return null;
  const draft = cleanDraft(params.get("compose") ?? "");
  const agent = knownAgent(params.get("agent"));
  const project = cleanText(params.get("project") ?? "", PROJECT_MAX_LENGTH).replace(/\s+/g, " ").trim() || undefined;
  const priority = id("priority", PRIORITY_SHORT_ID);
  // A step means nothing without its priority.
  const step = priority ? id("step", STEP_KEY) : undefined;
  const plan = id("plan", PLAN_SHORT_ID);
  return {
    draft, ...(task ? { task } : {}), ...(agent ? { agent } : {}), ...(project ? { project } : {}),
    ...(priority ? { priority } : {}), ...(step ? { step } : {}), ...(plan ? { plan } : {}),
  };
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

/** The address that opens a new session's composer with `draft` typed, and
 *  what it starts in (a task, a priority's milestone, a plan): the link
 *  parseComposeLink reads. */
export function composeLinkHref(draft: string, start: ComposeLinkStart = {}): string {
  const sp = new URLSearchParams({ compose: draft });
  for (const k of ["task", "priority", "step", "plan"] as const) {
    const v = start[k];
    if (v) sp.set(k, v);
  }
  return `/inbox?${sp.toString()}`;
}

/** The address with the link's parameters taken out, so a reload or Back
 *  never opens a second composer. */
export function stripComposeLink(pathname: string, search: string): string {
  const sp = new URLSearchParams(search);
  for (const k of COMPOSE_LINK_PARAMS) sp.delete(k);
  const rest = sp.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
