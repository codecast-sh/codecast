// How an occurrence row names one sample: its page and its person. A leaf
// module (types only) so the phone's issue screen reads it without the web's
// view model and the components that come with it.
import type { OpsSample } from "./opsTypes";

/** A url as a row shows it: the path (and query), without the origin every row shares. */
export function shortUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

export const sampleWho = (x: Pick<OpsSample, "user">) => x.user?.email ?? x.user?.name ?? x.user?.id ?? null;
