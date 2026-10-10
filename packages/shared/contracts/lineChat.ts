// A conversation with a project's line (docs/architecture/line-workspace.md
// LW1 Chat, LW4): the person's words reach the session that answers for the
// line on the ordinary pending message rail, in a <line-chat> frame, and that
// session's replies render in the workspace's chat. Replies carry live
// widgets as ```line fenced blocks; the widgets and what each needs are
// defined once here, read by the web's fence reader (lib/line/lineFence.ts)
// and written into the brief the answering session reads.
import { stripInjectionNoise } from "./machineMessages";

// ── the `line` fence ─────────────────────────────────────────────────────────

export const LINE_FENCE_LANG = "line";

export const LINE_WIDGETS = ["graph", "step", "prompt", "diff", "decision", "decisions", "before-after", "run", "problem"] as const;
export type LineWidgetKind = (typeof LINE_WIDGETS)[number];

/** The spec fields a widget cannot draw without. */
export const LINE_WIDGET_NEEDS: Record<LineWidgetKind, ReadonlyArray<"step" | "run" | "after" | "rows" | "case">> = {
  graph: [],
  step: ["step"],
  prompt: ["step"],
  diff: ["step", "after"],
  decision: ["step", "run"],
  decisions: ["step"],
  "before-after": ["step", "rows"],
  run: ["run"],
  problem: ["case"],
};

/** What each widget shows, and the optional fields it reads, as an agent writing one needs to know it. */
const LINE_WIDGET_WORDS: Record<LineWidgetKind, string> = {
  graph: "the line's steps as a graph; `run` lights one run's path, `step` marks one step",
  step: "one step: who does it, its job, where it sends work and how often, its recent decisions",
  prompt: "a step's prompt as it reads today, shared sections folded",
  diff: "a proposed change to a step's prompt: `after` is the whole new text, `before` defaults to today's",
  decision: "what one step received and decided on one run, with its reasoning",
  decisions: "a step's decisions as a list; `limit` and `outcome` narrow it",
  "before-after": "a table of cases: `rows` is [{case, before, after, ref?}], what the step said and what it says now",
  run: "one run's path through the line, step by step",
  problem: "one cause over time (`case` is its task id or ref): how often it happened, every earlier attempt and how it ended (dissolved, dropped, shipped), what came back after each, and what was already tried",
};

/**
 * The fence's vocabulary for an agent writing replies: one line per widget,
 * the fields every spec carries, and the project and graph to name. Written
 * from the catalog above, so the brief and the reader cannot disagree.
 */
export function lineFenceGuide(project: string, graph: string | null): string {
  const base = graph ? `"project":"${project}","graph":"${graph}"` : `"project":"${project}"`;
  const lines = LINE_WIDGETS.map((w) => {
    const needs = LINE_WIDGET_NEEDS[w].map((k) => `"${k}"`).join(", ");
    return `- \`${w}\`${needs ? ` (needs ${needs})` : ""}: ${LINE_WIDGET_WORDS[w]}`;
  });
  return [
    "A fenced block in the language `line` holding one JSON object draws a live widget from the line itself, wherever your reply renders:",
    "",
    "```line",
    `{"widget":"step",${base},"step":"<step id>"}`,
    "```",
    "",
    "Every spec names `widget` and `project`; `graph` picks the graph when the project runs several, and `title` gives a widget its own heading. Steps are named by their node id in the graph, runs by their id.",
    ...lines,
  ].join("\n");
}

/** The fence in one sentence, for a frame about the line that is not a chat (a line decision's discussion). */
export function lineFenceHint(project: string): string {
  const widgets = LINE_WIDGETS.map((w) => (LINE_WIDGET_NEEDS[w].length ? `${w} (${LINE_WIDGET_NEEDS[w].join(", ")})` : w)).join(", ");
  return `Your reply can draw live widgets of this line: a \`\`\`line fenced block holding JSON such as {"widget":"step","project":"${project}","step":"<step id>"}; widgets and what each needs: ${widgets}.`;
}

// ── the <line-chat> frame ────────────────────────────────────────────────────

export const LINE_CHAT_TAG = "line-chat";
const BRIEF_OPEN = "<line-chat-brief>";
const BRIEF_CLOSE = "</line-chat-brief>";
const TAIL_LEAD = "(A message from the line workspace's chat";
const FOCUS_LEAD = "Looking at";

const attrSafe = (x: string) => x.replace(/"/g, "'").replace(/\s*\r?\n\s*/g, " ");

/**
 * A person's words to the session that answers for a project's line. `brief`
 * rides the first message an answering session receives from one chat: what
 * the line is, where its record lives, and how a reply can draw widgets. The
 * tail reminds every turn where the reply lands.
 */
export function formatLineChat(o: { project: string; graph: string | null; from: string; body: string; brief?: string | null; focus?: string | null }): string {
  const graph = o.graph ? ` graph="${attrSafe(o.graph)}"` : "";
  const brief = o.brief?.trim() ? `${BRIEF_OPEN}\n${o.brief.trim()}\n${BRIEF_CLOSE}\n\n` : "";
  // What the person has open in the workspace, ahead of their words: the
  // reply is matched by the words' ending, so a lead-in never breaks that.
  const focus = o.focus?.trim() ? `${FOCUS_LEAD} ${o.focus.trim()}.\n\n` : "";
  const tail = `${TAIL_LEAD}: ${attrSafe(o.from)} reads your reply there, rendered as markdown, so a \`\`\`line block draws a live widget.)`;
  return `<${LINE_CHAT_TAG} project="${attrSafe(o.project)}"${graph} from="${attrSafe(o.from)}">\n${brief}${focus}${o.body}\n\n${tail}\n</${LINE_CHAT_TAG}>`;
}

/** The person's words out of a frame, with the brief, what they had open and the tail left out; null for anything else. */
export function parseLineChat(rawContent: string | null | undefined): { project: string; graph: string | null; from: string; body: string; focus: string | null; briefed: boolean } | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  const m = text.match(/^<line-chat\s+([^>]*)>([\s\S]*?)(?:<\/line-chat>\s*$|$)/);
  if (!m) return null;
  const attr = (k: string) => { const a = m[1].match(new RegExp(`\\b${k}="([^"]*)"`)); return a ? a[1] : ""; };
  let body = m[2];
  const open = body.indexOf(BRIEF_OPEN);
  const close = body.indexOf(BRIEF_CLOSE);
  const briefed = open >= 0 && close > open;
  if (briefed) body = body.slice(close + BRIEF_CLOSE.length);
  const tail = body.lastIndexOf(TAIL_LEAD);
  if (tail >= 0) body = body.slice(0, tail);
  // What they had open rides ahead of their words, a paragraph of its own (formatLineChat).
  let focus: string | null = null;
  body = body.trim();
  // An injection that collapsed the newlines leaves the paragraph break as two spaces.
  const lead = body.startsWith(`${FOCUS_LEAD} `) ? /^\S+ \S+ ([\s\S]+?)\.(?:\n\n|\s{2,})/.exec(body) : null;
  if (lead) { focus = lead[1].trim(); body = body.slice(lead[0].length); }
  return { project: attr("project"), graph: attr("graph") || null, from: attr("from").trim(), body: body.trim(), focus, briefed };
}
