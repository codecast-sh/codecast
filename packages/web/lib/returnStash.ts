// A connector's return held across a sign-in. A connect that comes back to a
// browser not signed in to codecast (the desktop app opens connects in the
// system browser) must not lose its one-time code: the return page stashes
// it in this tab's sessionStorage, sends the person to sign in, and finishes
// the connect when sign-in brings them back. A copy in memory covers a
// browser whose storage refuses writes, for as long as the page lives.
//
// Slack (lib/slackReturn.ts) and Whisk (app/connect/whisk) each keep one
// stash under their own key.
import { captureException } from "@sentry/react";

/** What a connector's return carried: its code, our state, or its error. */
export type StashedReturn = { code: string | null; state: string | null; error: string | null };
export type ReturnStorage = Pick<Storage, "setItem" | "getItem" | "removeItem">;

export function browserStorage(): ReturnStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch (error) {
    captureException(error);
    return null;
  }
}

function sameReturn(a: StashedReturn | null, b: StashedReturn): boolean {
  return !!a && a.code === b.code && a.state === b.state && a.error === b.error;
}

/** One connector's stash, under `key`. `name` names it in error reports. */
export function returnStash(key: string, name: string) {
  let memory: StashedReturn | null = null;

  const stored = (store: ReturnStorage | null): StashedReturn | null => {
    try {
      const raw = store?.getItem(key);
      if (!raw) return null;
      const ret = JSON.parse(raw);
      if (!ret || ![ret.code, ret.state, ret.error].every((v) => v === null || typeof v === "string")) return null;
      return ret;
    } catch {
      captureException(new Error(`Could not read the pending ${name} connection`));
      return null;
    }
  };

  return {
    key,
    /** Hold a return just read from the URL. */
    put(ret: StashedReturn, store: ReturnStorage | null = browserStorage()): void {
      memory = ret;
      try {
        store?.setItem(key, JSON.stringify(ret));
      } catch (error) {
        captureException(error);
      }
    },
    /** The held return, unless the URL names a different state. */
    read(search: string, store: ReturnStorage | null = browserStorage()): StashedReturn | null {
      const ret = memory ?? stored(store);
      const state = new URLSearchParams(search).get("state");
      return ret && (state === null || state === ret.state) ? ret : null;
    },
    /** Whether the return survives a page load: a sign-in leaves the page. */
    canResume(ret: StashedReturn, store: ReturnStorage | null = browserStorage()): boolean {
      return sameReturn(stored(store), ret);
    },
    /** Drop the return once it is spent or refused; a newer one stays. */
    clear(ret: StashedReturn, store: ReturnStorage | null = browserStorage()): void {
      if (sameReturn(memory, ret)) memory = null;
      try {
        if (sameReturn(stored(store), ret)) store?.removeItem(key);
      } catch (error) {
        captureException(error);
      }
    },
  };
}
