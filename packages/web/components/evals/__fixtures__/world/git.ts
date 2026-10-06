// Part of the fixture world (../world.ts), which every caller imports. The
// world's git: one line of commits, which files each touched, and the reads
// the commit panel, the epoch sheet and attribution make of a repo. Nothing
// here is real data.

import { EVALS_SHA_RE, type CommitRef, type CommitResponse } from "@codecast/shared/contracts/evalsApi";
import type { AttributionGit, AttributionMeta } from "@platform/evals/analysis";
import { BadRequest } from "@platform/evals/query";
import { type FixtureState, surfaceDef } from "./model";

/** What every surface's prompt rests on beside its own sources: an `evals:` commit touches it. */
const JUDGE_PATH = "packages/evals/src/adapters/judge.ts";
/** What a commit that names no surface touches. */
const APP_PATH = "packages/web/components/Inbox.tsx";
/** Every commit tidies this too, so a commit's whole view shows more than a surface declares. */
const TIDIED_PATH = "packages/web/components/InboxRow.tsx";

/** The repo paths a surface's prompt rests on. */
export const declaredPaths = (st: FixtureState, surface: string): string[] => [...surfaceDef(st, surface).sources, JUDGE_PATH].sort();

/** The files a commit touched, read off its subject: the prompt of each surface it names, the judge for `evals:`, else app code. */
function commitFiles(st: FixtureState, c: CommitRef): string[] {
  const prompts = st.defs.filter((d) => c.subject.startsWith(d.id.split("-")[0])).map((d) => d.sources[d.sources.length - 1]);
  const own = c.subject.startsWith("evals") ? [JUDGE_PATH] : prompts.length ? [...new Set(prompts)] : [APP_PATH];
  return [...own, TIDIED_PATH];
}

const under = (file: string, paths: string[]) => paths.some((p) => file === p || file.startsWith(`${p}/`));

const fileDiff = (file: string) =>
  file === TIDIED_PATH
    ? `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -40,3 +40,3 @@ export function InboxRow({ row }: Props) {\n   const title = row.title ?? "Untitled";\n-  return <Row title={title} dense={false} />;\n+  return <Row title={title} dense />;\n }\n`
    : `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -12,6 +12,7 @@ export const RULES = [\n   "Read the last assistant turn first.",\n-  "If the human was asked anything, the session is waiting.",\n+  "If the human was asked anything, the session is waiting, whatever else is true.",\n+  "A finished fix with tests passing is done. Prefer done when work is verified.",\n   "Answer in JSON only.",\n ];\n`;
const fileStat = (file: string) => ({ path: file, status: "M", additions: file === TIDIED_PATH ? 1 : 2, deletions: 1 });

export interface FixtureGit {
  verify(sha: string): void;
  touching(surface: string, from: string | null, to: string | null): CommitRef[];
  between(surface: string, a: string, b: string): CommitRef[];
  commit(sha: string, surface: string | null, whole: boolean): CommitResponse;
  attribution: AttributionGit;
  meta: AttributionMeta;
}

export function fixtureGit(st: FixtureState): FixtureGit {
  /** Where a commit sits on the line, by its own sha or its main-line twin's. */
  const at = (sha: string) => st.commits.findIndex((c) => c.sha === sha || c.mainSha === sha);
  /** A commit as the main line holds it: the one off main stands there as its twin. */
  const onMain = (c: CommitRef): CommitRef => (c.onMain ? c : { ...c, sha: c.mainSha ?? c.sha, onMain: true });
  const named = (ref: string): CommitRef | null => {
    const own = st.commits.find((c) => c.sha.startsWith(ref));
    if (own) return own;
    const twin = st.commits.find((c) => c.mainSha?.startsWith(ref));
    return twin ? onMain(twin) : null;
  };
  const verified = (sha: string): CommitRef => {
    const c = EVALS_SHA_RE.test(sha) ? named(sha) : null;
    if (!c) throw new BadRequest(`${sha} is not a commit in this repo`);
    return c;
  };
  const touches = (c: CommitRef, paths: string[]) => commitFiles(st, c).some((f) => under(f, paths));
  const range = (a: string, b: string) => (at(a) < 0 || at(b) < 0 ? [] : st.commits.slice(at(a) + 1, at(b) + 1));

  const attribution: AttributionGit = {
    resolve: (name) => named(name)?.sha ?? null,
    isAncestor: (a, b) => at(a) >= 0 && at(b) >= at(a),
    path: (good, bad, paths) => range(good, bad).filter((c) => !paths || touches(c, paths)).map(onMain),
    changed: (a, b, paths) => [...new Set(range(a, b).flatMap((c) => commitFiles(st, c)))].filter((f) => under(f, paths)),
    // The world keeps no file contents: every freeze names its freezeSha, so attribution never has to read one.
    show: () => null,
  };

  return {
    verify: (sha) => void verified(sha),
    touching: (surface, from, to) => st.commits.filter((c) => (!from || c.at >= from) && (!to || c.at <= to) && touches(c, declaredPaths(st, surface))).map(onMain),
    between: (surface, a, b) => (a === b || !attribution.isAncestor(a, b) ? [] : attribution.path(a, b, declaredPaths(st, surface))),
    commit(sha, surface, whole) {
      const c = verified(sha);
      const i = at(c.sha);
      const all = commitFiles(st, c);
      const files = whole || !surface ? all : all.filter((f) => under(f, declaredPaths(st, surface)));
      return { commit: c, parents: i > 0 ? [onMain(st.commits[i - 1]).sha] : [], body: `${c.subject}\n\nCodecast-Session: ${c.session}`, whole: whole || !surface, files: files.map(fileStat), diff: files.map(fileDiff).join(""), truncated: false };
    },
    attribution,
    meta: {
      declaredPaths: (surface) => declaredPaths(st, surface),
      surfaceInfo: (surface) => st.defs.find((d) => d.id === surface) ?? null,
      readHeads: () => ({ heads: Object.fromEntries(st.commits.flatMap((c) => [c.sha, ...(c.mainSha && c.mainSha !== c.sha ? [c.mainSha] : [])].map((sha) => [sha, { mainSha: c.mainSha }]))) }),
      freezeSnapshotPath: () => null,
    },
  };
}
