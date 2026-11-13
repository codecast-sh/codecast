// The authenticated POST every CLI command and the daemon's capability
// reconciler makes against the codecast backend.
//
// It used to live in publish.ts, which meant that reaching for one HTTP helper
// pulled the whole `cast publish` command — its bundle walk, its watch loop,
// its thumbnailer — into the importer. That is how the daemon ended up with a
// CLI command group in its bundle, and it is what would have put the command
// group manifest there too. A leaf module with one dependency (cliHttp) ends
// the class. ct-49546.

import { serverErrorLine } from "./serverError.js";
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

/**
 * What to print when the backend answered with something other than JSON. A
 * 5xx here is the gateway in front of the backend speaking (an empty body or
 * an HTML page), which used to print as a bare "API error (502):".
 */
export function nonJsonError(urlPath: string, status: number, text: string, opts: { read?: boolean } = {}): string {
  const missing = missingRouteError(urlPath, status);
  if (missing) return missing;
  if (status === 502 || status === 503) {
    return `The codecast backend is not answering (HTTP ${status} from its gateway): it did not take the request, so most likely nothing ${opts.read ? "was read" : "was saved"}. Retry in a minute; cast status shows the connection.`;
  }
  if (status === 504) {
    return opts.read
      ? "The codecast backend took too long to answer (HTTP 504). Retry in a minute."
      : "The codecast backend took too long to answer (HTTP 504). The change may still have landed: read it back before sending it again.";
  }
  const body = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return `API error (${status})${body ? `: ${body}` : ", with an empty answer"}${status >= 500 ? ". Retry in a minute." : ""}`;
}

/**
 * Whether a server error is its argument validator refusing what this CLI
 * sent: the sign of a backend older than the CLI (an extra field it does not
 * know, or a value it types differently). With `field`, only a refusal that
 * names that field. Callers retry without the new argument.
 */
export function isOlderBackendRefusal(err: unknown, field?: string): boolean {
  const text = String((err as any)?.message ?? err ?? "");
  if (!/ArgumentValidationError|extra field|validator/i.test(text)) return false;
  return field === undefined || text.includes(`.${field}`) || text.includes(`\`${field}\``);
}

export async function apiPost(
  deps: PublishDeps,
  urlPath: string,
  body: Record<string, unknown>,
  /** `describeError` turns a refusal code into words before it is shown.
   *  `retries` re-sends a write that is safe to repeat (setting a value, not creating one) on a timeout or 5xx. */
  opts: { read?: boolean; exitOnError?: boolean; describeError?: (error: string) => string; retries?: number } = {},
): Promise<any> {
  const { siteUrl, apiToken } = deps.getCliEndpoint();
  const doFetch = opts.read ? cliFetchRead : cliFetch;
  const response = await doFetch(`${siteUrl}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, ...body }),
  }, opts.retries !== undefined ? { retries: opts.retries } : {});
  return readApiResult(response, urlPath, opts);
}

/** A 24 MB file on a slow uplink takes minutes, not the default request timeout. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** POST raw bytes (a bundle file for `cast publish`), the token in the header. */
export async function apiUpload(
  deps: PublishDeps,
  urlPath: string,
  body: Blob,
  opts: { exitOnError?: boolean } = {},
): Promise<any> {
  const { siteUrl, apiToken } = deps.getCliEndpoint();
  const response = await cliFetch(`${siteUrl}${urlPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": body.type || "application/octet-stream" },
    body,
  }, { timeoutMs: UPLOAD_TIMEOUT_MS });
  return readApiResult(response, urlPath, opts);
}

async function readApiResult(
  response: Response,
  urlPath: string,
  opts: { read?: boolean; exitOnError?: boolean; describeError?: (error: string) => string },
): Promise<any> {
  const text = await response.text();
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    const message = nonJsonError(urlPath, response.status, text, opts);
    if (opts.exitOnError === false) throw new Error(message);
    console.error(message);
    process.exit(1);
  }
  // A failure the backend itself answers (out of memory, a timeout) has no
  // `error` field, only Convex's `code`, so the status decides too.
  const raw = result?.error ?? (response.ok ? null : result?.code ?? `HTTP ${response.status}`);
  if (raw) {
    // A function's own refusal arrives wrapped in Convex's "Uncaught ConvexError: <sentence>" and a stack: show the sentence.
    const said = /Uncaught (?:Error|ConvexError): /.test(String(raw)) ? serverErrorLine(String(raw)) : String(raw);
    const error = opts.describeError ? opts.describeError(said) : said;
    if (opts.exitOnError === false) throw new Error(error);
    console.error(`Error: ${error}`);
    process.exit(1);
  }
  return result;
}
