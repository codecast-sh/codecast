// The checkout's own commits a change carries (flows.md FL4). A change frozen from a checkout's uncommitted edits is
// built on its HEAD and replayed onto upstream with HEAD's unpushed commits (flowChange.ts cutChange), since the edits
// grew on top of them. Those commits may be other sessions' work (ct-102477 carried another session's ~190-file
// commit under a one-file fix), so the change names each one where a person reads it (the dry run, the run's start,
// the pull request), and a brief whose failures fall only in their files says whose files those are.
import { gitTry } from "../wipSnapshot.js";
import { isAncestor, replayOnto } from "../land/replay.js";
import { writersNamed } from "./subjectStation.js";

/** One commit the change carries: its sha, subject, the session its Codecast-Session trailer names, and its files. */
export type UnpushedCommit = { sha: string; subject: string; session?: string; files: string[] };

// A checkout with more unpushed commits than this is named by its newest ones and a count.
const READ_MAX = 200;

/** The commits `head` holds that `upstream` lacks, newest first; none without an upstream to compare with. */
export async function unpushedCommits(root: string, head: string, upstream: string): Promise<UnpushedCommit[]> {
  const upstreamSha = upstream === "HEAD" ? null : await gitTry(root, ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`]);
  if (!upstreamSha) return [];
  const out = await gitTry(root, ["log", `--max-count=${READ_MAX}`, "--name-only", "--format=%x1e%H%x1f%s%x1f%(trailers:key=Codecast-Session,valueonly,separator=%x1f)", head, "--not", upstreamSha]);
  return (out ?? "").split("\x1e").filter((r) => r.trim()).map((record) => {
    const [header, ...files] = record.split("\n");
    const [sha, subject, ...trailers] = header.split("\x1f");
    // The trailer is the session's link (…/conversation/<id>) or its id; a session is named by its short id.
    const session = trailers.map((t) => t.trim().replace(/\/+$/, "").split("/").pop() ?? "").find(Boolean)?.slice(0, 7);
    return { sha, subject: subject ?? "", ...(session ? { session } : {}), files: files.map((f) => f.trim()).filter(Boolean) };
  });
}

/**
 * The unpushed commits a change frozen on `head` would carry once cut (flowChange.ts cutChange), for a preview that
 * cuts nothing: the same replay onto upstream, which drops a commit upstream already holds (one squash-merged there
 * while still unpushed by sha). A replay that cannot finish (a conflict, a merge commit) leaves the change on HEAD,
 * carrying them all, as the cut does.
 */
export async function shippingUnpushed(root: string, head: string, upstream: string): Promise<UnpushedCommit[]> {
  const all = await unpushedCommits(root, head, upstream);
  if (!all.length) return all;
  const upstreamSha = await gitTry(root, ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`]);
  if (!upstreamSha || (await isAncestor(root, upstreamSha, head))) return all;
  const replayed = await replayOnto(root, upstreamSha, head, upstreamSha).catch(() => null);
  return replayed?.ok ? all.filter((c) => !replayed.dropped.includes(c.sha)) : all;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const LISTED = 10;

/** One commit as a person reads it: short sha, subject, who wrote it and how many files. */
export const commitWords = (c: UnpushedCommit) => `${c.sha.slice(0, 9)} ${c.subject} (${c.session ? `session ${c.session}, ` : ""}${plural(c.files.length, "file")})`;

/** The lines that name the commits a change carries, for the dry run and the run's start; none when it carries none. */
export function unpushedLines(commits: ReadonlyArray<UnpushedCommit> | undefined): string[] {
  if (!commits?.length) return [];
  const more = commits.length - LISTED;
  return [
    `also carries ${plural(commits.length, "unpushed commit")} of the checkout's that upstream lacks, which ship with this change:`,
    ...commits.slice(0, LISTED).map((c) => `  ${commitWords(c)}`),
    ...(more > 0 ? [`  and ${more} more`] : []),
  ];
}

/** The pull request body's paragraph that names the carried commits; empty when the change carries none. */
export function unpushedBody(commits: ReadonlyArray<UnpushedCommit> | undefined): string {
  if (!commits?.length) return "";
  const more = commits.length - LISTED;
  return [
    `This change also carries ${plural(commits.length, "commit")} the checkout it was made in had not pushed. They ship with it:`,
    ...commits.slice(0, LISTED).map((c) => `- \`${c.sha.slice(0, 9)}\` ${c.subject} (${c.session ? `session ${c.session}, ` : ""}${plural(c.files.length, "file")})`),
    ...(more > 0 ? [`- and ${more} more`] : []),
  ].join("\n");
}

/**
 * What a brief says about failures in the carried commits' files: the files the finding's failing lines name that only
 * a carried commit changed, with the commit and session each came from. It excuses nothing: a change of the session's
 * own can break a file it carries (a signature it changed), so the session is told to fix it if its change caused it.
 * Empty when no failing line names a carried file (a finding with no line marked failing names none).
 */
export function carriedFailureNote(change: { paths: string[]; unpushed?: UnpushedCommit[] }, finding: string, roots: string[] = []): string {
  if (!change.unpushed?.length) return "";
  const own = new Set(change.paths);
  // A file the session also edited is the change's own; the newest carried commit that changed a file stands for it.
  const writers: Record<string, { conversation: string; session: string }> = {};
  for (const c of change.unpushed) for (const f of c.files) if (!own.has(f) && !writers[f]) writers[f] = { conversation: c.sha, session: c.session ?? "" };
  if (!Object.keys(writers).length) return "";
  const { writers: named, unclaimed } = writersNamed({ paths: [...own, ...Object.keys(writers)], writers }, finding, roots, { failingOnly: true });
  if (!named.length) return "";
  const from = named.map((w) => `${w.files.join(", ")} (commit ${w.conversationId.slice(0, 9)}${w.shortId ? ` by session ${w.shortId}` : ""})`).join("; ");
  return `${unclaimed.length ? "Some of the failing files" : "The failing files named here"} are only in commits the change carries from the checkout, not in this session's edits: ${from}. If this change caused the failure, fix it; otherwise say so in your reply.`;
}
