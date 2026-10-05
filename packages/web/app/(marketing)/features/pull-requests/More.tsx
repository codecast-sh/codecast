"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { InstallTabs } from "@/components/install-tabs";
import { FEATURE_DEEP_DIVES, featureHref } from "../catalog";
import { guideHref } from "../../documentation/guides/guides";
import { Browser, C, Face, PAPER, PEOPLE, PrIcon, SessionPill } from "./kit";
import { PR_NUMBER, PR_TITLE, REPO } from "./data";

// ── 6. /cast-ship ────────────────────────────────────────────────────────────

const SHIP: { title: string; cmd?: string; body: ReactNode; loop?: boolean }[] = [
  { title: "Check", body: <>Runs the checks the repository defines and fixes what they find. Leaves out changes that belong to other sessions.</> },
  { title: "Commit", body: <>Topical commits with short messages that say what changed and why. Never one commit for unrelated work.</> },
  { title: "Open", cmd: "gh pr create", body: <>The description: the goal, what changed and why, how it was verified, what to read first, and the session link from <C>cast link</C>.</> },
  { title: "Shepherd", cmd: "cast pr shepherd on", body: <>Binds the session, then pins it dormant: &ldquo;Shepherding PR #n; wakes on review, checks and merge&rdquo;.</> },
  { title: "On each wake", loop: true, body: <>Fix or answer each thread, push, resolve the settled ones. A thread it disagreed with gets a reply and stays open. A red check: read the failing log, fix, push.</> },
  { title: "Merged", cmd: "cast pr shepherd off", body: <>Closes the task with <C>cast task done</C> and pins the session done. Approved and green but nobody asked it to merge? It says the merge is yours and waits.</> },
];

export function Ship() {
  return (
    <div>
      <ol className="grid gap-px overflow-hidden rounded-xl border sm:grid-cols-2 lg:grid-cols-6" style={{ borderColor: SOL.base2, backgroundColor: SOL.base2 }}>
        {SHIP.map((s, i) => (
          <li key={s.title} className="relative flex flex-col p-4" style={{ backgroundColor: s.loop ? "rgba(42,161,152,0.07)" : PAPER }}>
            <div className="flex items-center gap-2 font-mono text-[12px]" style={{ color: s.loop ? SOL.cyan : SOL.base1 }}>
              <span className="tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              {s.loop && <span aria-label="repeats">↻ repeats</span>}
            </div>
            <div className="mt-1.5 font-mono text-[15px] font-semibold" style={{ color: SOL.base03 }}>{s.title}</div>
            {s.cmd && <div className="mt-1 font-mono text-[11px]" style={{ color: SOL.cyan }}>{s.cmd}</div>}
            <p className="mt-2 text-[13.5px] leading-[1.6]" style={{ color: SOL.base01 }}>{s.body}</p>
          </li>
        ))}
      </ol>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Callout title="Say it in the session">
          Type <C>/cast-ship</C> when the work is done. It takes the work from a finished change to a shepherded pull request and stays with it until the merge.
        </Callout>
        <Callout title="Only the feedback">
          <C>/cast-ship feedback</C> skips committing and opening: it works the open threads on the current pull request once and reports which were fixed, answered, or left open and why.
        </Callout>
      </div>
    </div>
  );
}

function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border px-4 py-3" style={{ borderColor: SOL.base2, backgroundColor: PAPER }}>
      <div className="font-mono text-[13px] font-semibold" style={{ color: SOL.base03 }}>{title}</div>
      <p className="mt-1 text-[14px] leading-[1.65]" style={{ color: SOL.base01 }}>{children}</p>
    </div>
  );
}

// ── 7. public repository pages ───────────────────────────────────────────────

export function PublicRepo() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-center">
      <Browser url={`codecast.sh/r/${REPO}/pull/${PR_NUMBER}`}>
        <div className="flex items-center gap-4 px-4 pt-3 text-[11.5px]" style={{ color: SOL.base00 }}>
          <span className="font-semibold" style={{ color: SOL.base03 }}>{REPO}</span>
          {["Code", "Pulls", "Sessions", "Commits"].map((t) => (
            <span key={t} className="pb-2" style={t === "Pulls" ? { color: SOL.base03, borderBottom: `2px solid ${SOL.green}` } : undefined}>{t}</span>
          ))}
        </div>
        <div className="px-4 py-4" style={{ borderTop: `1px solid ${SOL.base2}` }}>
          <div className="flex items-start gap-2 text-[14px] font-semibold" style={{ color: SOL.base03 }}>
            <PrIcon className="h-4 w-4 mt-[2px] shrink-0" /> <span>{PR_TITLE} <span className="whitespace-nowrap" style={{ color: SOL.base1, fontWeight: 400 }}>#{PR_NUMBER}</span></span>
          </div>
          <div className="mt-4 space-y-2 text-[12px]">
            <div className="text-[10px] uppercase tracking-wider" style={{ color: SOL.base1 }}>Sessions</div>
            <div className="flex flex-wrap items-center gap-2">
              <SessionPill>Webhook retry backoff</SessionPill>
              <span style={{ color: SOL.base1 }}>public, opens the transcript</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded border px-1.5 py-[1px] text-[10.5px]" style={{ borderColor: SOL.base2, color: SOL.base00 }}>
                <Face name="Lena" color={PEOPLE.lena} size={13} /> Lena&apos;s session on Sep 20
              </span>
              <span style={{ color: SOL.base1 }}>private, named but not linked</span>
            </div>
          </div>
        </div>
      </Browser>
      <div className="space-y-4 text-[15.5px] leading-[1.7]" style={{ color: SOL.base01 }}>
        <p>
          A public GitHub repository connected to codecast gets a public page at <C>/r/owner/repo</C>: its files, commits, pull
          requests and the sessions behind them, readable by someone who has never signed in.
        </p>
        <p>
          A session shows up there by title, with its transcript, only after its owner runs <C>cast share &lt;id&gt; --public</C>.
          Every other session is named as somebody&apos;s session on a date, with no link.
        </p>
        <p>
          Codecast&apos;s own repository is one:{" "}
          <a href="/r/codecast-sh/codecast" className="font-mono text-[14px] underline underline-offset-4" style={{ color: SOL.blue }}>codecast.sh/r/codecast-sh/codecast</a>
        </p>
      </div>
    </div>
  );
}

// ── 8. whose name is on it ───────────────────────────────────────────────────

const TOKENS: [string, string, string][] = [
  ["Comment, reply, edit, delete", "the GitHub app", SOL.base00],
  ["Resolve or reopen a thread", "you, then the app", SOL.blue],
  ["Review with a verdict", "you only", SOL.magenta],
  ["Merge, close, reopen, draft, reviewers, title, body", "you, then the app", SOL.blue],
];

export function Names() {
  return (
    <div className="grid gap-8 lg:grid-cols-2 items-start">
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: SOL.base2, backgroundColor: PAPER }}>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-2 font-mono text-[10.5px] uppercase tracking-wider" style={{ color: SOL.base1, backgroundColor: "rgba(238,232,213,0.5)" }}>
          <span>The act</span><span>Whose token</span>
        </div>
        {TOKENS.map(([act, who, color]) => (
          <div key={act} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-3 text-[14px]" style={{ borderTop: `1px solid ${SOL.base2}` }}>
            <span style={{ color: SOL.base02 }}>{act}</span>
            <span className="font-mono text-[12.5px] whitespace-nowrap" style={{ color }}>{who}</span>
          </div>
        ))}
      </div>
      <ul className="space-y-4 text-[15px] leading-[1.65]" style={{ color: SOL.base01 }}>
        <Rule title="A verdict is a judgement.">It goes out under the GitHub account of the person the agent runs as. Without a connected account the command stops and says so; there is no fallback to the app.</Rule>
        <Rule title="GitHub decides, in its own words.">It refuses an approval of your own pull request, and a merge on a branch that is behind, conflicted or blocked. The refusal comes back verbatim.</Rule>
        <Rule title="Held notes stay held.">Nobody else sees them, nothing reaches GitHub, and no session wakes until you send the review.</Rule>
        <Rule title="The agent does not merge.">The briefing forbids it unless a human asked. Approved and green, it tells you the merge is yours.</Rule>
        <Rule title="Review text arrives fenced.">Each note and the summary are capped at 3,000 characters inside a delimiter that names their source. A batch over 12,000 drops whole notes and says how many.</Rule>
      </ul>
    </div>
  );
}

function Rule({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="pl-4" style={{ borderLeft: `2px solid ${SOL.base2}` }}>
      <b style={{ color: SOL.base02 }}>{title}</b> {children}
    </li>
  );
}

// ── 9. command reference ─────────────────────────────────────────────────────

const REF: { group: string; color: string; rows: [string, string][] }[] = [
  {
    group: "Read",
    color: SOL.blue,
    rows: [
      ["ls [--repo] [--state] [--mine] [--shepherded] [-n]", "Pull requests across your teams, newest change first"],
      ["show [ref]", "State, checks, reviews, links, the shepherd, last events"],
      ["threads [ref] [--all]", "Review threads with short ids and file:line"],
      ["events [ref] [-n]", "The timeline: pushes, reviews, checks, merges"],
      ["watch [ref] [--all] [--json]", "One line per change, silent until something moves"],
      ["open [ref] [--print]", "The codecast page for it"],
    ],
  },
  {
    group: "Review",
    color: SOL.yellow,
    rows: [
      ["comment [ref] \"text\"", "On the conversation now; with --file and --line, on the diff"],
      ["comment --hold --file f --line n", "Hold a note in your review instead"],
      ["notes [ref] [--discard]", "The notes you hold, or throw them away"],
      ["review --approve|--request-changes|--comment [-b]", "Send every held note as one review, as you"],
    ],
  },
  {
    group: "Own and answer",
    color: SOL.cyan,
    rows: [
      ["shepherd on [ref] [--for <session>]", "Bind a session until the merge"],
      ["shepherd off | status", "Release it, or report who holds it"],
      ["comment --reply <thread> \"text\"", "Answer a thread by short id or file:line"],
      ["resolve | unresolve <thread>", "Settle a thread, or reopen it"],
    ],
  },
  {
    group: "Act",
    color: SOL.magenta,
    rows: [
      ["merge [--squash|--merge|--rebase] [--delete-branch]", "Merge on GitHub; squash by default"],
      ["close | reopen", "Close without merging, or reopen"],
      ["draft [--ready]", "Back to draft, or ready for review"],
      ["reviewers --add | --remove <login...>", "Ask for a review, or withdraw the ask"],
      ["edit [-t] [-b]", "Change the title or the description"],
    ],
  },
];

export function Reference() {
  return (
    <div className="md:columns-2 gap-6">
      {REF.map((g) => (
        <div key={g.group} className="mb-6 break-inside-avoid rounded-xl border overflow-hidden" style={{ borderColor: SOL.base2, backgroundColor: PAPER }}>
          <div className="flex items-center gap-2 px-4 py-2.5 font-mono text-[13px] font-semibold" style={{ color: g.color, borderBottom: `1px solid ${SOL.base2}` }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} /> {g.group}
          </div>
          <dl>
            {g.rows.map(([cmd, what]) => (
              <div key={cmd} className="px-4 py-2.5" style={{ borderTop: `1px solid ${SOL.base2}` }}>
                <dt className="font-mono text-[12px] break-words" style={{ color: SOL.base02 }}><span style={{ color: SOL.base1 }}>cast pr </span>{cmd}</dt>
                <dd className="mt-0.5 text-[13.5px]" style={{ color: SOL.base00 }}>{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

// ── 10. limits ───────────────────────────────────────────────────────────────

const LIMITS: [string, ReactNode][] = [
  ["Which hosts?", <>GitHub only. Pull requests arrive through the codecast GitHub app, so the repository needs it installed. Installing it on a repository backfills the pull requests already open there.</>],
  ["Does the shepherd turn itself on?", <>No. A shepherd candidate is picked when the pull request opens, but it stays paused until you run <C>cast pr shepherd on</C>, switch the header&apos;s &ldquo;Paused&rdquo; toggle to &ldquo;Wakes on changes&rdquo;, or ship with <C>/cast-ship</C>.</>],
  ["Will it rebase every time main moves?", <>No. Falling behind is recorded, not a wake, and the briefing says being behind alone is not a reason to rebase. A real conflict does wake it.</>],
  ["What if the session is busy?", <>The wake retries every 20 seconds, up to 5 times, and the reasons pile into one briefing. A review delivered as a message is best effort; a session that cannot take it never fails a review GitHub already holds, and the CLI says it was not delivered.</>],
  ["Can my review approve my own PR?", <>No. GitHub refuses that by rule, and codecast passes the refusal through. A request for changes and a comment-only review both need a body.</>],
  ["Who sees my held notes?", <>Only you, until you send the review. Every read path hides other people&apos;s pending notes.</>],
  ["Anything capped?", <>The Commits view reads through GitHub&apos;s pull request commits endpoint, which stops at 250. A briefing lists up to 12 failing checks, 25 unresolved comments and 15 reviews.</>],
];

export function Limits() {
  return (
    <div className="md:columns-2 gap-x-10">
      {LIMITS.map(([q, a]) => (
        <div key={q} className="mb-7 break-inside-avoid">
          <h3 className="font-mono text-[15px] font-semibold" style={{ color: SOL.base03 }}>{q}</h3>
          <p className="mt-1.5 text-[15px] leading-[1.7]" style={{ color: SOL.base01 }}>{a}</p>
        </div>
      ))}
    </div>
  );
}

// ── 11. related + close ──────────────────────────────────────────────────────

const RELATED: [string, ReactNode][] = [
  ["triggers", "The shepherd is a standing trigger that only a pull request event sets to run."],
  ["memory", <><C>cast search pr:</C> and <C>cast blame</C> lead from a pull request back to the sessions that made it.</>],
  ["decisions", "When the merge is a call only a person can make, queue it instead of interrupting."],
  ["agents", "Spawn workers under the session that owns the PR and fold their results in."],
];

export function Related() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {RELATED.map(([slug, why]) => {
        const f = FEATURE_DEEP_DIVES.find((x) => x.slug === slug);
        if (!f) return null;
        return (
          <Link key={slug} href={featureHref(slug)} className="prx-card group block rounded-xl border p-4" style={{ borderColor: SOL.base2, backgroundColor: PAPER }}>
            <div className="flex items-center gap-2 font-mono text-[14px] font-semibold" style={{ color: SOL.base03 }}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: f.color }} />
              {f.name}
              <span className="ml-auto transition-transform group-hover:translate-x-0.5" style={{ color: SOL.base1 }}>→</span>
            </div>
            <p className="mt-2 text-[13.5px] leading-[1.6]" style={{ color: SOL.base01 }}>{why}</p>
          </Link>
        );
      })}
    </div>
  );
}

export function Closing() {
  return (
    <section id="install" className="scroll-mt-20" style={{ backgroundColor: SOL.base03 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-24 grid gap-10 lg:grid-cols-2 items-center">
        <div>
          <h2 className="font-mono text-[28px] sm:text-[38px] font-bold leading-[1.12] tracking-tight" style={{ color: SOL.base3 }}>
            Ship it, then stop watching it.
          </h2>
          <p className="mt-4 text-[16.5px] leading-[1.7]" style={{ color: SOL.base1 }}>
            Install the CLI, connect GitHub, and the next pull request an agent opens arrives with its sessions attached.
            Shepherd it and go do something else.
          </p>
          <div className="mt-6 flex flex-wrap gap-3 font-mono text-[13px]">
            <Link href={guideHref("pull-requests")} className="prx-chip rounded-lg border px-4 py-2" style={{ borderColor: SOL.cyan, color: SOL.cyan }}>Read the guide</Link>
            <Link href="/blog/the-pull-request-that-knows-its-sessions" className="prx-chip rounded-lg border px-4 py-2" style={{ borderColor: "#094959", color: SOL.base1 }}>The launch post</Link>
          </div>
        </div>
        <div className="rounded-xl p-1" style={{ backgroundColor: SOL.base3 }}>
          <InstallTabs location="feature-pull-requests" compact />
        </div>
      </div>
    </section>
  );
}
