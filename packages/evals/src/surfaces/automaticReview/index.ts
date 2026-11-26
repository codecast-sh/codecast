import { spawnSync } from 'node:child_process';

import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { AUTOMATIC_REVIEW_PROMPT_MAX, automaticAnswerOf, automaticReviewRequest, binaryIn, diffPaths } from '../../../../convex/convex/lib/automaticReview';
import { parseJsonBlock } from '../../../../convex/convex/lib/anthropic';
import { toConvoMessages } from '../../adapters/convo';
import { gate, type Captured, type SurfaceImpl } from '../../surface';

// Codecast's automatic review of a pull request no run is behind
// (convex/lib/automaticReview.ts) replayed as the server posts it: the diff of
// one head, the files its headers name, and the repository's definition of a
// mechanism, through the same automaticReviewRequest. A real freeze is a pull
// request as GitHub shows it now, with the definition read from the file the
// ref names on its repository's default branch; a fixture is a synthetic
// change. The label is the mechanism answer a person expects; the gates hold
// the parse and that answer.

export interface AutomaticReviewSnap {
  repository: string;
  head_sha: string;
  files: string[];
  diff: string;
  mechanism_definition: string;
  /** Where the definition was read from, `<owner/repo>:<path>`. */
  definition_from: string;
  /** When it was read: the clock the views show it at. */
  now: number;
}

export interface AutomaticReviewLabel {
  mechanism?: boolean;
}

const REF_FORMS = `automatic-review@ takes a fixture or a pull request and the mechanism file to judge it by, like automatic-review@fixture:<case> or automatic-review@<owner/repo>#<number>@<owner/repo>:<path to mechanism.md>`;

export const automaticReviewRequestFor = (snap: AutomaticReviewSnap) =>
  automaticReviewRequest({ repository: snap.repository, head_sha: snap.head_sha, files: snap.files, diff: snap.diff, mechanism_definition: snap.mechanism_definition });

function gh(args: string[]): string {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new UsageError(`gh ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  return r.stdout;
}

const impl: SurfaceImpl = {
  refForms: REF_FORMS,

  async capture(ref): Promise<Captured> {
    const m = /^([\w.-]+\/[\w.-]+)#(\d+)@([\w.-]+\/[\w.-]+):(.+)$/.exec(ref.trim());
    if (!m) throw new UsageError(REF_FORMS);
    const [, repository, number, defRepo, defPath] = m;
    const pr = JSON.parse(gh(['pr', 'view', number, '-R', repository, '--json', 'headRefOid,title,state']));
    const diff = gh(['pr', 'diff', number, '-R', repository]);
    const mechanism_definition = gh(['api', `repos/${defRepo}/contents/${defPath}`, '-H', 'Accept: application/vnd.github.raw+json']);
    // What the server refuses before any call is no moment for this prompt: it fails closed to a person.
    const binary = binaryIn(diff);
    if (binary) throw new UsageError(`${ref}: the diff has a binary file (${binary}), which the server never sends`);
    const files = diffPaths(diff);
    if (!files) throw new UsageError(`${ref}: the diff names a path the server cannot read back, so it never sends it`);
    const snapshot: AutomaticReviewSnap = { repository, head_sha: pr.headRefOid, files, diff, mechanism_definition, definition_from: `${defRepo}:${defPath}`, now: Date.now() };
    const req = automaticReviewRequestFor(snapshot);
    const size = (req.system ?? '').length + req.prompt.length;
    if (size > AUTOMATIC_REVIEW_PROMPT_MAX) throw new UsageError(`${ref}: the prompt is ${size} characters, over the ${AUTOMATIC_REVIEW_PROMPT_MAX} the server sends`);
    return {
      snapshot,
      subject: { kind: 'pull_request', id: `${repository}#${number}`, title: String(pr.title ?? '') },
      asOf: new Date(snapshot.now).toISOString(),
      anchor: { kind: 'message', id: `pr:${repository}#${number}` },
      name: `automatic-review ${repository}#${number}`,
      meta: { repository, pr: Number(number), state: pr.state ?? null, definition_from: snapshot.definition_from },
    };
  },

  async replay(snap: AutomaticReviewSnap, ctx) {
    const r = await ctx.call(automaticReviewRequestFor(snap));
    return { reply: r.text, parsed: automaticAnswerOf(parseJsonBlock(r.text)) };
  },

  gates(_snap: AutomaticReviewSnap, out, label?: AutomaticReviewLabel) {
    const answer = out.parsed as ReturnType<typeof automaticAnswerOf> | undefined;
    const gates = [gate('parse', !!answer, answer ? `mechanism ${answer.mechanism}` : `no answer the server reads in: ${out.reply.slice(0, 120)}`)];
    if (typeof label?.mechanism === 'boolean') gates.push(gate('mechanism-match', answer?.mechanism === label.mechanism, `expected ${label.mechanism}, got ${answer ? answer.mechanism : 'nothing'}`));
    return gates;
  },

  describe(snap: AutomaticReviewSnap): ConvoMessage[] {
    return toConvoMessages([{ role: 'user', content: automaticReviewRequestFor(snap).prompt, line: 1, timestamp: snap.now }]);
  },

  productionReply: () => null,
};

export default impl;
