import { memo, useMemo } from "react";
import Link from "next/link";
import { Phone } from "lucide-react";
import { callPathRef } from "@codecast/shared/contracts";
import { useInboxStore, useMyUserId } from "../../store/inboxStore";
import { useCallList } from "../../hooks/useSyncCalls";
import { navigateMainWindow } from "../../lib/desktop";
import { callTitle } from "../../lib/calls/roomLabels";
import { earlierCallsWith, peopleKey } from "../../lib/calls/callPeople";
import { firstName, fmtCallLength } from "./speakers";
import { fmtClock } from "../triggerCadence";

/** How many earlier calls the rail lists before it points at the rest. */
const SHOWN = 3;
const SCANNED = 50;

/**
 * The calls these same people had before, one row each, above the live
 * thread. The people are the ones seated now, so ringing someone in turns the
 * list to the calls of the larger group and their leaving turns it back; the
 * divider names whom it is matching. A row opens the call's own page.
 */
export const EarlierCalls = memo(function EarlierCalls({
  people,
  exclude,
  before,
  panel,
  onOpen,
}: {
  /** Who is seated now. */
  people: ReadonlyArray<{ id: string; name?: string }>;
  /** The call this thread is: it is the thread, not an earlier call. */
  exclude?: string | null;
  /** Only calls begun before this one. */
  before?: number;
  /** The desktop call window: a call opens in the main window. */
  panel?: boolean;
  onOpen?: () => void;
}) {
  const me = useMyUserId();
  const key = peopleKey(people.map((p) => p.id));
  const { calls } = useCallList(SCANNED);
  const rows = useMemo(
    () => earlierCallsWith(calls, key, { exclude, before, limit: SCANNED }),
    [calls, key, exclude, before],
  );
  const titles = useInboxStore((s) => rows.slice(0, SHOWN).map((c) => callTitle(c, s as any)).join("\0"));
  const others = people.filter((p) => p.id !== me && key.split(",").includes(p.id)).map((p) => firstName(p.name));
  if (rows.length === 0 || others.length === 0) return null;
  const shown = rows.slice(0, SHOWN);
  const names = titles.split("\0");
  // The stage covers the app, and the desktop call window has no app under
  // it: a row opens in the main window there, and the stage steps aside here.
  const follow = (e: React.MouseEvent, href: string) => {
    if (panel) {
      e.preventDefault();
      navigateMainWindow(href);
    }
    onOpen?.();
  };
  return (
    <div className="rt-earlier">
      <p className="rt-note rt-divider">Earlier with {others.join(" · ")}</p>
      <ul className="rt-earlier-list">
        {shown.map((c, i) => {
          const href = `/calls/${callPathRef(c)}`;
          return (
            <li key={String(c._id)}>
              <Link href={href} className="rt-earlier-row" onClick={(e) => follow(e, href)}>
                <Phone className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="rt-earlier-title">{names[i]}</span>
                <span className="rt-earlier-meta">
                  {fmtClock(c.started_at)} · {fmtCallLength(c.started_at, c.ended_at)}
                </span>
              </Link>
            </li>
          );
        })}
        {rows.length > SHOWN && (
          <li>
            <Link href="/calls" className="rt-earlier-row rt-earlier-more" onClick={(e) => follow(e, "/calls")}>
              {rows.length - SHOWN} more in Calls
            </Link>
          </li>
        )}
      </ul>
    </div>
  );
});
