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
  opts: { read?: boolean; exitOnError?: boolean } = {},
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
    if (opts.exitOnError === false) throw new Error(String(result.error));
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  return result;
}
