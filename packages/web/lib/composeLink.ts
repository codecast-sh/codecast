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
// C0 controls and DEL, except tab and newline: they only reach a textarea's
// value, but a NUL or an escape sequence is never part of a draft worth keeping.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
// Characters that draw nothing: bidi overrides, zero-width marks and the tag
// block, which can carry text the person cannot see to the agent that reads
// the message they send. The zero-width joiner stays: emoji are built with it.
const INVISIBLE_CHARS = /(?!\u200d)\p{Cf}/gu;

function cleanText(raw: string, max: number): string {
  return raw
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "")
    .slice(0, max);
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
  if (draft.toLowerCase().includes(shortId)) return draft;
  const tail = ` ${shortId} `;
  return `${draft.trimEnd().slice(0, PREFILL_MAX_LENGTH - tail.length)}${tail}`;
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
