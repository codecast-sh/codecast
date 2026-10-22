// Feeder: a workspace's line timeline (convex lineTimeline.page) into the
// `lineTimeline` collection. Never a subscription: the page reads the newest
// rows of eight churning tables, so a live query would re-run on every finding,
// run step and task edit for every open tab. The head is read once now and
// again every HEAD_POLL_MS while the page is visible; older pages are read on
// demand. Each answer says how far down it is complete (`cutoff`), which the
// view uses to keep what it shows gap free.
import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useServerAuthSettled } from "./useServerAuthSettled";

const HEAD_POLL_MS = 30_000;
const HEAD_ROWS = 40;
const PAGE_ROWS = 200;
/** How far before the previous poll a poll reads from, for a client clock behind the server's. */
const SKEW_MS = 60_000;
/** Pages one poll reads at most to close a burst; past them the gap is left and the next poll starts from now. */
const CATCH_UP_PAGES = 5;

export type LineTimelineFeed = {
  /** The time the loaded events are complete down to; null before the first answer. */
  floor: number | null;
  /** The workspace key the events belong to. */
  workspace: string | null;
  loading: boolean;
  /** No more pages: the oldest page reached the start of every source. */
  done: boolean;
  loadOlder: () => void;
};

export function useSyncLineTimeline(workspace?: string | null): LineTimelineFeed {
  const convex = useConvex();
  const settled = useServerAuthSettled();
  const { args, key } = useFeederWorkspace(workspace);
  // The ingest scope names the workspace kind beside the team: a team id alone resolves to the caller's personal one.
  const argsKey = args === "skip" || !settled ? null : JSON.stringify(args.team_id ? { workspace: "team", team_id: args.team_id } : { workspace: "personal" });
  const [state, setState] = useState<{ key: string | null; floor: number | null; done: boolean; loading: boolean }>({ key: null, floor: null, done: false, loading: false });
  const busy = useRef(false);

  const read = useCallback(async (before: number | undefined, rows: number, after?: number) => {
    if (!argsKey) return null;
    const res = await convex.query(api.lineTimeline.page, { ...JSON.parse(argsKey), ...(before != null ? { before } : {}), ...(after != null ? { after } : {}), rows });
    if (res.events.length) useInboxStore.getState().syncTable("lineTimeline", res.events as any, { isDelta: true } as any);
    return res;
  }, [convex, argsKey]);

  // The head: now, then on a timer while the page is visible.
  useEffect(() => {
    if (!argsKey) return;
    let stopped = false;
    // The first read runs whatever the page's visibility; a repeat waits for the page to be seen. A repeat reads only
    // what changed since the one before (`after`, a minute early for clocks that disagree), and reads on down while a
    // burst fills its page, so what it holds stays gap free.
    let since: number | null = null;
    let running = false;
    const head = async () => {
      if (running || (since != null && document.visibilityState !== "visible")) return;
      running = true;
      const started = Date.now();
      try {
        if (since == null) {
          const res = await read(undefined, HEAD_ROWS);
          if (stopped || !res) return;
          // The head never lowers a floor an older page already reached.
          setState((s) => (s.key === argsKey && s.floor != null && s.floor <= res.cutoff ? s : { key: argsKey, floor: res.cutoff, done: res.cutoff === 0, loading: false }));
        } else {
          const after = since - SKEW_MS;
          let before: number | undefined;
          for (let i = 0; i < CATCH_UP_PAGES; i++) {
            const res = await read(before, PAGE_ROWS, after);
            if (stopped || !res || res.cutoff <= after) break;
            before = res.cutoff;
          }
        }
        since = started;
      } catch (e) {
        console.warn("[feeder:lineTimeline] head failed", e);
      } finally {
        running = false;
      }
    };
    head();
    const timer = setInterval(head, HEAD_POLL_MS);
    document.addEventListener("visibilitychange", head);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", head); };
  }, [argsKey, read]);

  const floor = state.key === argsKey ? state.floor : null;
  const done = state.key === argsKey && state.done;
  const loadOlder = useCallback(() => {
    if (busy.current || floor == null || done) return;
    busy.current = true;
    setState((s) => ({ ...s, loading: true }));
    read(floor, PAGE_ROWS).then((res) => {
      if (!res) return;
      setState((s) => ({ key: argsKey, floor: Math.min(s.floor ?? res.cutoff, res.cutoff), done: res.cutoff === 0, loading: false }));
    }).catch((e) => {
      console.warn("[feeder:lineTimeline] page failed", e);
      setState((s) => ({ ...s, loading: false }));
    }).finally(() => { busy.current = false; });
  }, [floor, done, argsKey, read]);

  return { floor, workspace: key, loading: state.loading, done, loadOlder };
}
