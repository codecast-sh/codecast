"use client";
// The line's start switch (learning-loop.md LL5; line-map.md LX3): one control
// that says what it does ("Start problems on their own, up to N at a time"),
// turns it on or off, and states what that costs: how many problems would
// start at once and that each is a session spending model time. It sits on the
// map's Causes panel and on the project's Line tab. The switch and the slots
// live on the role that leads the project (caps.line_on, caps.cards); an edit
// is a store action (updateOrgRole) and paints at once.
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import type { LineAdmission } from "../../../lib/lineFlow";
import { InlineEdit } from "../settings/LineValueRow";
import type { useLineAdmission } from "./useLineAdmission";

type Admit = ReturnType<typeof useLineAdmission>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How many problems turning the line on starts at once: the waiting ones,
 *  bounded by the free places and today's sessions left. Null while the
 *  queue is unknown. */
export function startsAtOnce(a: LineAdmission): number | null {
  if (a.queued == null) return null;
  const free = Math.max(0, a.slots - (a.busy ?? 0));
  const handsLeft = a.hands != null && a.handsCap != null ? Math.max(0, a.handsCap - a.hands) : Infinity;
  return Math.min(a.queued, free, handsLeft);
}

/** The cost of the switch's position, in plain words. `roleOwnSwitchOff`: the
 *  role does not start work on its own yet, which turning the line on also
 *  turns on. Null when no role runs the line. The numbers are the sweep's own
 *  queue: problems ready to start, which can be fewer than the problems
 *  waiting (some are not ready yet), so they are named "ready to start". The
 *  limit people hit is the role's sessions a day, so the pace is said in it. */
export function lineStartCost(a: LineAdmission, roleOwnSwitchOff = false, waiting: number | null = null): string | null {
  if (!a.role) return null;
  const words = lineStartWords(a, roleOwnSwitchOff);
  // The header counts every waiting problem, the switch the ready ones: say how the two numbers relate (LL6).
  const queued = a.queued ?? null;
  const of = words && waiting != null && queued != null && waiting > queued
    ? `${queued} of the ${waiting} waiting ${queued === 1 ? "is" : "are"} ready to start; the other ${waiting - queued} ${waiting - queued === 1 ? "is" : "are"} not ready yet. `
    : "";
  return words ? `${of}${words}` : null;
}

function lineStartWords(a: LineAdmission, roleOwnSwitchOff: boolean): string | null {
  if (!a.role) return null;
  const who = `@${a.role.handle}`;
  const each = "Each is a session that spends model time until you decide on its fix.";
  const perDay = a.handsCap != null ? `${who} starts at most ${plural(a.handsCap, "session")} a day` : null;
  if (a.on) {
    const running = a.busy != null ? `${a.busy} of ${a.slots} running now` : `Up to ${a.slots} at a time`;
    const waiting = a.queued ? `, ${a.queued} ready to start` : "";
    return `${running}${waiting}. ${each}${perDay ? ` ${perDay}.` : ""}`;
  }
  const also = roleOwnSwitchOff ? ` It also lets ${who} start other work in its area on its own.` : "";
  const n = startsAtOnce(a);
  if (n == null) return `On, ${who} starts the top problem whenever one of ${a.slots} places is free. ${each}${perDay ? ` ${perDay}.` : ""}${also}`;
  const queued = a.queued ?? 0;
  let first: string;
  if (queued === 0) first = "Nothing is ready to start, so turning this on starts nothing yet; problems start as they become ready.";
  else {
    const now = n === 0 ? `Turning this on starts nothing yet: ${queued} ready to start wait${queued === 1 ? "s" : ""} for a free place.` : `Turning this on starts ${plural(n, "problem")} right away.`;
    const rest = queued - n;
    // The pace after today: the day's sessions, which is the limit a long queue meets.
    const pace = rest > 0 && a.handsCap
      ? ` ${n > 0 ? "After that " : ""}${who} starts at most ${a.handsCap} a day as places free up, so the ${queued} ready to start take about ${plural(1 + Math.ceil(rest / a.handsCap), "day")}.`
      : rest > 0 ? ` The other ${rest} start as places free up.` : "";
    first = `${now}${pace}`;
  }
  return `${first} ${each}${also}`;
}

/** Slots a person may set: whole numbers 1 to 50. */
function slotsError(text: string): string | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= 50 ? null : "A whole number from 1 to 50";
}

/** `waiting`: every problem waiting on this line, when the caller shows that count beside the switch. */
export function LineStartSwitch({ admit, compact, waiting = null }: { admit: Admit; compact?: boolean; waiting?: number | null }) {
  const a = admit.admission;
  if (!a?.role) return null;
  const paused = a.role.paused;
  const cost = lineStartCost(a, !autonomyOn(admit.role?.trust), waiting);
  const commit = (text: string) => {
    const err = slotsError(text);
    if (err) return err;
    const n = Number(text.trim());
    if (n !== a.slots) admit.setSlots(n);
    return null;
  };
  return (
    <div className={compact ? "flex flex-col gap-1" : "flex flex-col gap-1.5"} data-line-start={a.on ? "on" : "off"}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-sol-text">
        <button
          type="button"
          role="switch"
          aria-checked={a.on}
          aria-label="Start problems on their own"
          onClick={() => admit.setOn(!a.on)}
          className="group inline-flex items-center gap-2 rounded-md py-0.5 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/40"
          data-line-start-switch
        >
          <span
            aria-hidden
            className={`relative inline-flex h-[16px] w-[28px] shrink-0 rounded-full border transition-colors duration-150 ${a.on ? "bg-sol-green/80 border-sol-green/80" : "bg-sol-text-dim/25 border-sol-text-dim/60 group-hover:border-sol-text-muted"}`}
          >
            <span className={`absolute top-[1px] h-[12px] w-[12px] rounded-full bg-sol-text shadow-sm transition-transform duration-150 ${a.on ? "translate-x-[13px]" : "translate-x-[1px]"}`} />
          </span>
          <span>Start problems on their own</span>
        </button>
        <span className="inline-flex items-center gap-1.5 text-sol-text">
          up to
          <InlineEdit text={String(a.slots)} label="Problems at a time" onCommit={commit} display={<span className="tabular-nums" data-line-start-slots>{a.slots}</span>} />
          at a time
        </span>
      </div>
      {cost && <p className="text-[11.5px] leading-snug text-sol-text-dim break-words" data-line-start-cost>{cost}</p>}
      {paused && <p className="text-[11.5px] leading-snug text-sol-orange" data-line-start-paused>@{a.role.handle} is paused; nothing starts until it resumes.</p>}
    </div>
  );
}
