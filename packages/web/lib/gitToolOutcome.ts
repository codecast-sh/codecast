// What a shell tool call produced in git terms, read off its command and
// output: a commit (`git commit` printing `[branch abc1234] subject`) or a
// pull request (`gh pr create` printing its URL). The transcript renders the
// outcome as the object it is — a commit or PR reference linking to the
// in-app page — on the very call that made it, which is exact attribution
// with no extra row. The commit hash rule is the one the server's file change
// extractor uses, so the two never disagree about which sha a call produced.
import { extractCommitHashFromContent } from "@codecast/convex/convex/fileChanges/extractor";
import { parseEntityUrl } from "@codecast/shared/entities";

export type GitToolOutcome =
  | { kind: "commit"; hash: string; subject: string; branch?: string }
  | { kind: "pr"; ref: string; url: string };

const COMMIT_COMMAND = /(^|[;&|]\s*|\bthen\s+|\bdo\s+)git\b[^;&|\n]*\bcommit\b/;
const PR_CREATE_COMMAND = /(^|[;&|]\s*|\bthen\s+|\bdo\s+)gh\s+pr\s+create\b/;
const GITHUB_PR_URL = /https:\/\/(?:www\.)?github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

/** `[main abc1234] subject` or `[main (root-commit) abc1234] subject`, the line git commit prints. */
function commitSummaryLine(output: string): { hash: string; subject: string; branch?: string } | null {
  const hash = extractCommitHashFromContent(output);
  if (!hash) return null;
  const line = output.split("\n").find((l) => l.includes(`${hash}]`)) ?? "";
  const m = /^\s*\[([^\s\]]+)(?:\s+\([^)]*\))?\s+[0-9a-f]{7,40}\]\s*(.*)$/.exec(line);
  return { hash, subject: (m?.[2] ?? "").trim(), ...(m?.[1] ? { branch: m[1] } : {}) };
}

export function gitToolOutcome(command: string | undefined, output: string | undefined, isError?: boolean): GitToolOutcome | null {
  if (!command || !output || isError) return null;
  if (PR_CREATE_COMMAND.test(command)) {
    const url = GITHUB_PR_URL.exec(output)?.[0];
    const ref = url ? parseEntityUrl(url) : null;
    return url && ref?.type === "pr" ? { kind: "pr", ref: ref.id, url } : null;
  }
  if (COMMIT_COMMAND.test(command)) {
    const commit = commitSummaryLine(output);
    return commit ? { kind: "commit", ...commit } : null;
  }
  return null;
}

export type TranscriptMessage = {
  tool_calls?: { id: string; name: string; input?: unknown }[] | null;
  tool_results?: { tool_use_id: string; content?: string; is_error?: boolean }[] | null;
};

/**
 * Every commit sha and pull request a transcript's shell calls produced. The
 * transcript renders those on the calls themselves, so a linked commit or PR
 * that is NOT in here is one made outside the transcript and gets a card.
 */
export function transcriptGitOutcomes(messages: readonly TranscriptMessage[]): { commitShas: Set<string>; prRefs: Set<string> } {
  const commands = new Map<string, string>();
  const commitShas = new Set<string>();
  const prRefs = new Set<string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      const input = typeof call.input === "string" ? safeParse(call.input) : call.input;
      const command = input && typeof input === "object" ? String((input as any).command ?? (input as any).cmd ?? "") : "";
      if (command) commands.set(call.id, command);
    }
    for (const result of message.tool_results ?? []) {
      const outcome = gitToolOutcome(commands.get(result.tool_use_id), result.content, result.is_error);
      if (outcome?.kind === "commit") commitShas.add(outcome.hash);
      if (outcome?.kind === "pr") prRefs.add(outcome.ref);
    }
  }
  return { commitShas, prRefs };
}

/** A commit made in the transcript, by any prefix of its sha. */
export function madeInTranscript(sha: string, commitShas: Set<string>): boolean {
  for (const prefix of commitShas) if (sha.startsWith(prefix)) return true;
  return false;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
