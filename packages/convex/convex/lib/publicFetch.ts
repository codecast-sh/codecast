// A fetch from our servers to a page someone named: a link preview, or the
// hosted assistant's fetch_page. Every hop of a redirect passes the same
// public-host check as the link itself (parseLinkPreviewUrl: no private or
// literal IP hosts, no credentials in the URL, none of our own pages), and the
// body is read only up to a byte cap, so a hostile URL can neither reach
// inside the network nor hand back an unbounded body.
import type { PublicPage } from "@platform/assistant/web";
import { parseLinkPreviewUrl } from "@codecast/shared/entities";

export interface PublicFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** The content types to read; anything else answers null. */
  accept: RegExp;
  /** Stop reading once the text so far matches (a preview needs only the head). */
  stopAt?: RegExp;
  /** The fetch to use; tests pass a fake. */
  fetch?: typeof fetch;
}

/** A page as text; the shape @platform/assistant's fetch_page reads. */
export type { PublicPage };

/** The page at `start` as text, or null when the URL is not a public web
 *  page, the server refuses, or the content type is not one `accept` takes. */
export async function fetchPublicPage(start: string, opts: PublicFetchOptions): Promise<PublicPage | null> {
  const doFetch = opts.fetch ?? fetch;
  let url = parseLinkPreviewUrl(start);
  if (!url) return null;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const resp = await doFetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: opts.headers,
    });
    if (resp.status >= 300 && resp.status < 400) {
      const next = parseLinkPreviewUrl(new URL(resp.headers.get("location") ?? "", url).href);
      if (!next) return null;
      url = next;
      continue;
    }
    if (!resp.ok || !resp.body) return null;
    const contentType = resp.headers.get("content-type") ?? "";
    if (!opts.accept.test(contentType)) return null;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    let truncated = false;
    while (true) {
      if (bytes >= opts.maxBytes) {
        truncated = true;
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (opts.stopAt?.test(text)) break;
    }
    await reader.cancel().catch(() => {});
    return { text, url, contentType, truncated };
  }
  return null;
}
