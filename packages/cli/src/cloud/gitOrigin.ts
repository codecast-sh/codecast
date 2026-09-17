/**
 * Reading a git origin: its host, its `owner/repo`, and the spelling the cloud
 * host should use for it.
 *
 * A leaf on purpose. `cast git-credential` runs on every fetch and every push
 * the host makes, so it must start without loading the ssh plumbing; hostGit.ts
 * re-exports everything here, so both sides read one set of rules.
 */

/** `{ host, repo }` of an ssh or https origin: git@host:o/r.git, ssh://git@host[:port]/o/r, https://host/o/r[.git]. */
export function parseOrigin(origin: string | undefined): { host: string; repo: string } | undefined {
  if (!origin) return undefined;
  const o = origin.trim();
  let m = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^\s]+?)(?:\.git)?\/?$/.exec(o);
  if (m) return { host: m[1]!.toLowerCase(), repo: m[2]! };
  m = /^(?:ssh|git|https?):\/\/(?:[^@/\s]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/([^\s]+?)(?:\.git)?\/?$/.exec(o);
  if (m) return { host: m[1]!.toLowerCase(), repo: m[2]! };
  return undefined;
}

/** The ssh host of an origin, or undefined for a local path / unparseable origin. */
export function originHost(origin: string | undefined): string | undefined {
  return parseOrigin(origin)?.host;
}

export function isGitHubHost(host: string | undefined): boolean {
  return host === "github.com" || (host?.endsWith(".github.com") ?? false);
}

/** `owner/repo` of a GitHub origin (what `gh -R` wants), or undefined. */
export function githubRepo(origin: string | undefined): string | undefined {
  const p = parseOrigin(origin);
  if (!p || !isGitHubHost(p.host)) return undefined;
  const parts = p.repo.split("/").filter(Boolean);
  return parts.length === 2 ? parts.join("/") : undefined;
}

/** Where a deploy key for this origin is added on GitHub; undefined for a non-GitHub origin. */
export function deployKeyUrl(origin: string | undefined): string | undefined {
  const repo = githubRepo(origin);
  return repo ? `https://github.com/${repo}/settings/keys/new` : undefined;
}

export const ACCOUNT_KEY_URL = "https://github.com/settings/ssh/new";

/**
 * The https spelling of a GitHub origin — the one an installation token can
 * authenticate, because the token is an http password and ssh never sees it.
 * Undefined for anything that is not a GitHub repository.
 */
export function hostAppOrigin(origin: string | undefined): string | undefined {
  const p = parseOrigin(origin);
  const repo = githubRepo(origin);
  return p && repo ? `https://${p.host}/${repo}.git` : undefined;
}

/**
 * The origin the HOST talks to, given how it authenticates.
 *
 * Two credentials, two spellings. The device key is an ssh credential: an
 * https origin (what `gh repo clone` and GitHub's clone button produce by
 * default) is never authenticated by it, so the host is pointed at the ssh
 * form. Verified on the box: `git ls-remote --upload-pack=git-receive-pack`
 * over smart HTTP ignores the option ("setting remote service path not
 * supported by protocol") and exits 0 on a public repo — a false "push
 * access" — while a private one fails on the disabled credential prompt, an
 * error no deploy key fixes.
 *
 * A GitHub App installation token is the opposite: it is an http password, so
 * `appToken` (the host proved the credential helper answers for this
 * repository) keeps GitHub origins in their https form and pushes need no key
 * at all. Any other non-ssh origin cannot be guessed and is reported instead
 * of probed; ssh origins and local paths pass through.
 */
export function hostProbeOrigin(
  origin: string | undefined,
  opts: { appToken?: boolean } = {},
): { origin?: string; reason?: string } {
  if (!origin) return {};
  const repo = githubRepo(origin);
  if (opts.appToken && repo) return { origin: hostAppOrigin(origin)! };
  if (!/^(https?|git|ftps?):\/\//i.test(origin)) return { origin };
  const p = parseOrigin(origin);
  if (p && repo) return { origin: `git@${p.host}:${repo}.git` };
  return { reason: `origin ${origin} is not ssh — the host's key only works over ssh` };
}
