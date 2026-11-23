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
// the agent that reads the message they send: format characters (bidi
// overrides, zero-width marks, the tag block), supplementary variation
// selectors, and blank fillers (Hangul, braille, the grapheme joiner).
const INVISIBLE_CHARS = /(?![‌‍])\p{Cf}|[\u{E0100}-\u{E01EF}͏ᅟᅠ⠀ㅤﾠ]/gu;
// The joiners and variation selectors real text needs (emoji, Persian) sit
// right after a character that draws. Anywhere else, or in a run, they only
// hide bytes, so they go: a joiner after a space or another mark, a selector
// after anything but a drawn character. Repeated until stable, since each
// removal can strand the next mark. Two passes, never one alternation:
// JavaScriptCore mismatches lookarounds across alternatives.
const STRAY_JOINER = /(?<![^\s‌‍︀-︎])[‌‍]/g;
const STRAY_SELECTOR = /(?<![^\s‌‍︀-️])[︀-️]/g;
// Three or more line breaks in a row: a short draft could push a line below
// the box's edge, out of sight of the person about to press Enter.
const BLANK_RUNS = /\n[ \t]*\n(?:[ \t]*\n)+/g;

function dropStrayMarks(text: string): string {
  for (;;) {
    const next = text.replace(STRAY_JOINER, "").replace(STRAY_SELECTOR, "");
    if (next === text) return text;
    text = next;
  }
}

/** The first `max` UTF-16 units, never ending on half of an emoji. */
function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function cleanText(raw: string, max: number): string {
  const plain = raw
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "")
    .replace(BLANK_RUNS, "\n\n");
  return clip(dropStrayMarks(plain), max);
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
