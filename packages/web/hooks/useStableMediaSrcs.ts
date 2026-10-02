import { useRef, useState } from "react";
import { useWatchEffect } from "./useWatchEffect";

// The src a <video> plays a call recording from, held steady.
//
// A recording's URL is not a constant. On the call page it is presigned per
// window (convex lib/r2.ts) and the query hands a new one four times an hour;
// on the public share page it is a redirect that signs a ten-minute URL into
// the bucket on every request. A media element handed a new src starts over
// (black frame, buffer gone, position lost), and one whose URL has expired
// errors on its next range request. So each file keeps the URL it was first
// loaded with, and moves only when the element refuses it:
//
//   - the query already has a newer URL: take it;
//   - the URL is the redirect (unsigned, so the same address mints a fresh
//     link): ask it again under a retry mark, a few times at most;
//   - otherwise the file waits, marked failed, and takes the next URL the
//     query hands it (the window rolling over).
//
// A presigned URL is never marked: its signature covers every query
// parameter, and an added one would be refused.

const MAX_RETRIES = 3;

const presigned = (url: string) => /[?&]X-Amz-Signature=/i.test(url);

function withRetry(url: string, n: number): string {
  const u = url.replace(/([?&])r=\d+(&|$)/, (_, lead, tail) => (tail ? lead : "")).replace(/[?&]$/, "");
  return `${u}${u.includes("?") ? "&" : "?"}r=${n}`;
}

export type StableMediaSrcs = {
  /** The URL to play a file from; undefined until it has one. */
  srcOf: (file: { id: string; url: string | null }) => string | undefined;
  /** The element for a file refused its URL. True when another URL is on its
   *  way (re-key the element on srcOf), false when there is nothing left. */
  refused: (id: string) => boolean;
  /** The element loaded: its retries start over. */
  loaded: (id: string) => void;
  /** Gave up on a file: refused with nothing left to try. */
  dead: (id: string) => boolean;
};

export function useStableMediaSrcs(files: readonly { id: string; url: string | null }[]): StableMediaSrcs {
  const srcs = useRef(new Map<string, string>());
  const tries = useRef(new Map<string, number>());
  const failed = useRef(new Set<string>());
  const [, bump] = useState(0);

  const latest = (id: string) => files.find((f) => f.id === id)?.url ?? null;
  const swap = (id: string, url: string) => {
    srcs.current.set(id, url);
    failed.current.delete(id);
    bump((n) => n + 1);
  };

  // A file left waiting takes the next URL the query hands it.
  useWatchEffect(() => {
    for (const id of failed.current) {
      const fresh = latest(id);
      if (fresh && fresh !== srcs.current.get(id)) swap(id, fresh);
    }
  }, [files]);

  return {
    srcOf: (f) => {
      if (!srcs.current.has(f.id) && f.url) srcs.current.set(f.id, f.url);
      return srcs.current.get(f.id);
    },
    refused: (id) => {
      const current = srcs.current.get(id);
      const fresh = latest(id);
      if (fresh && current && fresh !== current && !current.startsWith(`${fresh}${fresh.includes("?") ? "&" : "?"}r=`)) {
        swap(id, fresh);
        return true;
      }
      const base = fresh ?? current;
      const n = tries.current.get(id) ?? 0;
      if (base && !presigned(base) && n < MAX_RETRIES) {
        tries.current.set(id, n + 1);
        swap(id, withRetry(base, n + 1));
        return true;
      }
      failed.current.add(id);
      bump((k) => k + 1);
      return false;
    },
    loaded: (id) => {
      tries.current.delete(id);
    },
    dead: (id) => failed.current.has(id),
  };
}
