// The editor's session blame: `cast blame`'s attribution as per-line hunks.
// git blame does the line tracking, blame.ts resolves shas and uncommitted
// lines to the sessions that wrote them, and this folds the result into runs
// the gutter draws. Without a signed-in config, or when the server does not
// answer, the hunks are plain git blame.

import type * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { VAULT_MAX_SERVE_BYTES, type CodeBlameHunk, type CodeBlameResponse, type VaultInfo } from "@codecast/shared/contracts";
import {
  EMPTY_RESOLUTION,
  ZERO_SHA,
  parseBlamePorcelain,
  resolveFromParsed,
  sessionForLine,
  type BlameResolution,
  type ParsedBlame,
  type SessionRef,
} from "../blame.js";
import { git, headSha, locateRepo, renamedFromAtHead } from "./codeGit.js";

export interface BlameAuth {
  auth_token?: string;
  convex_url?: string;
}

/** A blame with uncommitted lines or no server answer is asked again soon:
 *  the edit that wrote those lines may not have reached the server yet. */
const PROVISIONAL_TTL_MS = 30_000;
const SETTLED_TTL_MS = 10 * 60_000;
const CACHE_ENTRIES = 200;

const cache = new Map<string, { at: number; ttl: number; blame: Promise<CodeBlameResponse> }>();

function hunkSession(ref: SessionRef | undefined): CodeBlameHunk["session"] {
  if (!ref) return undefined;
  return {
    id: ref.conversation_id.slice(0, 7),
    conversation_id: ref.conversation_id,
    ...(ref.title ? { title: ref.title } : {}),
    ...(ref.message_id ? { message_id: ref.message_id } : {}),
    ...(ref.author_name ? { author_name: ref.author_name } : {}),
    ...(ref.via ? { via: ref.via } : {}),
  };
}

/** Runs of consecutive lines with one commit and one session. Pure, for tests. */
export function blameHunks(parsed: ParsedBlame, resolution: BlameResolution): CodeBlameHunk[] {
  const hunks: CodeBlameHunk[] = [];
  let lastKey = "";
  for (const line of [...parsed.lines].sort((a, b) => a.finalLine - b.finalLine)) {
    const ref = sessionForLine(line, resolution);
    const key = `${line.sha}|${ref?.conversation_id ?? ""}`;
    const prev = hunks[hunks.length - 1];
    if (prev && key === lastKey && prev.end === line.finalLine - 1) {
      prev.end = line.finalLine;
      continue;
    }
    lastKey = key;
    const meta = parsed.commits.get(line.sha);
    const uncommitted = line.sha === ZERO_SHA;
    const session = hunkSession(ref);
    hunks.push({
      start: line.finalLine,
      end: line.finalLine,
      ...(uncommitted ? { uncommitted: true } : { sha: line.sha, author: meta?.author, summary: meta?.summary }),
      ...(meta?.authorTime ? { time: meta.authorTime * 1000 } : {}),
      ...(session ? { session } : {}),
    });
  }
  return hunks;
}

/** An untracked file as git blame would show it if it could: every line uncommitted. */
function untrackedBlame(content: string, mtimeMs: number): ParsedBlame {
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = text === "" ? [] : text.split("\n");
  return {
    lines: lines.map((line, i) => ({ sha: ZERO_SHA, finalLine: i + 1, content: line })),
    commits: new Map([[ZERO_SHA, { author: "Not Committed Yet", authorTime: Math.floor(mtimeMs / 1000), authorTz: "+0000", summary: "", boundary: false }]]),
  };
}

export type BlameResult = CodeBlameResponse | { error: "not a repo" | "not found" | "too large" };

export async function blameVaultFile(
  vault: VaultInfo,
  rel: string,
  abs: string,
  auth: BlameAuth | null,
): Promise<BlameResult> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return { error: "not found" };
  }
  if (!stat.isFile()) return { error: "not found" };
  if (stat.size > VAULT_MAX_SERVE_BYTES) return { error: "too large" };
  const repo = await locateRepo(vault.root);
  if (!repo) return { error: "not a repo" };
  const head = await headSha(vault.root);

  const key = `${abs}|${stat.mtimeMs}|${stat.size}|${head ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.blame;

  const entry = { at: Date.now(), ttl: SETTLED_TTL_MS, blame: null as unknown as Promise<CodeBlameResponse> };
  entry.blame = (async () => {
    const blame = (args: string[], cwd = vault.root) =>
      git(cwd, ["blame", "--porcelain", ...args], { timeoutMs: 30_000, maxBuffer: 256 * 1024 * 1024 }).then(
        parseBlamePorcelain,
        (err: Error) => {
          // Untracked, gitignored and newly added files have no history at HEAD.
          if (/no such path/i.test(err.message)) return null;
          throw err;
        },
      );
    let tracked = head ? await blame(["--", abs]) : null;
    if (head && !tracked) {
      // A staged `git mv`: blame the file on disk as its old name so its lines
      // keep their history. No final commit: git before 2.41 refuses one next
      // to --contents, and without it blame starts from HEAD anyway (the old
      // name only has to exist there, not in the working tree).
      const from = await renamedFromAtHead(vault, repo, rel);
      if (from) tracked = await blame(["--contents", abs, "--", from], repo.top);
    }
    const parsed = tracked ?? untrackedBlame(await fsp.readFile(abs, "utf8"), stat.mtimeMs);
    const resolution = auth ? await resolveFromParsed(parsed, abs, auth) : EMPTY_RESOLUTION;
    if (resolution === EMPTY_RESOLUTION || parsed.lines.some((l) => l.sha === ZERO_SHA)) entry.ttl = PROVISIONAL_TTL_MS;
    return { path: rel, hunks: blameHunks(parsed, resolution) };
  })();
  if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  entry.blame.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return entry.blame;
}
