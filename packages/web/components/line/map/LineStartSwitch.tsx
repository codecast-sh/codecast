"use client";
// The line's start switch (learning-loop.md LL5; line-map.md LX3): one control
// that says what it does ("Start problems on their own, up to N at a time"),
// turns it on or off, and states what that costs: how many problems would
// start at once and that each is a session spending model time. It sits on the
// map's Causes panel and on the project's Line tab. The switch and the slots
// live on the role that leads the project (caps.line_on, caps.cards); an edit
// is a store action (updateOrgRole) and paints at once.
import Link from "next/link";
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

/** Why the waiting problems that are not ready are held (lineFlow notReadyReasons). */
export type NotReady = ReadonlyArray<{ count: number; words: string }>;

/** The switch's cost as short lines (LL6): what turning it on starts now and
 *  what each costs, the pace after that, and how many are not ready and why.
 *  `held` is the count the third line opens, so a caller can link it.
 *  `roleOwnSwitchOff`: the role does not start work on its own yet, which
 *  turning the line on also turns on. Null when no role runs the line. The
 *  numbers are the sweep's own queue (problems ready to start, which can be
 *  fewer than the problems waiting); the limit a long queue meets is the
 *  role's sessions a day, so the pace is said in it. */
export type StartLines = { now: string; pace: string | null; held: { count: number; why: string } | null; also: string | null };

export function lineStartLines(a: LineAdmission, roleOwnSwitchOff = false, waiting: number | null = null, notReady: NotReady = [], ready: number | null = null): StartLines | null {
  if (!a.role) return null;
  const who = `@${a.role.handle}`;
  // `ready`, when the caller has it, is the client's own split of the waiting
  // problems (lineFlow waitingReadiness), the one the header count and the
  // Timeline's "Waiting on you or another run" filter read, so ready plus not ready is the waiting count.
  // The sweep's own queue (a.queued) is the fallback.
  const queued = ready ?? a.queued ?? null;
  const fromReasons = notReady.reduce((n, r) => n + r.count, 0);
  const heldCount = fromReasons || (waiting != null && queued != null && waiting > queued ? waiting - queued : 0);
  const held = heldCount ? { count: heldCount, why: notReady.map((r) => r.words).join(", ") } : null;
  const perDay = a.handsCap != null ? `${who} starts at most ${plural(a.handsCap, "session")} a day.` : null;
  if (a.on) {
    const running = a.busy != null ? `${a.busy} of ${a.slots} running now` : `Up to ${a.slots} at a time`;
    return { now: `${running}${queued ? `, ${queued} ready to start` : ""}. ${EACH}`, pace: perDay, held, also: null };
  }
  const also = roleOwnSwitchOff ? `It also lets ${who} start other work in its area on its own.` : null;
  const n = startsAtOnce({ ...a, queued });
  if (n == null) return { now: `On, ${who} starts the top problem whenever one of ${a.slots} places is free. ${EACH}`, pace: perDay, held, also };
  const q = queued ?? 0;
  if (q === 0) return { now: "Turning it on starts nothing yet: no problem is ready to start.", pace: null, held, also };
  const rest = q - n;
  const now = n === 0 ? `Turning it on starts nothing yet: ${q} ready wait${q === 1 ? "s" : ""} for a free place. ${EACH}` : `Turning it on starts ${plural(n, "problem")} right away. ${EACH}`;
  // The pace after today: the day's sessions, which is the limit a long queue meets.
  const pace = rest > 0 && a.handsCap
    ? `Then about ${a.handsCap} a day, so all ${q} ready take about ${plural(1 + Math.ceil(rest / a.handsCap), "day")}.`
    : rest > 0 ? `The other ${rest} start as places free up.` : null;
  return { now, pace, held, also };
}

const EACH = "Each is a session that spends model time until you decide on its fix.";

/** The lines as one paragraph, for a surface with room for a sentence only. */
export function lineStartCost(a: LineAdmission, roleOwnSwitchOff = false, waiting: number | null = null, notReady: NotReady = [], ready: number | null = null): string | null {
  const l = lineStartLines(a, roleOwnSwitchOff, waiting, notReady, ready);
  if (!l) return null;
  return [l.now, l.pace, l.held && heldWords(l.held), l.also].filter(Boolean).join(" ");
}

/** The ones not ready mostly wait on a person (a review, a question) or on a run that still holds them, so they are named for that. */
const heldVerb = (n: number) => (n === 1 ? "waits on you or another run" : "wait on you or another run");
const heldWords = (h: { count: number; why: string }) => `${h.count} ${heldVerb(h.count)}${h.why ? `: ${h.why}` : ""}.`;

const MIN_SLOTS = 1;
const MAX_SLOTS = 50;
/** Slots a person may set: whole numbers 1 to 50. */
function slotsError(text: string): string | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= MIN_SLOTS && n <= MAX_SLOTS ? null : "A whole number from 1 to 50";
}

const STEP_BTN = "inline-flex h-[20px] w-[20px] items-center justify-center rounded border border-sol-border/70 bg-sol-bg-alt/40 text-[13px] leading-none text-sol-text-muted hover:border-sol-text-dim hover:text-sol-text disabled:opacity-30 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/40";

/** `waiting`: every problem waiting on this line, when the caller shows that count beside the switch.
 *  `notReady`: why the ones not ready are held; `notReadyHref` opens them.
 *  `ready`: how many of the waiting ones are ready to start (lineFlow waitingReadiness). */
export function LineStartSwitch({ admit, compact, waiting = null, notReady = [], ready = null, notReadyHref }: { admit: Admit; compact?: boolean; waiting?: number | null; notReady?: NotReady; ready?: number | null; notReadyHref?: string }) {
  const a = admit.admission;
  if (!a?.role) return null;
  const paused = a.role.paused;
  const lines = lineStartLines(a, !autonomyOn(admit.role?.trust), waiting, notReady, ready);
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
        {/* How many at once is a setting: a stepper says so, and the number still takes typing. */}
        <span className="inline-flex items-center gap-1.5 text-sol-text" role="group" aria-label="Problems at a time">
          up to
          <button type="button" className={STEP_BTN} onClick={() => admit.setSlots(a.slots - 1)} disabled={a.slots <= MIN_SLOTS} aria-label="One fewer at a time" data-line-start-fewer>−</button>
          <InlineEdit text={String(a.slots)} label="Problems at a time" onCommit={commit} display={<span className="tabular-nums" data-line-start-slots>{a.slots}</span>} />
          <button type="button" className={STEP_BTN} onClick={() => admit.setSlots(a.slots + 1)} disabled={a.slots >= MAX_SLOTS} aria-label="One more at a time" data-line-start-more>+</button>
          at a time
        </span>
      </div>
      {lines && (
        <ul className="flex flex-col gap-0.5 text-[11.5px] leading-snug text-sol-text-dim break-words" data-line-start-cost>
          <li className="text-sol-text-muted" data-line-start-now>{lines.now}</li>
          {lines.pace && <li data-line-start-pace>{lines.pace}</li>}
          {lines.held && (
            <li data-line-start-held>
              {lines.held.count}{" "}
              {notReadyHref ? <Link href={notReadyHref} className="text-sol-blue hover:underline" data-line-start-held-link>{heldVerb(lines.held.count)}</Link> : heldVerb(lines.held.count)}
              {lines.held.why ? `: ${lines.held.why}.` : "."}
            </li>
          )}
          {lines.also && <li>{lines.also}</li>}
        </ul>
      )}
      {paused && <p className="text-[11.5px] leading-snug text-sol-orange" data-line-start-paused>@{a.role.handle} is paused; nothing starts until it resumes.</p>}
    </div>
  );
}
