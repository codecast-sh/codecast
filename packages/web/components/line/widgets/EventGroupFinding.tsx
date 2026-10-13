"use client";
// An event source's finding, opened in place: the error group it was filed for
// (an eg-N), as the product reported it. Its facts on one row, the newest
// stack with the product's own frames lit, and the newest samples. The group's
// own page (Ops > Issues) is one small link away for the rest.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { detailGone, useOpsGroup, useOpsSamples, useSyncOpsGroup } from "../../../hooks/useSyncOps";
import { readStack } from "../../ops/opsModel";
import { opsHref } from "../../ops/opsPaths";
import { dayTimeWords, type EventFinding } from "../../../lib/line/problemPage";

/** Samples shown under the stack; the group's page has every kept one. */
const SAMPLES_SHOWN = 3;

export function EventGroupFinding({ event, said }: { event: EventFinding; /** The finding row's own words: a sample that only repeats them shows its place instead. */ said?: string }) {
  const feed = useSyncOpsGroup(event.group);
  const group = useOpsGroup(event.group);
  const samples = useOpsSamples(group?._id);
  const stack = samples.find((s) => s.stack)?.stack;
  const lines = useMemo(() => readStack(stack), [stack]);
  const [all, setAll] = useState(false);
  const outside = lines.filter((l) => l.frame && !l.in_app).length;
  const shown = all ? lines : lines.filter((l) => !l.frame || l.in_app);
  // Gone from its source, or not readable here: the facts the finding carries are all there is.
  const gone = detailGone(feed) || (!group && !!feed.error);

  return (
    <div className="eg" data-line-event-group={event.group}>
      <dl className="eg-facts">
        <div><dt>Group</dt><dd>{group ? <Link className="lw-link eg-ref" href={opsHref.issue(event.group)} data-line-event-open>{event.group}<ArrowUpRight className="w-3 h-3" aria-hidden /></Link> : <code>{event.group}</code>}</dd></div>
        {group && <div><dt>Status</dt><dd data-tone={group.status === "open" ? "bad" : undefined}>{group.status}</dd></div>}
        <div><dt>Seen</dt><dd className="lw-num">{(group?.count ?? event.count ?? 0).toLocaleString()}</dd></div>
        {group && <div><dt>Last</dt><dd>{dayTimeWords(group.last_seen)}</dd></div>}
        {(group?.last_release ?? event.release) && <div><dt>Release</dt><dd><code>{group?.last_release ?? event.release}</code></dd></div>}
        {(group?.culprit ?? event.culprit) && <div><dt>Culprit</dt><dd><code>{group?.culprit ?? event.culprit}</code></dd></div>}
      </dl>
      {gone ? <span className="eg-dim" data-line-event-gone>Group not found</span> : !group ? <span className="eg-dim"><span className="lw-spin" aria-hidden /> {event.group}</span> : (
        <>
          {lines.length > 0 && (
            <div className="eg-stack" data-line-event-stack>
              {shown.map((l, i) => <div key={i} data-frame={l.frame ? "" : undefined} data-inapp={l.in_app ? "" : undefined}>{l.text}</div>)}
              {outside > 0 && <button type="button" className="lw-link eg-more" onClick={() => setAll(!all)}>{all ? "Your code only" : `${outside} library ${outside === 1 ? "frame" : "frames"}`}</button>}
            </div>
          )}
          {samples.length > 0 && (
            <ul className="eg-samples" aria-label="Newest samples">
              {samples.slice(0, SAMPLES_SHOWN).map((s) => (
                <li key={s._id}>
                  <time className="lw-num">{dayTimeWords(s.at)}</time>
                  <span className="eg-msg">{s.message && s.message !== group.title && s.message !== said ? s.message : s.url ?? ""}</span>
                  {s.release && <code>{s.release}</code>}
                  {(s.user?.email ?? s.user?.name) && <span className="eg-dim">{s.user?.email ?? s.user?.name}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
