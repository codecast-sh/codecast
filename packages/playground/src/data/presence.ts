// Being here: beat while the page is open (with the version in view, null for
// live), leave on pagehide, and read who else is here. Who is typing is a
// read of its own, made by the parts that show it, with a clock that ticks
// only while someone types, so a typing ping never re-renders the page.
import { useEffect, useMemo } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { HereEntry } from "../../convex/presence";
import { PRESENCE, isTyping } from "../../convex/lib/presence";
import { useIdentity, useVisitorMutation, useVisitorQuery } from "../lib/identity";
import { useNow } from "../lib/useNow";

export function usePresenceBeat(appId: Id<"apps"> | undefined, viewing: number | null): void {
  const beat = useVisitorMutation(api.presence.heartbeat);
  const leave = useVisitorMutation(api.presence.leave);
  useEffect(() => {
    if (!appId) return;
    const send = () => beat({ app_id: appId, viewing_version: viewing }).catch(() => {});
    send();
    const t = setInterval(send, PRESENCE.heartbeatMs);
    // A background tab's timers slow to about once a minute, so its row
    // lapses; coming back into view says "here" at once.
    const back = () => document.visibilityState === "visible" && send();
    const bye = () => leave({ app_id: appId }).catch(() => {});
    document.addEventListener("visibilitychange", back);
    addEventListener("pagehide", bye);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", back);
      removeEventListener("pagehide", bye);
    };
  }, [appId, viewing, beat, leave]);

  // Leaving the app (not just changing what is in view) says goodbye.
  useEffect(() => {
    if (!appId) return;
    return () => {
      leave({ app_id: appId }).catch(() => {});
    };
  }, [appId, leave]);
}

export type Here = {
  entries: HereEntry[];
  /** Everyone here, you first. */
  people: HereEntry["visitor"][];
  /** Rows by visitor id. */
  byId: Map<string, HereEntry>;
};

const NOBODY: HereEntry[] = [];

export function useHere(appId: Id<"apps"> | undefined): Here {
  const { me } = useIdentity();
  const entries = useVisitorQuery(api.presence.here, appId ? { app_id: appId } : "skip") ?? NOBODY;
  return useMemo(() => {
    const byId = new Map(entries.map((e) => [e.visitor.id as string, e]));
    const others = entries.filter((e) => e.visitor.id !== me.id).map((e) => e.visitor);
    const meHere = byId.get(me.id)?.visitor ?? me;
    return { entries, people: [meHere, ...others], byId };
  }, [entries, me]);
}

const NOT_TYPING: { visitor_id: string; until: number }[] = [];

/** Who is typing in the app now, by visitor id (you too, when you are). */
export function useTyping(appId: Id<"apps">): Set<string> {
  const rows = useVisitorQuery(api.presence.typing, { app_id: appId }) ?? NOT_TYPING;
  const anyone = rows.some((r) => isTyping(r, Date.now()));
  const now = useNow(anyone ? 1000 : 60_000);
  return useMemo(() => new Set(rows.filter((r) => isTyping(r, now)).map((r) => r.visitor_id as string)), [rows, now]);
}
