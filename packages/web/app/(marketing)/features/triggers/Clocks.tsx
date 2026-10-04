"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Added, Body, C, Section, Shell } from "./ui";

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

type Mode = { key: "in" | "every" | "on"; flag: string; color: string; name: string; body: ReactNode; cmd: string; when: string; title: string; extra?: string };

const MODES: Mode[] = [
  {
    key: "in", flag: "--in", color: SOL.blue, name: "Once, after a delay",
    body: <>Follow-through on work that just shipped. Durations read like <C>30m</C>, <C>2h</C>, <C>1d</C>.</>,
    cmd: 'cast trigger add "Check if CI is green on main" --in 30m', when: "in 30m", title: "Check if CI is green on main",
  },
  {
    key: "every", flag: "--every", color: SOL.cyan, name: "On a cadence",
    body: <>A standing duty. Pair it with <C>--in</C> to set the first run, which fixes the time of day. Each run re-arms on its slot, so a daily check never drifts later by its own runtime.</>,
    cmd: 'cast trigger add "Review open PRs and summarize findings" --every 4h --spawn', when: "every 4h", title: "Review open PRs and summarize findings",
  },
  {
    key: "on", flag: "--on", color: SOL.magenta, name: "When something happens",
    body: <>A webhook event from GitHub, Linear, or your running product. Narrow it with <C>--repo</C>, <C>--pr</C> or <C>--source</C>. Events that arrive while a run is working are kept for the next run, not dropped.</>,
    cmd: "cast trigger add \"Respond to new PR review comments\" --on pr_comment --pr 482", when: "on pr_comment in acme/web#482", title: "Respond to new PR review comments",
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
    name: "Your running product", color: SOL.red, note: <>From a source: Sentry, PostHog, an SDK or HTTP feed (<C>cast sources</C>).</>,
    events: ["error_new", "error_regressed", "error_spike", "job_failed", "check_failed", "check_recovered", "metric_alert", "metric_recovered", "deploy"],
  },
];

export function Clocks() {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <Section
      id="fire"
      title="Three ways to fire"
      lede={<>Every trigger is the same object: a prompt, a title, a short ID like <C>tr-42</C>, and one of three clocks. Pass <C>-</C> as the prompt to read a longer brief from a heredoc.</>}
    >
      <div className="grid gap-5 lg:grid-cols-3">
        {MODES.map((m, i) => (
          <article
            key={m.key}
            className="tg-card flex flex-col rounded-2xl p-5 transition-transform"
            style={{ backgroundColor: "#fffbf0", border: `1px solid ${SOL.base2}`, animationDelay: `${i * 0.08}s` }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[22px] font-bold" style={{ color: m.color }}>{m.flag}</span>
              <span className="text-[13px] font-medium" style={{ color: SOL.base01 }}>{m.name}</span>
            </div>
            <div className="mt-3"><Shape kind={m.key} color={m.color} /></div>
            <Body className="mt-3 flex-1">{m.body}</Body>
            <Shell className="mt-4" lines={[m.cmd]} out={<Added id={["tr-41", "tr-43", "tr-45"][i]} when={m.when} title={m.title} />} />
          </article>
        ))}
      </div>

      <div className="mt-12 rounded-2xl p-5 sm:p-6" style={{ backgroundColor: SOL.base03 }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-mono text-[17px] font-bold" style={{ color: SOL.base2 }}>29 events <C>--on</C> understands</h3>
          <span className="font-mono text-[12px]" style={{ color: SOL.base01 }}>cast trigger add --help prints the same list</span>
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
        <p className="mt-5 font-mono text-[12px] overflow-x-auto whitespace-nowrap" style={{ color: SOL.base0 }}>
          <span style={{ color: SOL.green }}>$</span> cast trigger add &quot;Triage the new error&quot; --on {hover ?? "error_new"}
          {(hover ?? "error_new").startsWith("pr_") || hover === "push" ? " --repo acme/web" : hover?.startsWith("issue_") ? "" : " --source sentry"} --spawn
        </p>
      </div>
    </Section>
  );
}
