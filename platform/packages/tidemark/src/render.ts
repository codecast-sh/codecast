import type { AsOf } from './asof';
import type { Activity } from './log';
import type { Viewer } from './scope';

/** A rough token count: four characters a token. Budgets are backstops, not billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RenderCtx {
  /** The read clock: `asOf.at` under replay, else the clock's now. */
  now: number;
  /** IANA zone for stamps; UTC when absent. */
  zone?: string;
  viewer: Viewer;
  asOf?: AsOf;
}

/** How the host turns its activities into lines. Hosts keep their own; plainRenderer is the default. */
export interface EventRenderer<H = unknown> {
  /** Batch-load host documents behind activities (messages, calls). */
  hydrate?(acts: Activity[], ctx: RenderCtx): Promise<H>;
  /** The line an activity contributes to a read; null hides it. */
  line(a: Activity, h: H, ctx: RenderCtx): { text: string; tokens?: number } | null;
  /** The fully opened form, for open(activity handle). Defaults to `line`. */
  full?(a: Activity, h: H, ctx: RenderCtx): string;
  /** Host item kinds the agent can open by reference. */
  openRef?(ref: string, opts: { at?: string }, ctx: RenderCtx): Promise<string | null>;
  /** True when the activity carries text from outside (a person's words), which the host should fence. */
  foreign?(a: Activity): boolean;
}

/** `YYYY-MM-DD HH:MM` in a zone (UTC by default). */
export function formatStamp(ms: number, zone?: string): string {
  if (!zone || zone === 'UTC') return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** `YYYY-MM-DD`, or `YYYY-MM-DD to YYYY-MM-DD` when the stretch spans days (UTC). */
export function dayRange(startMs: number, endMs: number): string {
  const a = new Date(startMs).toISOString().slice(0, 10);
  const b = new Date(endMs).toISOString().slice(0, 10);
  return a === b ? a : `${a} to ${b}`;
}

/** A block as a read renders it: its frame `[<tag>:<handle> | days]`, its summary, the closing frame. */
export function formatBlock(tag: string, handle: string, b: { startMs: number; endMs: number; content: string }): string {
  return `[${tag}:${handle} | ${dayRange(b.startMs, b.endMs)}]\n${b.content}\n[/${tag}:${handle}]`;
}

/** The least of its summary a clipped first block shows, in characters. */
export const FIRST_BLOCK_FLOOR_CHARS = 200;

/**
 * A block cut to about `tokens`, its frame and handle kept so it can still
 * be opened. However small the budget, it keeps the start of its summary
 * (FIRST_BLOCK_FLOOR_CHARS): a beginning shown as an empty frame is not shown.
 */
export function formatClippedBlock(tag: string, handle: string, b: { startMs: number; endMs: number; content: string }, tokens: number): string {
  const tail = `… (clipped to fit this read; open ${handle} for the whole summary)`;
  const room = Math.max(FIRST_BLOCK_FLOOR_CHARS, tokens * 4 - formatBlock(tag, handle, { ...b, content: tail }).length);
  return formatBlock(tag, handle, { ...b, content: b.content.slice(0, room).trimEnd() + tail });
}

/** `[stamp] kind: summary`, and the same line, actor and data included, when opened. */
export const plainRenderer: EventRenderer<undefined> = {
  line: (a, _h, ctx) => ({ text: `[${formatStamp(a.atMs, ctx.zone)}] ${a.kind}: ${a.summary}` }),
  full: (a, _h, ctx) => {
    const head = `[${formatStamp(a.atMs, ctx.zone)}] ${a.kind}${a.actor?.name ? ` by ${a.actor.name}` : ''}: ${a.summary}`;
    return a.data && Object.keys(a.data).length > 0 ? `${head}\n${JSON.stringify(a.data)}` : head;
  },
};
