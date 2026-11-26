// Client for the daemon's /code/* routes: project search, git status and
// baselines, session blame and the vim config. Rides the vault bridge's
// endpoint and loopbackFetch, so it authenticates and reaches the daemon
// exactly the way the Files surface does. Every vault route is routed to the
// vault's own daemon by loopbackFetch (a cloud host's through its forward, so
// search, git and blame run where the files are). Types: codeProtocol.ts.

import type {
  CodeBlameResponse,
  CodeGitBaseResponse,
  CodeGitStatusResponse,
  CodeSearchEvent,
  CodeVimrcOverlayWriteResponse,
} from "@codecast/shared/contracts";
import { loopbackFetch, VaultRequestError, type VaultEndpoint } from "../vault/client";
import { hostOfEndpoint, localDaemonEndpoint } from "../vault/hosts/routes";

/** The person's own config lives on this machine, whichever machine the
 *  open vault is on: a cloud host's endpoint never answers for the vimrc. */
function homeEndpoint(ep: VaultEndpoint): VaultEndpoint {
  return hostOfEndpoint(ep) ? (localDaemonEndpoint() ?? ep) : ep;
}

export interface CodeSearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  word?: boolean;
  include?: string[];
  exclude?: string[];
  /** Total match cap; the daemon defaults to CODE_SEARCH_DEFAULT_MAX. */
  max?: number;
  /** Search files the tree hides as ignored too. */
  ignored?: boolean;
}

function query(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false || (Array.isArray(value) && value.length === 0)) continue;
    q.set(key, value === true ? "1" : Array.isArray(value) ? value.join(",") : String(value));
  }
  return q.toString();
}

async function getOk(ep: VaultEndpoint, path: string, what: string, init?: RequestInit): Promise<Response> {
  const res = await loopbackFetch(ep, path, init);
  if (!res.ok) {
    // A daemon without the route may answer with no JSON object at all.
    const body = ((await res.json().catch(() => null)) ?? {}) as { error?: string };
    throw new VaultRequestError(`${what}: ${res.status}${body.error ? ` ${body.error}` : ""}`, res.status);
  }
  return res;
}

async function getJson<T>(ep: VaultEndpoint, path: string, what: string, init?: RequestInit): Promise<T> {
  return (await (await getOk(ep, path, what, init)).json()) as T;
}

/**
 * Search a vault. Yields each file's matches as the daemon finds them, then a
 * "done" (or "error") event. Aborting `signal`, or leaving the loop early,
 * cancels the request and the daemon kills the search.
 */
export async function* searchCode(
  ep: VaultEndpoint,
  vaultId: string,
  q: string,
  opts: CodeSearchOptions = {},
  signal?: AbortSignal,
): AsyncGenerator<CodeSearchEvent> {
  const local = new AbortController();
  const abort = () => local.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const res = await loopbackFetch(
      ep,
      `/code/search?${query({
        vault: vaultId,
        q,
        regex: opts.regex,
        case: opts.caseSensitive,
        word: opts.word,
        include: opts.include,
        exclude: opts.exclude,
        max: opts.max,
        ignored: opts.ignored,
      })}`,
      // No timeout: a search over a big tree streams for as long as it walks,
      // and the caller's signal is what ends it.
      { signal: local.signal },
    );
    if (!res.ok || !res.body) throw new VaultRequestError(`code search: ${res.status}`, res.status);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += value;
      let from = 0;
      for (let nl = rest.indexOf("\n"); nl >= 0; nl = rest.indexOf("\n", from)) {
        const line = rest.slice(from, nl);
        from = nl + 1;
        if (line) yield JSON.parse(line) as CodeSearchEvent;
      }
      rest = rest.slice(from);
    }
    if (rest.trim()) yield JSON.parse(rest) as CodeSearchEvent;
  } finally {
    signal?.removeEventListener("abort", abort);
    local.abort();
  }
}

/** Porcelain status of the vault against HEAD. `fresh` skips the daemon's
 *  short cache, for a refresh right after a save or a commit. */
export function fetchGitStatus(ep: VaultEndpoint, vaultId: string, opts: { fresh?: boolean } = {}): Promise<CodeGitStatusResponse> {
  return getJson(ep, `/code/git/status?${query({ vault: vaultId, fresh: opts.fresh })}`, "git status");
}

/** A file's text at `ref` (HEAD by default); `exists: false` for a new file. */
export function fetchGitBase(ep: VaultEndpoint, vaultId: string, path: string, ref?: string): Promise<CodeGitBaseResponse> {
  return getJson(ep, `/code/git/base?${query({ vault: vaultId, path, ref })}`, "git base");
}

export function fetchBlame(ep: VaultEndpoint, vaultId: string, path: string): Promise<CodeBlameResponse> {
  // A first blame of a long file waits on git and on the session lookup.
  return getJson(ep, `/code/blame?${query({ vault: vaultId, path })}`, "blame", { signal: AbortSignal.timeout(45_000) });
}

/** The vimrc response as its raw JSON text (a CodeVimrcResponse), undecoded:
 *  nearly every load returns what the editor already applied, and comparing
 *  text finds that without a decode. */
export async function fetchVimrcText(ep: VaultEndpoint): Promise<string> {
  return (await getOk(homeEndpoint(ep), "/code/vimrc", "vimrc")).text();
}

export function writeVimrcOverlay(ep: VaultEndpoint, content: string): Promise<CodeVimrcOverlayWriteResponse> {
  return getJson(homeEndpoint(ep), "/code/vimrc/overlay", "vimrc overlay", {
    method: "PUT",
    body: content,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
