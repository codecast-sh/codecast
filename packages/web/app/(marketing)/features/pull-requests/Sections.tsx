"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C, Face, Frame, PAPER, PEOPLE, PrIcon, Prompt, RadioIcon, SessionPill, T, TaskPill, Term } from "./kit";
import { AUTHOR, BASE, HEAD, NOTES, PR_NUMBER, PR_TITLE, REPO, REVIEWER, SESSION, SEVERITY, TASK, TRIGGER, WAKE_TABLE } from "./data";

// ── 1. one row, three doors ──────────────────────────────────────────────────

export function Doors() {
  const door = (title: string, cmd: string, body: string) => (
    <div className="prx-card rounded-lg border px-4 py-3" style={{ borderColor: SOL.base2, backgroundColor: PAPER }}>
      <div className="font-mono text-[13px] font-semibold" style={{ color: SOL.base03 }}>{title}</div>
      <div className="mt-1 font-mono text-[11.5px]" style={{ color: SOL.cyan }}>{cmd}</div>
      <div className="mt-1.5 text-[13.5px] leading-snug" style={{ color: SOL.base01 }}>{body}</div>
    </div>
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.1fr)_auto_minmax(0,1fr)] items-center">
      <div className="rounded-xl border p-5" style={{ borderColor: SOL.base2, backgroundColor: SOL.base03, color: SOL.base1 }}>
        <div className="flex items-center gap-2 font-mono text-[14px] font-semibold" style={{ color: SOL.base2 }}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill={SOL.base2}><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" /></svg>
          GitHub
        </div>
        <ul className="mt-3 space-y-1 font-mono text-[11.5px] leading-relaxed">
          <li>pull_request · push</li>
          <li>pull_request_review</li>
          <li>pull_request_review_comment</li>
          <li>pull_request_review_thread</li>
          <li>check_run · check_suite</li>
          <li>workflow_run · status</li>
        </ul>
      </div>

      <Arrows top="webhooks" bottom="your acts" />

      <div className="rounded-xl border-2 p-5" style={{ borderColor: SOL.cyan, backgroundColor: PAPER }}>
        <div className="flex items-center gap-2 font-mono text-[14px] font-semibold" style={{ color: SOL.base03 }}>
          <PrIcon color={SOL.cyan} /> one row per pull request
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11.5px]" style={{ color: SOL.base00 }}>
          <span>state, draft, branch</span><span>checks, verdicts</span>
          <span>review threads</span><span>held notes (yours only)</span>
          <span>labels, reviewers</span><span>mergeability</span>
          <span style={{ color: SOL.blue }}>linked sessions</span><span style={{ color: SOL.yellow }}>linked tasks</span>
          <span className="col-span-2" style={{ color: SOL.cyan }}>the shepherd session + its trigger</span>
        </div>
        <p className="mt-4 text-[13px] leading-snug" style={{ color: SOL.base01 }}>
          The inbound webhook is its only writer. Nothing you do here writes the row; GitHub answers every act with a webhook,
          and that updates it. The two sides cannot disagree.
        </p>
      </div>

      <Arrows top="reads" bottom="verbs" />

      <div className="space-y-3">
        {door("The page", `/pr/${REPO}/${PR_NUMBER}`, "Conversation, Files, Commits and Checks, with the shepherd in the header.")}
        {door("The terminal", "cast pr …", "Every verb the page has, for you and for any agent.")}
        {door("The shepherd", "cast pr shepherd on", "A session woken by the row's changes.")}
      </div>
    </div>
  );
}

function Arrows({ top, bottom }: { top: string; bottom: string }) {
  return (
    <div className="flex lg:flex-col items-center justify-center gap-3 font-mono text-[10.5px]" style={{ color: SOL.base1 }} aria-hidden>
      <span className="flex items-center gap-1.5"><span className="lg:hidden">↓</span>{top}<span className="hidden lg:inline">→</span></span>
      <span className="flex items-center gap-1.5"><span className="hidden lg:inline">←</span>{bottom}<span className="lg:hidden">↑</span></span>
    </div>
  );
}

// ── 2. linked sessions ───────────────────────────────────────────────────────

const COMMITS = [
  { sha: "9b04e1d", msg: "fix(retry): clamp the delay after jitter", session: SESSION.title },
  { sha: "3f2a91c", msg: "fix(retry): count the attempt before the cap check", session: SESSION.title },
  { sha: "a7c0e52", msg: "feat(retry): exponential backoff for webhook deliveries", session: "Webhook delivery audit" },
];

export function Linked() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-start">
      <div className="min-w-0 space-y-5">
      <Frame label="The pull request header with its shepherd and linked sessions and task, over the Commits view">
        <div className="px-4 sm:px-5 pt-4 pb-3" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
          <div className="flex items-start gap-2 text-[14px] font-semibold" style={{ color: SOL.base03 }}>
            <PrIcon className="h-4 w-4 mt-[2px]" />
            <span>{PR_TITLE} <span style={{ color: SOL.base1, fontWeight: 400 }}>#{PR_NUMBER}</span></span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px]" style={{ color: SOL.base00 }}>
            <Face name={AUTHOR} color={PEOPLE.lena} size={16} /> {AUTHOR}
            <span className="rounded border px-1.5 py-[1px] text-[10.5px]" style={{ borderColor: SOL.base2, backgroundColor: SOL.base3 }}>{HEAD} → {BASE}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5" style={{ color: SOL.base1 }}><RadioIcon color={SOL.cyan} /> Shepherd</span>
            <SessionPill>{SESSION.title}</SessionPill>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span style={{ color: SOL.base1 }}>Linked</span>
            <SessionPill>Webhook delivery audit</SessionPill>
            <SessionPill>Flaky retry test</SessionPill>
            <TaskPill>{TASK.title}</TaskPill>
          </div>
        </div>
        <div className="flex gap-4 px-4 sm:px-5 pt-2.5 text-[11.5px]" style={{ color: SOL.base00 }}>
          <span>Conversation</span><span>Files 4</span>
          <span className="pb-2" style={{ color: SOL.base03, borderBottom: `2px solid ${SOL.green}` }}>Commits 3</span><span>Checks 6</span>
        </div>
        <ul style={{ borderTop: `1px solid ${SOL.base2}` }}>
          {COMMITS.map((c) => (
            <li key={c.sha} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 sm:px-5 py-2.5 text-[12px]" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
              <span style={{ color: SOL.base1 }}>{c.sha}</span>
              <span className="min-w-0 flex-1 truncate" style={{ color: SOL.base02 }}>{c.msg}</span>
              <SessionPill>{c.session}</SessionPill>
            </li>
          ))}
        </ul>
        <div className="px-4 sm:px-5 py-3 text-[11px] leading-relaxed" style={{ color: SOL.base1 }}>
          The <C>Codecast-Session</C> trailer in each commit message reads as the session&apos;s pill, not a URL.
        </div>
      </Frame>
      <Term title="and from the other side">
        <Prompt>cast search &quot;pr:{REPO}#{PR_NUMBER}&quot;</Prompt>
        {T.dim("every session behind the pull request")}{"\n"}
        <Prompt>cast blame src/retry.ts</Prompt>
        {T.dim("each line, by the session that wrote it")}
      </Term>
      </div>

      <div className="space-y-4">
        <LinkWay n="1" title="Sessions on the branch">
          When GitHub reports the pull request opened, codecast links the sessions that worked on its head branch, and picks the
          most recent one in that repository as the shepherd candidate. The candidate does not wake until you turn it on.
        </LinkWay>
        <LinkWay n="2" title="A trailer on every agent commit">
          A Claude Code hook adds <C>Codecast-Session: &lt;link&gt;</C> to each <C>git commit</C> an agent runs, only for sessions
          your team can see. The trailer is the session&apos;s own word, so it beats every guess. Off with{" "}
          <C>cast config session_trailer false</C> or <C>git config codecast.sessionTrailer false</C>.
        </LinkWay>
        <LinkWay n="3" title="Task ids in the text">
          A task id like <C>{TASK.id}</C> in the title, the body or the branch name links the task, and the shepherd&apos;s
          briefing lists it under linked work.
        </LinkWay>
      </div>
    </div>
  );
}

function LinkWay({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-[2px] inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[12px] font-bold" style={{ backgroundColor: "rgba(38,139,210,0.12)", color: SOL.blue }}>{n}</span>
      <div>
        <div className="font-mono text-[14px] font-semibold" style={{ color: SOL.base03 }}>{title}</div>
        <p className="mt-1 text-[14.5px] leading-[1.65]" style={{ color: SOL.base01 }}>{children}</p>
      </div>
    </div>
  );
}

// ── 4. the shepherd ──────────────────────────────────────────────────────────

export function Switchboard() {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start">
      <div>
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: SOL.base2, backgroundColor: PAPER }}>
          {WAKE_TABLE.map((row, i) => (
            <div key={row.event} className="flex items-center gap-3 px-4 py-2.5" style={{ borderTop: i ? `1px solid ${SOL.base2}` : undefined }}>
              <span
                className="inline-flex h-3 w-3 shrink-0 rounded-full"
                style={row.wakes ? { backgroundColor: SOL.cyan, boxShadow: "0 0 0 3px rgba(42,161,152,0.18)" } : { border: `1.5px solid ${SOL.base1}` }}
                aria-label={row.wakes ? "wakes the session" : "does not wake"}
              />
              <span className="min-w-0 flex-1 text-[14px] leading-snug" style={{ color: row.wakes ? SOL.base02 : SOL.base00 }}>{row.event}</span>
              <span className="shrink-0 font-mono text-[10.5px]" style={{ color: row.wakes ? SOL.cyan : SOL.base1 }}>{row.wakes ? "wakes" : row.note}</span>
            </div>
          ))}
        </div>
        <div className="mt-6 space-y-3 text-[14.5px] leading-[1.65]" style={{ color: SOL.base01 }}>
          <p>
            <b style={{ color: SOL.base02 }}>Busy sessions are not interrupted.</b> If the shepherd is mid-run, the wake retries every
            20 seconds, up to 5 times, and collects the reasons as they pile up.
          </p>
          <p>
            <b style={{ color: SOL.base02 }}>The worst news leads.</b> When several reasons wait, the briefing opens with the most urgent:
          </p>
          <ol className="flex flex-wrap items-center gap-1.5 font-mono text-[11.5px]">
            {SEVERITY.slice(0, 3).map(([key], i) => (
              <li key={key} className="flex items-center gap-1.5">
                <span className="rounded px-1.5 py-[1px]" style={{ backgroundColor: i === 0 ? "rgba(220,50,47,0.1)" : i === 1 ? "rgba(203,75,22,0.1)" : "rgba(181,137,0,0.12)", color: i === 0 ? SOL.red : i === 1 ? SOL.orange : SOL.yellow }}>{key}</span>
                {i < 2 && <span style={{ color: SOL.base1 }}>›</span>}
              </li>
            ))}
            <li style={{ color: SOL.base1 }}>› the rest</li>
          </ol>
        </div>
      </div>

      <Briefing />
    </div>
  );
}

/** The wake briefing, as buildWakePrompt writes it (convex/prShepherd.ts). */
function Briefing() {
  const h = (s: string) => <span style={{ color: SOL.cyan, fontWeight: 600 }}>{s}</span>;
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: "rgba(42,161,152,0.4)", backgroundColor: PAPER, boxShadow: "0 18px 40px -28px rgba(0,43,54,0.45)" }}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 font-mono text-[11px]" style={{ backgroundColor: "rgba(42,161,152,0.08)", borderBottom: "1px solid rgba(42,161,152,0.25)", color: SOL.base00 }}>
        <RadioIcon color={SOL.cyan} />
        <span style={{ color: SOL.cyan, fontWeight: 600 }}>Shepherd PR #{PR_NUMBER}</span>
        <span>{TRIGGER}</span>
        <span className="ml-auto">arrives in <SessionPill>{SESSION.id}</SessionPill> as a new turn</span>
      </div>
      <pre className="overflow-x-auto px-4 sm:px-5 py-4 font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap" style={{ color: SOL.base02 }}>
        {h(`# Shepherding ${REPO} PR #${PR_NUMBER}: ${PR_TITLE}`)}{"\n\n"}
        https://github.com/{REPO}/pull/{PR_NUMBER}{"\n"}
        {HEAD} into {BASE} at 9b04e1d{"\n"}
        State: changes_requested{"\n"}
        Woken because a reviewer asked for changes.{"\n"}
        Also since the last wake: a reviewer left a comment on the code.{"\n\n"}
        {h("## Unresolved review comments")}{"\n"}
        {NOTES.map((n) => `- ${REVIEWER} on ${n.file}:${n.line}: ${n.text}\n`).join("")}{"\n"}
        {h("## Reviews")}{"\n"}
        - {REVIEWER} changes_requested: Two notes, then good to go.{"\n\n"}
        Review decision: changes_requested.{"\n\n"}
        {h("## Linked work")}{"\n"}
        - {TASK.id} {TASK.title}{"\n\n"}
        {h("## Your job")}{"\n"}
        <span style={{ color: SOL.base01 }}>
          You own this pull request until it merges. Deal with everything outstanding above, in one pass: fix the failing
          checks, answer the review comments, and push to the same branch. When you have addressed a reviewer&apos;s point, say
          so on GitHub in reply to their comment (`gh` or `cast pr comment`) so the thread shows the resolution rather than
          going quiet. Being behind alone is not a reason to rebase or push. Update the branch only for a verified merge
          blocker or an explicit request; resolve real conflicts.{" "}
        </span>
        <span style={{ backgroundColor: "rgba(220,50,47,0.09)", color: SOL.red }}>Do not merge the pull request unless a human asked you to.</span>
        <span style={{ color: SOL.base01 }}> Keep `cast state` current so the card says where the PR actually stands.</span>
      </pre>
      <div className="px-4 sm:px-5 py-3 text-[12.5px] leading-snug" style={{ borderTop: `1px solid ${SOL.base2}`, color: SOL.base00 }}>
        Rebuilt from the row on every wake, so it never describes a state the pull request has already left.
        A merge or a close retires the trigger.
      </div>
    </div>
  );
}

// ── 5. terminal tour ─────────────────────────────────────────────────────────

/** Rows laid out the way `formatPrTable` (cli/src/prCommand.ts) pads them: each column to its widest cell, two spaces between. */
const LS_ROWS: [string, string, string, string, string, string, string, string, string][] = [
  ["#214", "open", "ci_red", "Retry webhook deliveries with backoff", "webhook-retry → main", "5 green 1 red", "wanted", SESSION.id, "4m"],
  ["#211", "open", "changes_requested", "Move rate limits into the gateway", "gateway-limits → main", "6 green", "changes, 2 open", "jx7d2pa", "1h"],
  ["#209", "open", "ci_pending", "Stream large exports to R2", "export-stream → main", "4 green 2 running", "wanted", "jx7m3rb", "2h"],
  ["#207", "open", "ready", "Typed config loader", "config-types → main", "6 green", "approved", "jx7k0qe", "3h"],
  ["#203", "draft", "review_pending", "Drop the legacy auth header", "auth-header → main", "6 green", "", "jx7p9wd", "5h"],
];
const SHEPHERD_TONE: Record<string, (s: string) => ReactNode> = { ci_red: T.red, changes_requested: T.yellow, ci_pending: T.blue, review_pending: T.blue, ready: T.green };
function lsTable() {
  const w = (i: number) => Math.max(...LS_ROWS.map((r) => r[i].length));
  return LS_ROWS.map((r, n) => (
    <span key={r[0]}>
      {T.cyan(r[0].padStart(w(0)))}  {T.green(r[1].padEnd(w(1)))}  {SHEPHERD_TONE[r[2]](r[2].padEnd(w(2)))}  {r[3].padEnd(w(3))}  {T.dim(r[4].padEnd(w(4)))}  {r[5].padEnd(w(5))}  {r[6].padEnd(w(6))}  {T.magenta(r[7])}  {T.dim(r[8])}
      {n < LS_ROWS.length - 1 ? "\n" : null}
    </span>
  ));
}

const TOUR: { key: string; title: string; body: ReactNode; note: ReactNode }[] = [
  {
    key: "ls",
    title: "cast pr ls --shepherded",
    note: <>Open pull requests across your teams, newest change first. The second column after the state is the shepherd&apos;s state, the last two are the session and the age. Filters: <C>--repo</C>, <C>--state</C>, <C>--mine</C>, <C>--shepherded</C>, <C>-n</C>.</>,
    body: (
      <>
        <Prompt>cast pr ls --shepherded</Prompt>
        {lsTable()}
      </>
    ),
  },
  {
    key: "show",
    title: `cast pr show ${PR_NUMBER}`,
    note: <>Everything known about one: where it stands, the shepherd and when it last woke, every check, the review standing, the open comments, the linked sessions and tasks, and the latest events.</>,
    body: (
      <>
        <Prompt>cast pr show {PR_NUMBER}</Prompt>
        {T.cyan(`${REPO}#${PR_NUMBER}`)} {T.bright(PR_TITLE)} {T.green("open")}{"\n\n"}
        {"  "}{T.label("branch    ")} {HEAD} → {BASE}{"\n"}
        {"  "}{T.label("sha       ")} 9b04e1d27c4f{"\n"}
        {"  "}{T.label("author    ")} {AUTHOR}{"\n"}
        {"  "}{T.label("merge     ")} clean{"\n\n"}
        {T.label("shepherd")}{"\n"}
        {"  "}{T.label("session   ")} {T.magenta(SESSION.id)} {T.dim(SESSION.title)}{"\n"}
        {"  "}{T.label("enabled   ")} yes{"\n"}
        {"  "}{T.label("state     ")} {T.yellow("changes_requested")}{"\n"}
        {"  "}{T.label("last wake ")} 6m ago (changes_requested){"\n"}
        {"  "}{T.label("wakes     ")} 2{"\n"}
        {"  "}{T.label("trigger   ")} {TRIGGER}{"\n\n"}
        {T.label("checks (success)")}{"\n"}
        {"  "}{T.green("●")} build (pull_request) {T.dim("success")}{"\n"}
        {"  "}{T.green("●")} test (pull_request) {T.dim("success")}{"\n"}
        {"  "}{T.dim("…")}{"\n\n"}
        {T.label("reviews")}{"\n"}
        {"  "}changes, 2 open{"\n\n"}
        {T.label("linked")}{"\n"}
        {"  "}{T.magenta(SESSION.id)} {T.dim(SESSION.title)}{"\n"}
        {"  "}{T.magenta("jx7b81n")} {T.dim("Webhook delivery audit")}{"\n"}
        {"  "}{T.yellow(TASK.id)} {T.dim(`${TASK.title} [in_progress]`)}
      </>
    ),
  },
  {
    key: "threads",
    title: `cast pr threads ${PR_NUMBER}`,
    note: <>Open threads, one line each. The short id in the first column is what <C>cast pr resolve</C> and <C>cast pr comment --reply</C> take, and so is the <C>file:line</C> beside it. <C>--all</C> includes resolved ones, dimmed.</>,
    body: (
      <>
        <Prompt>cast pr threads {PR_NUMBER}</Prompt>
        {NOTES.map((n) => <span key={n.id}>{T.cyan(n.id)}  {T.yellow("·")}  {T.dim(`${n.file}:${n.line}`)}  {REVIEWER}  {n.text}{"\n"}</span>)}
        {"\n"}{T.dim("1 resolved. `--all` shows them.")}{"\n"}
        <Prompt>cast pr comment --reply {NOTES[0].id} &quot;Clamped after jitter in 9b04e1d.&quot;</Prompt>
        {T.green("ok")} replied on {T.cyan(`${REPO}#${PR_NUMBER}`)} {T.dim("(threaded under it on GitHub in a moment)")}{"\n"}
        <Prompt>cast pr resolve {NOTES[0].id}</Prompt>
        {T.green("ok")} resolved {T.cyan(`${REPO}#${PR_NUMBER}`)} {T.dim(`${NOTES[0].id} ${NOTES[0].file}:${NOTES[0].line}`)}
      </>
    ),
  },
  {
    key: "watch",
    title: "cast pr watch",
    note: <>Live, one line per change to the shepherd&apos;s state, checks, review decision, merge state or open comment count. The first frame is a silent baseline, so what prints is the change. <C>--json</C> streams NDJSON.</>,
    body: (
      <>
        <Prompt>cast pr watch {PR_NUMBER}</Prompt>
        cast pr: watching 1 pull request for changes· Ctrl-C to stop{"\n\n"}
        → {T.cyan(`${REPO}#${PR_NUMBER}`)} checks_state: {T.dim("failure")} → {T.bright("pending")} {T.dim(PR_TITLE)}{"\n"}
        → {T.cyan(`${REPO}#${PR_NUMBER}`)} checks_state: {T.dim("pending")} → {T.bright("success")} {T.dim(PR_TITLE)}{"\n"}
        → {T.cyan(`${REPO}#${PR_NUMBER}`)} shepherd_state: {T.dim("ci_red")} → {T.bright("review_pending")} {T.dim(PR_TITLE)}{"\n"}
        → {T.cyan(`${REPO}#${PR_NUMBER}`)} review_decision: {T.dim("none")} → {T.bright("changes_requested")} {T.dim(PR_TITLE)}{"\n"}
        → {T.cyan(`${REPO}#${PR_NUMBER}`)} unresolved_review_count: {T.dim("0")} → {T.bright("2")} {T.dim(PR_TITLE)}
      </>
    ),
  },
  {
    key: "events",
    title: `cast pr events ${PR_NUMBER}`,
    note: <>The timeline, newest first: pushes, reviews, check results, merge-state changes. The same rows feed project timelines beside task and session activity.</>,
    body: (
      <>
        <Prompt>cast pr events {PR_NUMBER}</Prompt>
        {"    "}{T.dim("2m")} {T.blue("pr_review")} {REVIEWER} Review: approved by {REVIEWER} on PR #{PR_NUMBER}{"\n"}
        {"    "}{T.dim("9m")} {T.blue("pr_synchronize")} {AUTHOR} PR #{PR_NUMBER} updated to 9b04e1d{"\n"}
        {"   "}{T.dim("14m")} {T.blue("pr_review")} {REVIEWER} Review: requested changes by {REVIEWER} on PR #{PR_NUMBER}{"\n"}
        {"   "}{T.dim("31m")} {T.blue("pr_check")} CI passed on PR #{PR_NUMBER}{"\n"}
        {"   "}{T.dim("38m")} {T.blue("pr_synchronize")} {AUTHOR} PR #{PR_NUMBER} updated to 3f2a91c{"\n"}
        {"   "}{T.dim("44m")} {T.blue("pr_check")} CI failed: test (pull_request){"\n"}
        {"    "}{T.dim("1h")} {T.blue("pr_opened")} {AUTHOR} Opened PR #{PR_NUMBER}: {PR_TITLE}
      </>
    ),
  },
];

export function Tour() {
  const [k, setK] = useState("ls");
  const item = TOUR.find((t) => t.key === k)!;
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="cast pr read verbs">
        {TOUR.map((t) => {
          const on = t.key === k;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setK(t.key)}
              className="prx-chip rounded-md border px-3 py-1.5 font-mono text-[12.5px]"
              style={{ borderColor: on ? SOL.base03 : SOL.base2, backgroundColor: on ? SOL.base03 : PAPER, color: on ? SOL.base2 : SOL.base00 }}
            >
              {t.key}
            </button>
          );
        })}
      </div>
      <p key={k} className="prx-in mb-4 max-w-3xl min-h-[3.4em] text-[15px] leading-[1.7]" style={{ color: SOL.base01 }}>{item.note}</p>
      <Term title={item.title} minH={232}>{item.body}</Term>
      <p className="mt-6 text-[14px] leading-relaxed" style={{ color: SOL.base00 }}>
        Every verb takes the same reference: a number, <C>owner/repo#123</C>, a GitHub or codecast URL, or nothing. Nothing
        means the pull request this session is bound to, and failing that the one for the branch you are standing on. Every
        read takes <C>--json</C>.
      </p>
    </div>
  );
}
