import type { ConvoMessage, ProductionReply } from '@platform/evals';

import { isRefusalProse } from '../../../../convex/convex/idleSummary';
import {
  cleanShortTitle,
  extractTitleJson,
  pickSpineRows,
  selectTitleInput,
  shortTitleRequest,
  titleRequest,
  type TitleRow,
} from '../../../../convex/convex/titleGeneration';
import { toConvoMessages } from '../../adapters/convo';
import { readSessionMoment, SESSION_LINE_FORMS } from '../../adapters/moment';
import { gate, type SurfaceImpl, type SurfaceRequest } from '../../surface';

// The title pass (and the name-only short-title pass) replayed from the rows
// prod's selector reads. A title snapshot holds the spine and the newest 20
// rows exactly as getConversationForTitle would have read them at the
// moment; the request is built by prod's own selectTitleInput and
// titleRequest, so a prompt edit there is what the replay sends.

type Row = TitleRow & { line: number };

export interface TitleSnap {
  mode?: 'title' | 'short-title';
  /** title mode: the spine reads and the newest 20 rows (newest first), cut at the moment. */
  spine?: Row[];
  latest?: Row[];
  conversation?: { title?: string; subtitle?: string; title_is_custom?: boolean; message_count?: number };
  /** short-title mode: the name-only input. */
  shortTitle?: { kind: 'session' | 'task' | 'plan'; title: string; context?: string };
  /** The session's title when it was captured, which may postdate the moment. */
  currentTitle?: string;
  /** What this snapshot could not reproduce exactly from the access-checked reads. */
  approximate?: string[];
}

const REF_FORMS = `title@ needs a session and line, like title@jx7c6zk:142 (${SESSION_LINE_FORMS})`;

/**
 * fenceForeignText draws a random nonce per call in prod. Any nonce is one
 * prod would send; pinning it keeps a freeze's prompt (and promptSha) the
 * same across reps, which is what lets two run sets be compared.
 */
const pinNonce = (req: SurfaceRequest): SurfaceRequest => ({ ...req, prompt: req.prompt.replace(/untrusted-[0-9a-f]{8}/g, 'untrusted-00000000') });

export function titleSurfaceRequest(snap: TitleSnap): SurfaceRequest {
  if (snap.mode === 'short-title') {
    if (!snap.shortTitle) throw new Error('a short-title snapshot needs shortTitle');
    return pinNonce(shortTitleRequest(snap.shortTitle));
  }
  return pinNonce(titleRequest(selectTitleInput({ spine: snap.spine ?? [], latest: snap.latest ?? [] }, snap.conversation ?? {})));
}

/** The rows a title pass reads at a moment, from the session's rows up to it (oldest first). */
export function titleSnapshotRows(rows: Row[]): Pick<TitleSnap, 'spine' | 'latest'> {
  // Only the presence of a tool result matters to the selector; its text stays out of the snapshot.
  const slim = (r: Row): Row => ({ _id: r._id, role: r.role, content: r.content, timestamp: r.timestamp, line: r.line, ...(r.tool_results?.length ? { tool_results: r.tool_results.map(() => ({})) } : {}) });
  return { spine: pickSpineRows(rows).map(slim), latest: rows.slice(-20).reverse().map(slim) };
}

const shown = (snap: TitleSnap): Row[] => {
  const byId = new Map<string, Row>();
  for (const r of [...(snap.spine ?? []), ...(snap.latest ?? [])]) if (r.content) byId.set(r._id, r);
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
};

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    const m = await readSessionMoment(ref, REF_FORMS);
    const snapshot: TitleSnap = {
      mode: 'title',
      ...titleSnapshotRows(m.rows),
      // /cli/read carries no subtitle or title history, so the anchor a prior
      // LLM title gives is left out (selectTitleInput anchors only on a
      // subtitle), and the message count is the moment's line.
      conversation: { message_count: m.line },
      currentTitle: m.conversation.title,
      approximate: ['no current-title anchor: /cli/read has no title history', 'message_count is the /cli/read line, which skips empty rows'],
    };
    return {
      snapshot,
      subject: { kind: 'session', id: m.conversation.id, title: m.conversation.title ?? m.conversation.id },
      asOf: new Date(m.at.timestamp).toISOString(),
      anchor: { kind: 'message', id: `${m.conversation.id}:${m.line}` },
      name: `title ${m.conversation.id.slice(0, 7)}:${m.line}`,
      meta: { conversation_id: m.conversation.id, line: m.line },
    };
  },

  async replay(snap: TitleSnap, ctx) {
    const r = await ctx.call(titleSurfaceRequest(snap));
    const parsed = extractTitleJson(r.text);
    // Each field labelled, so the judge never reads the short title as the subtitle.
    const field = (name: string, value?: string) => `${name}: ${value?.trim() || '(none)'}`;
    const reply = parsed
      ? snap.mode === 'short-title'
        ? field('Short title', parsed.short_title)
        : [field('Title', parsed.title), field('Short title', parsed.short_title), `Subtitle:\n${parsed.subtitle?.trim() || '(none)'}`].join('\n')
      : r.text;
    return { reply, parsed };
  },

  gates(snap: TitleSnap, out) {
    const parsed = out.parsed as ReturnType<typeof extractTitleJson>;
    const short = cleanShortTitle(parsed?.short_title);
    if (snap.mode === 'short-title') {
      return [
        gate('parse', Boolean(parsed), parsed ? 'the reply parses with extractTitleJson' : `no JSON object in the reply: ${out.reply.slice(0, 120)}`),
        gate('clean', Boolean(short), short ? `short title "${short}"` : `cleanShortTitle drops ${JSON.stringify(parsed?.short_title ?? null)}`),
      ];
    }
    const title = parsed?.title?.trim();
    // The write condition generateTitle applies before it saves anything.
    const usable = Boolean(title && title.length < 200);
    const refusal = [title, parsed?.subtitle?.trim()].find((t) => t && isRefusalProse(t));
    return [
      gate('parse', usable, usable ? `title "${title}"` : parsed ? 'the JSON has no usable title (missing, or 200+ characters)' : `no JSON object in the reply: ${out.reply.slice(0, 120)}`),
      gate('clean', Boolean(short), short ? `short title "${short}"` : `cleanShortTitle drops ${JSON.stringify(parsed?.short_title ?? null)}`),
      gate('no-refusal', !refusal, refusal ? `refusal prose: ${refusal.slice(0, 120)}` : 'no refusal prose in the title or subtitle'),
    ];
  },

  describe(snap: TitleSnap): ConvoMessage[] {
    if (snap.mode === 'short-title') {
      const s = snap.shortTitle;
      return toConvoMessages([{ line: 1, role: 'user', content: s ? `${s.kind} title: ${s.title}${s.context ? `\n\n${s.context}` : ''}` : '', timestamp: 0 }]);
    }
    return toConvoMessages(shown(snap).map((r) => ({ ...r, content: r.content ?? '' })));
  },

  productionReply(snap: TitleSnap): ProductionReply | null {
    if (!snap.currentTitle) return null;
    const at = new Date(Math.max(0, ...shown(snap).map((r) => r.timestamp))).toISOString();
    return {
      messages: [{ n: 1, id: 'current-title', at, channel: 'session', isGroup: false, direction: 'out', from: 'assistant', text: `${snap.currentTitle}\n(current title, may postdate the moment)` }],
    };
  },
};

export default impl;
