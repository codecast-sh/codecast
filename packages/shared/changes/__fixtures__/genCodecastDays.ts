// Regenerates codecastDays.json from this repo's own history: the 2026-10-02
// day the spec is written against, the 10-01 release burst and a 09-30 batch
// commit. Each commit is projected the way buildDay projects a commits row
// (spec 7.1 step 1), with the Codecast-Session trailer as its conversation.
//
//   bun packages/shared/changes/__fixtures__/genCodecastDays.ts
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitMessage, summarizeFiles, type CommitFile } from "../classify";
import type { ChangeCommit } from "../types";

/** Commits on main, oldest first per day. The two unbranched shas are pre-rebase twins of ca172db32 and 3d5b5984f. */
const DAYS: Record<string, { main: string[]; unbranched?: string[] }> = {
  "2026-10-02": {
    main: [
      "7d0984529", "f44387928", "65c80e05c", "926be8efb", "0de614861", "153304c35", "1ca7da95d", "f19093190",
      "e747f6fe4", "7e409b4df", "e7d2da040", "2bbfa75bd", "f692b70ca", "3d5b5984f", "ca172db32", "3250f11ca",
    ],
    unbranched: ["c0e2a7aed", "830683c2f"],
  },
  "2026-10-01": { main: ["955c2cb1d", "39acc4396", "b3d486bce", "2bb06540a", "b47af5aaa", "07017d24f", "79bf51995"] },
  "2026-09-30": { main: ["9dddac2af"] },
};

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function project(sha: string, branch: string | null, createdOffset: number): ChangeCommit {
  const [meta, ...msg] = git(["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%(trailers:key=Codecast-Session,valueonly)%x1e%B", sha]).split("\x1e");
  const [full, author_name, author_email, at, trailer] = meta.split("\x1f");
  const { subject, body } = splitMessage(msg.join("\x1e"));
  const files: CommitFile[] = git(["show", "--numstat", "--format=", sha])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, d, filename] = line.split("\t");
      return { filename, additions: a === "-" ? 0 : Number(a), deletions: d === "-" ? 0 : Number(d) };
    });
  const conv = /conversation\/(\w+)/.exec(trailer)?.[1] ?? null;
  const summary = summarizeFiles(files);
  return {
    sha: full.slice(0, 9),
    subject,
    body: body.slice(0, 600) || undefined,
    author_name,
    author_email,
    timestamp: Number(at) * 1000,
    created_at: Number(at) * 1000 + createdOffset,
    branch,
    conversation_id: conv,
    insertions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    ...summary,
  };
}

const out: Record<string, ChangeCommit[]> = {};
for (const [day, { main, unbranched = [] }] of Object.entries(DAYS)) {
  out[day] = [...unbranched.map((s) => project(s, null, 0)), ...main.map((s) => project(s, "main", 60_000))];
}
writeFileSync(join(import.meta.dir, "codecastDays.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(Object.entries(out).map(([d, cs]) => `${d}: ${cs.length}`).join(", "));
