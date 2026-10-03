import type { CheckResult, ConvoMessage } from '@platform/evals';

import {
  EDITION_HEADLINE_MAX,
  STANDFIRST_WORDS,
  editionRequest,
  parseEditionReply,
  type EditionPromptInput,
  type EditionProse,
} from '../../../../convex/convex/changesProse';
import { parseJsonBlock } from '../../../../convex/convex/lib/anthropic';
import { gate, type SurfaceImpl, type SurfaceRequest } from '../../surface';
import { captureFromFile, describePrompt, emDashGate, fileRefForm, leakGate, sentText, type LeakWorld } from '../changesCommon';

// A team day's edition replayed from what prod's edition pass reads
// (docs/proposals/changes-page.md 7.5): the EditionPromptInput that
// loadEditionInput builds from the day's stories and facts. prod's
// editionRequest builds the request, and parseEditionReply reads the reply.

export interface ChangesEditionSnap extends LeakWorld {
  input: EditionPromptInput;
}

export interface ChangesEditionLabel {
  /** Story refs (s1, s2) a good lead may be. */
  leads?: string[];
}

interface Parsed {
  edition: EditionProse | null;
  raw: Record<string, unknown> | null;
}

const REF_FORMS = fileRefForm('changes-edition');

export const editionSurfaceRequest = (snap: ChangesEditionSnap): SurfaceRequest => editionRequest(snap.input);

/**
 * prod maps each ref to its story_key. A snapshot holds no story keys, so
 * each ref stands for itself and the parsed edition names stories by ref.
 */
export const refKeys = (input: EditionPromptInput): Record<string, string> => Object.fromEntries(input.stories.map((s) => [s.key, s.key]));

const headlineOf = (input: EditionPromptInput, key: string) => input.stories.find((s) => s.key === key)?.headline ?? '';

/** The edition as the page would lay it out, each field labelled for the judge. */
function render(e: EditionProse, input: EditionPromptInput): string {
  return [
    `Headline: ${e.headline}`,
    `Standfirst: ${e.standfirst || '(none)'}`,
    `Lead: ${e.lead_story_key} ${headlineOf(input, e.lead_story_key)}`,
    `Sections: ${e.section_order.join(', ')}`,
    `In brief: ${e.brief_story_keys.length ? e.brief_story_keys.map((k) => `${k} ${headlineOf(input, k)}`).join('; ') : '(none)'}`,
  ].join('\n');
}

const text = (x: unknown) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');
const list = (x: unknown) => (Array.isArray(x) ? x.map(text).filter(Boolean) : []);

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref) {
    return captureFromFile('changes-edition', ref, REF_FORMS, ['people']);
  },

  async replay(snap: ChangesEditionSnap, ctx) {
    const r = await ctx.call(editionSurfaceRequest(snap));
    const edition = parseEditionReply(r.text, snap.input, refKeys(snap.input));
    const raw = parseJsonBlock(r.text);
    const parsed: Parsed = { edition, raw: raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null };
    return { reply: edition ? render(edition, snap.input) : r.text, parsed };
  },

  gates(snap: ChangesEditionSnap, out) {
    const { edition, raw } = (out.parsed ?? { edition: null, raw: null }) as Parsed;
    const sent = out.calls[0]?.text ?? out.reply;
    const gates = [gate('parse', Boolean(edition), edition ? `parseEditionReply reads a lead of ${edition.lead_story_key}` : `parseEditionReply rejects the reply (not JSON, no headline, or an unknown lead): ${sent.slice(0, 160)}`)];

    const over: string[] = [];
    if (raw) {
      const headline = text(raw.edition_headline);
      const words = text(raw.standfirst).split(' ').filter(Boolean).length;
      if (headline.length > EDITION_HEADLINE_MAX) over.push(`headline ${headline.length} > ${EDITION_HEADLINE_MAX}`);
      if (words > STANDFIRST_WORDS) over.push(`standfirst ${words} words > ${STANDFIRST_WORDS}`);
    }
    gates.push(gate('lengths', Boolean(raw) && over.length === 0, !raw ? 'no JSON object to measure' : over.length ? over.join('; ') : 'headline and standfirst within their limits'));

    // The parser drops refs and areas it does not know; the gate asks whether the model invented any.
    if (raw) {
      const keys = new Set(snap.input.stories.map((s) => s.key));
      const areas = new Set(snap.input.stories.map((s) => s.area));
      const unknown = [
        ...[text(raw.lead_story_key), ...list(raw.brief_story_keys)].filter((k) => k && !keys.has(k)).map((k) => `story ${k}`),
        ...list(raw.section_order).filter((a) => !areas.has(a)).map((a) => `area ${a}`),
      ];
      gates.push(gate('known-refs', unknown.length === 0, unknown.length ? `names what the day does not have: ${unknown.join(', ')}` : 'every story ref and area is one the day has'));
    }
    gates.push(emDashGate(sent));
    gates.push(leakGate(sentText(editionSurfaceRequest(snap)), edition ? render(edition, snap.input) : sent, snap));
    return gates;
  },

  checks(_snap: ChangesEditionSnap, out, label?: ChangesEditionLabel): CheckResult[] {
    if (!label?.leads?.length) return [];
    const { edition } = (out.parsed ?? { edition: null }) as Parsed;
    const lead = edition?.lead_story_key ?? 'unparsed';
    return [{ id: 'lead', ask: `the lead is one of ${label.leads.join(', ')}`, weight: 1, score: label.leads.includes(lead) ? 1 : 0, evidence: `lead ${lead}` }];
  },

  describe(snap: ChangesEditionSnap): ConvoMessage[] {
    return describePrompt(editionSurfaceRequest(snap).prompt, snap);
  },

  productionReply: () => null,
};

export default impl;
