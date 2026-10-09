// The authenticated POST every CLI command and the daemon's capability
// reconciler makes against the codecast backend.
//
// It used to live in publish.ts, which meant that reaching for one HTTP helper
// pulled the whole `cast publish` command — its bundle walk, its watch loop,
// its thumbnailer — into the importer. That is how the daemon ended up with a
// CLI command group in its bundle, and it is what would have put the command
// group manifest there too. A leaf module with one dependency (cliHttp) ends
// the class. ct-49546.

import { cliFetch, cliFetchRead } from "./cliHttp.js";

/** Where to POST and who as. index.ts owns both and hands them in, so every
 *  command module stays importable by a test that supplies its own. */
export interface PublishDeps {
  getCliEndpoint: () => { siteUrl: string; apiToken: string };
  detectCurrentSessionId: () => string | null;
}

/**
 * A route the deployment does not have answers with an HTML page, not JSON, so
 * a CLI newer than the server otherwise reports the page body as a parse
 * failure. Returns the message to print, or null when the status says nothing
 * about a missing route.
 */
export function missingRouteError(urlPath: string, status: number): string | null {
  return status === 404
    ? `this codecast server has no ${urlPath} route — it needs a newer deployment.`
    : null;
}

export async function apiPost(
  deps: PublishDeps,
  urlPath: string,
  body: Record<string, unknown>,
  /** `describeError` turns a refusal code into words before it is shown. */
  opts: { read?: boolean; exitOnError?: boolean; describeError?: (error: string) => string } = {},
): Promise<any> {
  const { siteUrl, apiToken } = deps.getCliEndpoint();
  const doFetch = opts.read ? cliFetchRead : cliFetch;
  const response = await doFetch(`${siteUrl}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, ...body }),
  });
  const text = await response.text();
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    const message = missingRouteError(urlPath, response.status)
      ?? `API error (${response.status}): ${text.slice(0, 200)}`;
    if (opts.exitOnError === false) throw new Error(message);
    console.error(message);
    process.exit(1);
  }
  if (result?.error) {
    const error = opts.describeError ? opts.describeError(String(result.error)) : String(result.error);
    if (opts.exitOnError === false) throw new Error(error);
    console.error(`Error: ${error}`);
    process.exit(1);
  }
  return result;
}

/** A CLI POST, as index.ts's `cliPost` and the graph commands' `deps.cliPost`
 *  both shape it. */
export type CliPoster = (path: string, body: Record<string, any>, opts?: { throwOnError?: boolean }) => Promise<any>;

/**
 * A read whose extra arguments only ENRICH the answer, sent so that a
 * deployment older than this CLI costs the enrichment and nothing else.
 *
 * A Convex validator is a closed object (contracts/convexErrors.ts,
 * `unknownServerArg`), so an argument added to a call after the running
 * deployment was pushed does not arrive unread: the whole call is rejected.
 * For a read that is a bad trade. The viewer on `/cli/plans/get` only decides
 * which ephemeral steps read as ready, so losing it costs a line of the
 * answer — while losing the call costs `plan show`, `context`, `status` and
 * `wave` outright, which is exactly what happened. So a refused enrichment is
 * dropped and the read asked again, one argument per attempt because a
 * validator names one extra field at a time.
 *
 * ONLY for reads, and only for arguments the answer is still honest without.
 * An argument carrying the person's instruction — an effort, a label, a link,
 * a wait, the session a write is attributed to — must never come here:
 * dropping one writes something other than what was asked for. Those stay on
 * the loud path, where `cliErrorMessage` names the argument the deployment
 * cannot take yet. Failures are thrown, never printed: the caller decides
 * whether a read it only wanted for decoration is worth a word.
 */
export async function enrichedRead(
  post: CliPoster,
  route: string,
  base: Record<string, any>,
  enriching: Record<string, any>,
): Promise<any> {
  const offered = Object.keys(enriching).filter((k) => enriching[k] !== undefined);
  if (!offered.length) return await post(route, base, { throwOnError: true });
  try {
    return await post(route, { ...base, ...enriching }, { throwOnError: true });
  } catch (err) {
    // Only an argument THIS call offered as enrichment is droppable. A refusal
    // naming anything else (a field of `base`, which the read needs to mean
    // what it says) is the caller's to report.
    const refused = (err as { unknownArg?: string }).unknownArg;
    if (!refused || !offered.includes(refused)) throw err;
    const { [refused]: _dropped, ...rest } = enriching;
    return await enrichedRead(post, route, base, rest);
  }
}
