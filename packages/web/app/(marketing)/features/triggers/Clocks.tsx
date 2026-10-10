"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Body, C, Section } from "./ui";
import { Shot } from "../kit";

/** A tiny strip that draws the shape of a schedule: one mark, a cadence, or marks at irregular events. */
function Shape({ kind, color }: { kind: "in" | "every" | "on"; color: string }) {
  const marks = kind === "in" ? [38] : kind === "every" ? [12, 30, 48, 66, 84] : [17, 23, 61, 88];
  return (
    <svg viewBox="0 0 100 24" className="w-full h-6" aria-hidden>
      <line x1="2" y1="12" x2="98" y2="12" stroke={SOL.base2} strokeWidth="1.5" />
      <circle cx="4" cy="12" r="2.4" fill={SOL.base1} />
      {kind === "in" && <line x1="4" y1="12" x2="38" y2="12" stroke={color} strokeWidth="1.5" strokeDasharray="2 3" />}
      {marks.map((x, i) =>
        kind === "on" ? (
          <path key={x} d={`M${x} 3 l-3 9 h4 l-3 9`} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" opacity={i === 1 ? 0.55 : 1} />
        ) : (
          <circle key={x} cx={x} cy="12" r="4" fill={color} />
        ),
      )}
    </svg>
  );
}

type Mode = { key: "in" | "every" | "on"; label: string; color: string; name: string; body: ReactNode; example: string };

const MODES: Mode[] = [
  {
    key: "in", label: "in…", color: SOL.blue, name: "Once, after a delay",
    body: <>Follow-through on work that just shipped: check CI, look at a deploy again, see whether a reviewer answered. Durations read like <C>30m</C>, <C>2h</C>, <C>1d</C>, and the form shows the clock time it will run. Set by an agent inside a session, the run comes back to that thread with everything it already knew.</>,
    example: "Check if CI is green on main · in 30m",
  },
  {
    key: "every", label: "every…", color: SOL.cyan, name: "On a cadence",
    body: <>A standing duty: a digest, a sweep, a watcher. Each run re-arms on its slot, so a daily check never drifts later by its own runtime. The trigger&apos;s page shows the next fire and how far through the cycle it is.</>,
    example: "Review open PRs and summarize findings · every 4h",
  },
  {
    key: "on", label: "on event", color: SOL.magenta, name: "When something happens",
    body: <>An event from GitHub, Linear, or your running product, picked from a list. An agent can narrow it to one repository, pull request or source. Events that arrive while a run is working are kept for the next run, not dropped.</>,
    example: "Respond to new PR review comments · on a PR comment in #482",
  },
];

const EVENT_GROUPS: { name: string; note: ReactNode; color: string; events: string[] }[] = [
  {
    name: "Pull requests", color: SOL.blue, note: <>GitHub integration. Defaults to the checkout&apos;s origin repo.</>,
    events: ["pr_opened", "pr_synchronize", "pr_ready", "pr_review_requested", "pr_review", "pr_approved", "pr_changes_requested", "pr_check_failed", "pr_checks_green", "pr_behind", "pr_conflict", "pr_comment", "pr_merged", "pr_closed", "push"],
  },
  {
    name: "Issues", color: SOL.green, note: <>Linear and GitHub issues alike.</>,
    events: ["issue_opened", "issue_assigned", "issue_labeled", "issue_commented", "issue_closed"],
  },
  {
    name: "Your running product", color: SOL.red, note: <>From a connected source: Sentry, PostHog, an SDK or an HTTP feed.</>,
    events: ["error_new", "error_regressed", "error_spike", "job_failed", "check_failed", "check_recovered", "metric_alert", "metric_recovered", "deploy"],
  },
];

export function Clocks() {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <Section
      id="fire"
      title="Three ways to fire"
      lede={<>Every trigger is the same thing: a prompt, a title, a short ID like <C>tr-42</C>, and a <b>When</b>. On the Triggers page, <b>New trigger</b> opens the form below. The agent in a conversation sets the same thing when you ask it to follow up later.</>}
    >
      <Shot
        className="mb-10 max-w-4xl"
        src="/features/triggers/new-trigger.webp"
        alt="The New trigger form on the Triggers page: Prompt, Title, When (now, in…, every…, on event) set to 30m, Agent claude with a read-only box, an optional Project, and a Set trigger button"
        width={1500}
        height={660}
        caption={<>The form: what to do, when (<b>now</b>, <b>in…</b>, <b>every…</b> or <b>on event</b>), which agent runs it, and whether it may change anything. A trigger set here runs on your machine&apos;s codecast daemon.</>}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        {MODES.map((m, i) => (
          <article
            key={m.key}
            className="tg-card flex flex-col rounded-2xl p-5 transition-transform"
            style={{ backgroundColor: "#fffbf0", border: `1px solid ${SOL.base2}`, animationDelay: `${i * 0.08}s` }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[22px] font-bold" style={{ color: m.color }}>{m.label}</span>
              <span className="text-[13px] font-medium" style={{ color: SOL.base01 }}>{m.name}</span>
            </div>
            <div className="mt-3"><Shape kind={m.key} color={m.color} /></div>
            <Body className="mt-3 flex-1">{m.body}</Body>
            <p className="mt-4 rounded-lg px-3 py-2 text-[13px] leading-5" style={{ backgroundColor: SOL.base2, color: SOL.base02 }}>{m.example}</p>
          </article>
        ))}
      </div>

      <div className="mt-12 rounded-2xl p-5 sm:p-6" style={{ backgroundColor: SOL.base03 }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-mono text-[17px] font-bold" style={{ color: SOL.base2 }}>29 events a trigger can wait for</h3>
          <span className="text-[12.5px]" style={{ color: SOL.base0 }}>the same list the form&apos;s <b>on event</b> picker offers</span>
        </div>
        <div className="mt-5 grid gap-6 md:grid-cols-3">
          {EVENT_GROUPS.map((g) => (
            <div key={g.name}>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
                <span className="font-semibold text-[14px]" style={{ color: SOL.base2 }}>{g.name}</span>
              </div>
              <p className="mt-1 text-[12.5px] leading-5" style={{ color: SOL.base0 }}>{g.note}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {g.events.map((e) => (
                  <span
                    key={e}
                    onMouseEnter={() => setHover(e)}
                    onMouseLeave={() => setHover(null)}
                    className="rounded-md px-1.5 py-0.5 font-mono text-[11.5px] transition-colors cursor-default"
                    style={{
                      color: hover === e ? SOL.base03 : SOL.base1,
                      backgroundColor: hover === e ? g.color : `color-mix(in srgb, ${g.color} 14%, ${SOL.base03})`,
                    }}
                  >
                    {e}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
