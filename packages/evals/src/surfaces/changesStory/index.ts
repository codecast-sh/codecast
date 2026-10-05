import type { CheckResult, ConvoMessage } from '@platform/evals';

import type { ChangeCommit } from '@codecast/shared/changes';
import { DEK_MAX, HEADLINE_MAX } from '@codecast/shared/changes';
import {
  BODY_CHARS,
  parseStoryReply,
  skipHeadline,
  storyPromptInput,
  storyRequest,
  type GatedSession,
  type StoryFacts,
  type StoryProse,
  type WhySource,
} from '../../../../convex/convex/changesProse';
import type { Doc } from '../../../../convex/convex/_generated/dataModel';
import { parseJsonBlock } from '../../../../convex/convex/lib/anthropic';
import { gate, type SurfaceImpl, type SurfaceRequest } from '../../surface';
import { captureFromFile, describePrompt, emDashGate, fileRefForm, leakGate, sentText, type LeakWorld } from '../changesCommon';

// One Changes story replayed from what prod's prose pass reads
// (docs/proposals/changes-page.md 7.4): the change_stories row, its commits as
// layer 0 projects them, the sessions that passed teamVisibleInputs(), and its
// pull requests. prod's storyPromptInput and storyRequest build the request
// and parseStoryReply reads the reply, so a prompt edit there is what replays.

export interface ChangesStorySnap extends LeakWorld {
  story: StoryFacts & Pick<Doc<'change_stories'>, 'conversation_ids' | 'kind' | 'importance'>;
  commits: ChangeCommit[];
  /** Only the sessions the gate passed, at the mode it passed them. */
  sessions: GatedSession[];
  prs: Array<{ number: number; title: string; body: string }>;
}

export interface ChangesStoryLabel {
  /** The input that states why, or none when no input does; a list when several inputs state it and any of them is right. */
  why: WhySource | WhySource[];
}

interface Parsed {
  prose: StoryProse | null;
  raw: Record<string, unknown> | null;
}

const REF_FORMS = fileRefForm('changes-story');

export const storySurfaceRequest = (snap: ChangesStorySnap): SurfaceRequest => storyRequest(storyInputOf(snap));

export const storyInputOf = (snap: ChangesStorySnap) => storyPromptInput(snap.story, snap.commits, snap.sessions, snap.prs);

/** The story as the page would show it, each field labelled for the judge. */
function render(p: StoryProse): string {
  const lines = [`Headline: ${p.headline}`, `Dek: ${p.dek || '(none)'}`, `Body: ${p.body || '(none)'}`, `Kind: ${p.kind}. Importance: ${p.importance}. Why from: ${p.why_source}.`];
  for (const [code, line] of Object.entries(p.risk_lines ?? {})) lines.push(`Risk ${code}: ${line}`);
  return lines.join('\n');
}

const text = (x: unknown) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    return captureFromFile('changes-story', ref, REF_FORMS, ['people', 'withheld']);
  },

  async replay(snap: ChangesStorySnap, ctx) {
    if (skipHeadline(snap.story, snap.commits)) throw new Error('prod writes this story from its subject without a call (the skip path), so it is no case for changes-story');
    const input = storyInputOf(snap);
    const r = await ctx.call(storyRequest(input));
    const prose = parseStoryReply(r.text, input, snap.story);
    const raw = parseJsonBlock(r.text);
    const parsed: Parsed = { prose, raw: raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null };
    return { reply: prose ? render(prose) : r.text, parsed };
  },

  gates(snap: ChangesStorySnap, out, label?: ChangesStoryLabel) {
    const { prose, raw } = (out.parsed ?? { prose: null, raw: null }) as Parsed;
    const sent = out.calls[0]?.text ?? out.reply;
    const gates = [gate('parse', Boolean(prose), prose ? `parseStoryReply reads a ${prose.kind} story, why from ${prose.why_source}` : `parseStoryReply rejects the reply (not JSON, no headline, or a why source the story lacks): ${sent.slice(0, 160)}`)];

    // The parser clips what runs long; the gate asks whether the model kept to the limits itself.
    const over: string[] = [];
    if (raw) {
      const headline = text(raw.headline);
      const dek = text(raw.dek);
      if (headline.length > HEADLINE_MAX) over.push(`headline ${headline.length} > ${HEADLINE_MAX}`);
      if (dek.length > DEK_MAX) over.push(`dek ${dek.length} > ${DEK_MAX}`);
      const body = typeof raw.body === 'string' ? raw.body : '';
      if (body.length > BODY_CHARS) over.push(`body ${body.length} > ${BODY_CHARS} characters`);
    }
    gates.push(gate('lengths', Boolean(raw) && over.length === 0, !raw ? 'no JSON object to measure' : over.length ? over.join('; ') : 'headline, dek and body within their limits'));
    gates.push(emDashGate(sent));
    // A reply may show only the screenshots it was offered: every image is a listed ref.
    const refs = typeof raw?.body === 'string' ? [...raw.body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]) : [];
    const offered = storyInputOf(snap).image_urls;
    const strays = refs.filter((r) => !offered[r]);
    gates.push(gate('images', strays.length === 0, strays.length ? `images not offered: ${strays.join(', ')}` : refs.length ? `${refs.length} placed, all offered` : 'no images placed'));

    if (label?.why === 'none') {
      const why = prose?.why_source ?? null;
      gates.push(gate('why-none', why === 'none', why === 'none' ? 'no input states a reason, and why_source is none' : `no input states a reason, yet why_source is ${why ?? 'unparsed'}`));
    }
    gates.push(leakGate(sentText(storySurfaceRequest(snap)), prose ? render(prose) : sent, snap));
    return gates;
  },

  checks(snap: ChangesStorySnap, out, label?: ChangesStoryLabel): CheckResult[] {
    const { prose } = (out.parsed ?? { prose: null }) as Parsed;
    const checks: CheckResult[] = [];
    if (label?.why && label.why !== 'none') {
      const got = prose?.why_source ?? 'unparsed';
      const stated: readonly string[] = Array.isArray(label.why) ? label.why : [label.why];
      checks.push({ id: 'why-source', ask: `why_source names an input that states the reason (${stated.join(' or ')})`, weight: 1, score: stated.includes(got) ? 1 : 0, evidence: `why_source ${got}` });
    }
    const codes = snap.story.risks.map((r) => r.code);
    if (codes.length) {
      const worded = codes.filter((c) => prose?.risk_lines?.[c]);
      checks.push({ id: 'risk-lines', ask: 'one line for each flagged risk', weight: 1, score: worded.length / codes.length, evidence: `${worded.length} of ${codes.length} risks worded (${codes.join(', ')})` });
    }
    return checks;
  },

  describe(snap: ChangesStorySnap): ConvoMessage[] {
    return describePrompt(storySurfaceRequest(snap).prompt, snap);
  },

  productionReply: () => null,
};

export default impl;
