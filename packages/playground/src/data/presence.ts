// Being here: beat while the page is open (with the version in view, null for
// live), leave on pagehide, and read who else is here with a clock that ticks
// only while someone is typing.
import { useEffect, useMemo } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { HereEntry } from "../../convex/presence";
import { PRESENCE } from "../../convex/lib/presence";
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
    const bye = () => leave({ app_id: appId }).catch(() => {});
    addEventListener("pagehide", bye);
    return () => {
      clearInterval(t);
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
  typing: Set<string>;
  /** Others typing, in arrival order. */
  typers: HereEntry["visitor"][];
  /** Rows by visitor id. */
  byId: Map<string, HereEntry>;
};

export function useHere(appId: Id<"apps"> | undefined): Here {
  const { me } = useIdentity();
  const entries = useVisitorQuery(api.presence.here, appId ? { app_id: appId } : "skip") ?? [];
  const anyTyping = entries.some((e) => e.typing_until > Date.now());
  const now = useNow(anyTyping ? 1000 : 60_000);
  return useMemo(() => {
    const byId = new Map(entries.map((e) => [e.visitor.id as string, e]));
    const others = entries.filter((e) => e.visitor.id !== me.id).map((e) => e.visitor);
    const meHere = byId.get(me.id)?.visitor ?? me;
    const typing = new Set(entries.filter((e) => e.typing_until > now).map((e) => e.visitor.id as string));
    return { entries, people: [meHere, ...others], typing, typers: others.filter((p) => typing.has(p.id)), byId };
  }, [entries, me, now]);
}
