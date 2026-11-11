import { internalHostRefusal } from "./guardedFetch";

/**
 * Why the server will not fetch a live reader's url, or null when it may. A
 * member declares the url, and the fetch runs from the backend's own network
 * (a self-hosted one sits beside private services), so only http(s) to a public
 * host name or address is read (lib/guardedFetch's literal-host check). The
 * fetch itself also checks the addresses a name resolves to and every redirect.
 */
export function liveReaderUrlRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "the live reader url is not a url";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "the live reader url must be http or https";
  if (url.username || url.password) return "the live reader url must not carry credentials";
  return internalHostRefusal(raw) ? "the live reader url must name a public host" : null;
}
