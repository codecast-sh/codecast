// Moments in a conversation where an agent feature that is off would have
// done better, read from what is already on screen: no model call. Each
// detector names the feature and a sentence about THIS moment; the thread
// shows at most one such offer (pickFeatureMoment), and the offer itself only
// appears to someone whose machines all have that feature off
// (components/agentFeatures/useFeatureOffer).

export type MomentFeature = "decide" | "visual" | "publish";

export interface FeatureMoment {
  slug: MomentFeature;
  reason: string;
}

const REASONS: Record<MomentFeature, string> = {
  decide:
    "Your agent stopped to ask. With Decision queue on, a question like this waits in one queue you clear in a sitting, and the agent keeps working meanwhile.",
  visual: "Your agent drew this in text. With Visual Canvas on, it draws charts and diagrams right in the thread.",
  publish:
    "That page is on your agent's machine. With Publish on, it gets a link that opens here and that you can share.",
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

/** Ends by asking the human something: the last line of prose is a question. */
export function endsWithQuestion(text: string): boolean {
  const lines = withoutCode(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return /\?[*_)"'”]*$/.test(last);
}

export interface MomentContext {
  /** The newest assistant message in the thread. */
  isLast: boolean;
  /** The session is waiting on its human. */
  needsInput: boolean;
}

/** The feature this one assistant message makes the case for, if any. */
export function momentForMessage(text: string, ctx: MomentContext): FeatureMoment | null {
  if (ctx.isLast && ctx.needsInput && endsWithQuestion(text)) return { slug: "decide", reason: REASONS.decide };
  if (hasLocalHtmlPath(text)) return { slug: "publish", reason: REASONS.publish };
  if (hasTextChart(text)) return { slug: "visual", reason: REASONS.visual };
  return null;
}

/**
 * The one message in a thread that carries an offer: the newest assistant
 * message whose moment names a feature still on offer. `offered` says which
 * features the viewer could still be offered (all machines off, not declined).
 */
export function pickFeatureMoment(
  messages: { id: string; text: string }[],
  ctx: { needsInput: boolean },
  offered: (slug: MomentFeature) => boolean,
): { id: string; moment: FeatureMoment } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const moment = momentForMessage(messages[i].text, { isLast: i === messages.length - 1, needsInput: ctx.needsInput });
    if (moment && offered(moment.slug)) return { id: messages[i].id, moment };
  }
  return null;
}
