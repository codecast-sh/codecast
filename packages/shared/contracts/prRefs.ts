// How a pull request is named, in one place.
//
// People write a pull request four ways: a bare number, an owner and name with
// a number, a GitHub pull request URL, and a codecast PR page URL. The CLI
// parses what a person typed, the Convex resolver parses what the CLI forwards,
// and the web builds the same links. Without one parser each of the three
// invents its own idea of what "owner/repo#12" means, and they drift.
//
// Everything here is pure string work, so it runs in the CLI, in a Convex
// query and in the browser with no environment of its own.

/** A reference names a repository, a number, or both. */
export interface ParsedPrRef {
  repository?: string;
  number?: number;
}

// GitHub allows letters, digits, dot, dash and underscore in an owner or a
// repository name.
const NAME = "[A-Za-z0-9._-]+";
const REPO_ONLY = new RegExp(`^${NAME}/${NAME}$`);

/**
 * Read a pull request reference. Returns null when the text names no pull
 * request, so a caller can tell "nothing was given" from "this is a number".
 */
export function parsePrRef(raw: string | null | undefined): ParsedPrRef | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  // A GitHub pull request URL, with any trailing path or fragment:
  // https://github.com/owner/name/pull/12/files#discussion_r1
  const github = text.match(new RegExp(`github\\.com/(${NAME})/(${NAME})/pulls?/(\\d+)`));
  if (github) return { repository: `${github[1]}/${github[2]}`, number: Number(github[3]) };

  // A codecast PR page: https://codecast.sh/pr/owner/name/12
  const codecast = text.match(new RegExp(`/pr/(${NAME})/(${NAME})/(\\d+)`));
  if (codecast) return { repository: `${codecast[1]}/${codecast[2]}`, number: Number(codecast[3]) };

  // owner/name#12, and the slash form people also type.
  const pair = text.match(new RegExp(`^(${NAME}/${NAME})(?:#|/)(\\d+)$`));
  if (pair) return { repository: pair[1], number: Number(pair[2]) };

  // A bare number, with or without the hash people put in front of it.
  const bare = text.match(/^#?(\d+)$/);
  if (bare) return { number: Number(bare[1]) };

  // owner/name alone names a repository and no pull request.
  if (REPO_ONLY.test(text)) return { repository: text };

  return null;
}

/**
 * The "owner/name" a git remote points at, or null when the remote is not a
 * GitHub one. Covers the three shapes git writes: the scp style ssh remote,
 * the https remote, and the ssh:// URL.
 */
export function extractRepoFromRemoteUrl(remoteUrl: string | null | undefined): string | null {
  const url = (remoteUrl ?? "").trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!url) return null;
  const match = url.match(new RegExp(`github\\.com[:/](${NAME})/(${NAME})$`));
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The path of the codecast page for a pull request. */
export function codecastPrPath(repository: string, number: number): string {
  return `/pr/${repository}/${number}`;
}

/** The full codecast page URL for a pull request. */
export function codecastPrUrl(repository: string, number: number, origin = "https://codecast.sh"): string {
  return `${origin.replace(/\/+$/, "")}${codecastPrPath(repository, number)}`;
}

/**
 * How a check is named wherever checks are listed.
 *
 * A workflow that runs one job on both `push` and `pull_request` produces two
 * check runs with the same name on the same commit, and GitHub lists both. The
 * triggering event is the only thing that tells them apart, so it rides along
 * in the label the way GitHub prints it: `test (ubuntu) (push)`.
 */
export function checkLabel(check: { name: string; event?: string }): string {
  return check.event ? `${check.name} (${check.event})` : check.name;
}
