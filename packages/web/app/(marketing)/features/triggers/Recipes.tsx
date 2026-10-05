"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Body, C, Section } from "./ui";
import { Whole } from "../kit";

type Recipe = { name: string; cmd: string; why: ReactNode; color: string };

const RECIPES: Recipe[] = [
  {
    name: "Close the loop on a push", color: SOL.blue,
    cmd: 'cast trigger add "Check CI on the fix I just pushed; if red, read the log and fix it" --in 20m',
    why: <>Inline, once. The run needs this conversation&apos;s context about what was changed and why.</>,
  },
  {
    name: "Answer review comments while you sleep", color: SOL.magenta,
    cmd: 'cast trigger add "Address new review comments on #482: fix, push, reply" --on pr_comment --pr 482',
    why: <>Event, narrowed to one pull request. <C>cast pr shepherd on</C> goes further: one standing trigger that wakes the PR&apos;s owning session on every review, check and conflict.</>,
  },
  {
    name: "Triage production errors as they appear", color: SOL.red,
    cmd: 'cast trigger add - --on error_new --source sentry --spawn --title "Triage new errors" <<\'EOF\'\n…goal, steps, when to flag me…\nEOF',
    why: <>A fresh session per error with a full brief. It completes <C>--needs-attention</C> only when a person has to decide something.</>,
  },
  {
    name: "Watch a funnel, touch nothing", color: SOL.violet,
    cmd: 'cast trigger add "Watch the signup funnel and report anything off" --every 4h --spawn --safe',
    why: <>A standing watcher that can read and report but cannot change state. Clean runs post nothing.</>,
  },
  {
    name: "Drain a task queue overnight", color: SOL.green,
    cmd: 'cast trigger add "Take the next ready task, verify, open a PR" --every 30m --spawn \\\n  --precheck \'cast task ready --json | jq -e "length > 0"\'',
    why: <>The pattern behind the <C>/cast-loop</C> skill: the gate spends nothing when the queue is empty, and each run opens a PR without merging.</>,
  },
  {
    name: "A weekly piece of writing", color: SOL.cyan,
    cmd: 'cast trigger add - --every 7d --spawn --title "Weekly blog post" <<\'EOF\'\n…the brief…\nEOF',
    why: <>Codecast&apos;s own blog runs on one. <Link href="/blog/this-post-wrote-itself" className="underline" style={{ color: SOL.blue }}>This post wrote itself</Link> shows the trigger and the run that wrote it.</>,
  },
];

export function Recipes() {
  return (
    <Section
      id="recipes"
      tint
      title="What people point triggers at"
      lede="Each recipe is one command. The flags are the design: where the run happens, what it may touch, and when it bothers you."
    >
      <ol className="divide-y rounded-2xl overflow-hidden" style={{ borderColor: SOL.base2, backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
        {RECIPES.map((r) => (
          <li key={r.name} className="tg-recipe grid gap-3 p-5 sm:p-6 lg:grid-cols-[230px_minmax(0,1fr)_300px] lg:gap-6" style={{ borderColor: SOL.base2, ["--rc" as string]: r.color } as React.CSSProperties}>
            <h3 className="flex items-start gap-2.5 text-[16px] font-semibold leading-6" style={{ color: SOL.base03 }}>
              <span className="mt-2 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
              {r.name}
            </h3>
            <pre className="min-w-0 self-start whitespace-pre-wrap break-words rounded-lg px-3 py-2.5 font-mono text-[11.5px] leading-relaxed" style={{ backgroundColor: SOL.base03, color: SOL.base1 }}>
              <span style={{ color: SOL.green }}>$</span> <Whole text={r.cmd} />
            </pre>
            <Body className="!text-[14.5px] !leading-6">{r.why}</Body>
          </li>
        ))}
      </ol>
    </Section>
  );
}
