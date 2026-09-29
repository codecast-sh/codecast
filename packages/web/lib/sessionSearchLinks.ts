// "Sessions that touched this": the /search link for a file, a commit or a
// pull request the web shows. The query text itself is written by the shared
// session query module (sessionSearchHref), so a link and a typed search are
// the same query.

import { fileQueryPathFor, sessionSearchHref } from "@codecast/shared/search";

export type SessionsLink = { href: string; label: string };

/** A file the viewer sees at an absolute path, searched repo-relative when
 *  the session's checkout root is known (the index matches either spelling). */
export function fileSessionsLink(path: string, gitRoot?: string | null): SessionsLink {
  return {
    href: sessionSearchHref("file", fileQueryPathFor(path, gitRoot) ?? path),
    label: "Sessions that touched this file",
  };
}

const COMMIT_PATH = /^\/commit\/([^/?#]+)\/([^/?#]+)\/([0-9a-f]{7,40})(?:[/?#]|$)/i;
const PR_PATH = /^\/pr\/([^/?#]+)\/([^/?#]+)\/(\d+)(?:[/?#]|$)/;

/** The in-app commit and pull request pages (lib/externalEvents commitPath,
 *  prPath) read back into their session search. Anything else: null. */
export function sessionsLinkForAppPath(appPath: string): SessionsLink | null {
  const commit = COMMIT_PATH.exec(appPath);
  if (commit) return { href: sessionSearchHref("commit", commit[3]), label: "Sessions behind this commit" };
  const pr = PR_PATH.exec(appPath);
  if (pr) return { href: sessionSearchHref("pr", `${pr[1]}/${pr[2]}#${pr[3]}`), label: "Sessions behind this pull request" };
  return null;
}
