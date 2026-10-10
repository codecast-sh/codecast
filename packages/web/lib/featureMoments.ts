// Moments in a conversation where an agent feature that is off would have
// done better, read from what is already on screen: no model call. Each
// detector names the feature and a sentence about THIS moment; the thread
// shows at most one such offer (pickFeatureMoment), and the offer itself only
// appears to someone whose machines all have that feature off
// (components/agentFeatures/useFeatureOffer).

export type MomentFeature = "decide" | "visual" | "publish";

/** What made the case: the agent working around a missing feature, or another
 *  agent's output showing what the feature makes. */
export type MomentKind = "missing" | "shown";

export interface FeatureMoment {
  slug: MomentFeature;
  kind: MomentKind;
  reason: string;
}

const SHOWN: Partial<Record<MomentFeature, string>> = {
  visual: "Made with Visual Canvas, which is off on your machines.",
  publish: "Made with Publish, which is off on your machines.",
};

const REASONS: Record<MomentFeature, string> = {
  decide:
    "Decision queue would park this in one queue while the agent keeps working.",
  visual: "Visual Canvas would draw this as a real chart.",
  publish: "Publish would give that page a link that opens here.",
};

/** Fenced code blocks, except cast-canvas ones (those are already visuals). */
function codeBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1].trim() !== "cast-canvas") out.push(m[2]);
  }
  return out;
}

function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

const CHART_CHARS = /[█▇▆▅▄▃▂▁▏▎▍▌▋▊▉░▒▓■□▪●○◆─│┌┐└┘├┤┬┴┼═║╔╗╚╝╭╮╯╰]/;

/** A chart or diagram drawn in characters: three or more lines of block or
 *  box-drawing glyphs inside a code block. A lone separator line is not one. */
export function hasTextChart(text: string): boolean {
  return codeBlocks(text).some((block) => block.split("\n").filter((l) => CHART_CHARS.test(l)).length >= 3);
}

const LOCAL_HTML = /(^|[\s(`'"<])(file:\/\/)?(~|\.{1,2})?\/[^\s`'")<>]*\.html?(?=$|[\s`'")<>.,:;!?])/im;

/** Points at an HTML file on disk (`/tmp/report.html`, `file://…`, `./out/index.html`)
 *  rather than at a URL someone else could open. */
export function hasLocalHtmlPath(text: string): boolean {
  return LOCAL_HTML.test(text.replace(/https?:\/\/\S+/g, ""));
}

function proseLines(text: string): string[] {
  return withoutCode(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Ends by asking the human something: the last line of prose is a question. */
export function endsWithQuestion(text: string): boolean {
  const lines = proseLines(text);
  return /\?[*_)"'”]*$/.test(lines[lines.length - 1] ?? "");
}

/** Two or more lines that open as labelled options: (a) (b), a) b), 1. 2., Option A. */
const OPTION_LINE = /^(?:[-*]\s*)?(?:\*\*)?(?:\(?[a-e]\)|\(?[1-5][.)]|option\s+[a-e1-5]\b)/i;

/** "X or Y?": two alternatives in the question itself, not a yes/no with a
 *  trailing escape ("…or not?", "…or something else?"). */
const TWO_ALTERNATIVES = /\S\s+or\s+(?!not\b|something\b|anything\b|else\b|other\b|should i\b|do you\b|would you\b)\S/i;

/** Asking for permission or a check-in, not a choice between paths. */
const CHECK_IN = /^(?:want me to|do you want me to|shall i|should i (?:go ahead|proceed|continue|keep|start|commit|ship|push|deploy|merge)|ready (?:for|to)|does (?:this|that) (?:look|sound|work)|sound good|ok(?:ay)?\b|anything else|any (?:thoughts|questions)|let me know)/i;

/**
 * Ends on a judgment call the human must make between named alternatives:
 * the closing question offers two paths ("Redis or in memory?"), or the
 * message lays the options out as a labelled list. A yes/no permission
 * question ("Want me to proceed?") is a check-in, never a decision.
 */
export function asksForChoice(text: string): boolean {
  if (!endsWithQuestion(text)) return false;
  const lines = proseLines(text);
  const question = lines[lines.length - 1].replace(/^[*_>\s]+/, "");
  const listed = lines.slice(-15).filter((l) => OPTION_LINE.test(l)).length >= 2;
  if (listed) return true;
  return !CHECK_IN.test(question) && TWO_ALTERNATIVES.test(question);
}

/** A visual some agent drew in the thread. */
export function hasCanvas(text: string): boolean {
  return /```cast-canvas\b/.test(text);
}

/** A published codecast page, linked on its own line (how the thread embeds one). */
export function hasPublishedPage(text: string): boolean {
  return /^\s*(?:\[[^\]]*\]\()?https?:\/\/(?:[\w-]+\.)*codecast\.sh\/a\/[\w-]+/im.test(text);
}

export interface MomentContext {
  /** The newest assistant message in the thread. */
  isLast: boolean;
  /** The session is waiting on its human. */
  needsInput: boolean;
}

/** The feature this one assistant message makes the case for, if any. */
export function momentForMessage(text: string, ctx: MomentContext): FeatureMoment | null {
  const missing = (slug: MomentFeature): FeatureMoment => ({ slug, kind: "missing", reason: REASONS[slug] });
  const shown = (slug: MomentFeature): FeatureMoment => ({ slug, kind: "shown", reason: SHOWN[slug]! });
  if (ctx.isLast && ctx.needsInput && asksForChoice(text)) return missing("decide");
  if (hasLocalHtmlPath(text)) return missing("publish");
  if (hasTextChart(text)) return missing("visual");
  if (hasPublishedPage(text)) return shown("publish");
  if (hasCanvas(text)) return shown("visual");
  return null;
}

/**
 * The one message in a thread that carries an offer: the newest assistant
 * message whose moment names a feature still on offer. `offered` says which
 * features the viewer could still be offered (all machines off, not declined).
 */
export function pickFeatureMoment(
  messages: { id: string; text: string }[],
  ctx: { needsInput: boolean; /** The agent is still writing the newest message. */ working?: boolean },
  offered: (slug: MomentFeature) => boolean,
): { id: string; moment: FeatureMoment } | null {
  for (let i = messages.length - 1 - (ctx.working ? 1 : 0); i >= 0; i--) {
    const moment = momentForMessage(messages[i].text, { isLast: i === messages.length - 1, needsInput: ctx.needsInput });
    if (moment && offered(moment.slug)) return { id: messages[i].id, moment };
  }
  return null;
}
