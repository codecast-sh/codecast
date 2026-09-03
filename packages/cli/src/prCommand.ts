// `cast pr`: pull requests from the shell.
//
// A pull request is a codecast object like a session or a task: it carries a
// state, checks, reviews, the tasks it closes and the session that shepherds it
// until it merges. This command reads and steers that from a terminal, so an
// agent can answer "where does my PR stand" without a browser.
//
// Every subcommand takes the same reference: a number, an owner and name with a
// number, a GitHub or codecast URL, or nothing at all. Nothing means "the PR
// this session is bound to", and failing that "the PR for the branch I am
// standing on". The parsing is shared with the server (@codecast/shared
// prRefs); the resolution is the server's, so one rule decides what a bare 123
// means no matter who asks.
//
// Same deps pattern as stateCommand.ts / publish.ts: index.ts hands in config
// access, this module stays importable by tests.

import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import open from "open";
import { apiPost, type PublishDeps } from "./publish.js";
import { readStdinBody, stdinText } from "./sendBody.js";
import { fmt, c, icons } from "./colors.js";
import {
  parsePrRef,
  extractRepoFromRemoteUrl,
  codecastPrUrl,
} from "@codecast/shared/contracts";

// ── locating a pull request ──────────────────────────────────────────────────

/**
 * Everything the server needs to decide which pull request the caller meant.
 *
 * A type and not an interface on purpose: apiPost takes a Record<string,
 * unknown> body, and only a type alias is assignable to one.
 */
export type PrLocator = {
  repository?: string;
  number?: number;
  /** The session whose bound PR to use when no number was given. */
  session?: string;
  /** The branch to match against head_ref when no number was given. */
  branch?: string;
};

/** The repository and branch of the checkout the command runs in. */
export interface LocalGitContext {
  repository: string | null;
  branch: string | null;
}

function gitLine(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function readLocalGitContext(cwd: string = process.cwd()): LocalGitContext {
  const branch = gitLine(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const remote = gitLine(["remote", "get-url", "origin"], cwd);
  return {
    // A detached head answers "HEAD", which matches no branch on GitHub.
    branch: branch && branch !== "HEAD" ? branch : null,
    repository: extractRepoFromRemoteUrl(remote),
  };
}

/**
 * Turn what the caller typed into the locator the server resolves. A reference
 * that names a number wins outright; without one the session and the branch go
 * along as the two fallbacks, and the local repository narrows both.
 *
 * Throws on text that names no pull request at all, so a typo fails at the
 * shell instead of quietly listing somebody else's PR.
 */
export function buildPrLocator(
  ref: string | undefined,
  local: { session?: string | null; repository?: string | null; branch?: string | null },
): PrLocator {
  const parsed = ref ? parsePrRef(ref) : null;
  if (ref && !parsed) {
    throw new Error(
      `"${ref}" does not name a pull request. Use 123, owner/repo#123, or a pull request URL.`,
    );
  }

  const locator: PrLocator = {};
  if (parsed?.repository) locator.repository = parsed.repository;
  else if (local.repository) locator.repository = local.repository;

  if (parsed?.number != null) {
    locator.number = parsed.number;
    return locator;
  }

  if (local.session) locator.session = local.session;
  if (local.branch) locator.branch = local.branch;
  return locator;
}

// ── watch diffing ────────────────────────────────────────────────────────────

/** The compact row the watch query pushes. */
export type PrWatchRow = {
  id: string;
  repository: string;
  number: number;
  title: string | null;
  state: string;
  shepherd_state?: string | null;
  checks_state?: string | null;
  review_decision?: string | null;
  mergeable_state?: string | null;
  unresolved_review_count?: number | null;
};

export interface PrWatchEvent {
  event: "new" | "transition" | "gone";
  id: string;
  repository: string;
  number: number;
  title: string | null;
  field: string | null;
  from: string | null;
  to: string | null;
}

/** The fields a change of which is worth a line. */
const WATCHED_FIELDS = [
  "state",
  "shepherd_state",
  "checks_state",
  "review_decision",
  "mergeable_state",
  "unresolved_review_count",
] as const;

function fieldValue(row: PrWatchRow, field: string): string | null {
  const value = (row as Record<string, unknown>)[field];
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/**
 * One line per observable change between two pushes. `prev` is null on the
 * first frame, which is the silent baseline: a watcher that printed the whole
 * current set on connect would drown the change it was started to see.
 */
export function diffPrRows(prev: PrWatchRow[] | null, next: PrWatchRow[]): PrWatchEvent[] {
  if (prev === null) return [];
  const before = new Map(prev.map((row) => [row.id, row]));
  const events: PrWatchEvent[] = [];

  for (const row of next) {
    const was = before.get(row.id);
    const head = {
      id: row.id,
      repository: row.repository,
      number: row.number,
      title: row.title ?? null,
    };
    if (!was) {
      events.push({ ...head, event: "new", field: "state", from: null, to: row.state });
      continue;
    }
    for (const field of WATCHED_FIELDS) {
      const from = fieldValue(was, field);
      const to = fieldValue(row, field);
      if (from === to) continue;
      events.push({ ...head, event: "transition", field, from, to });
    }
  }

  const present = new Set(next.map((row) => row.id));
  for (const row of prev) {
    if (present.has(row.id)) continue;
    events.push({
      id: row.id,
      repository: row.repository,
      number: row.number,
      title: row.title ?? null,
      event: "gone",
      field: "state",
      from: row.state,
      to: null,
    });
  }

  return events;
}

// ── rendering ────────────────────────────────────────────────────────────────

export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/** "3 green", "3 green 1 red", or "" when the PR has no checks. */
export function formatChecks(row: {
  checks_green?: number | null;
  checks_red?: number | null;
  checks_pending?: number | null;
}): string {
  const green = row.checks_green ?? 0;
  const red = row.checks_red ?? 0;
  const pending = row.checks_pending ?? 0;
  if (green + red + pending === 0) return "";
  const parts: string[] = [];
  if (green) parts.push(`${green} green`);
  if (red) parts.push(`${red} red`);
  if (pending) parts.push(`${pending} running`);
  return parts.join(" ");
}

/** The one word a review decision is worth in a table. */
export function formatReviews(row: {
  review_decision?: string | null;
  unresolved_review_count?: number | null;
}): string {
  const unresolved = row.unresolved_review_count ?? 0;
  const decision =
    row.review_decision === "approved"
      ? "approved"
      : row.review_decision === "changes_requested"
        ? "changes"
        : row.review_decision === "review_required"
          ? "wanted"
          : "";
  if (unresolved > 0) return decision ? `${decision}, ${unresolved} open` : `${unresolved} open`;
  return decision;
}

const STATE_COLOR: Record<string, string> = {
  open: c.green,
  merged: c.magenta,
  closed: c.red,
};

const SHEPHERD_COLOR: Record<string, string> = {
  ci_red: c.red,
  conflicts: c.red,
  changes_requested: c.yellow,
  behind: c.yellow,
  ci_pending: c.blue,
  review_pending: c.blue,
  approved: c.green,
  ready: c.green,
  merged: c.magenta,
  closed: c.dim,
};

function color(text: string, code: string | undefined): string {
  if (!text) return text;
  return code ? `${code}${text}${c.reset}` : text;
}

interface PrRow extends PrWatchRow {
  head_ref?: string | null;
  base_ref?: string | null;
  draft?: boolean | null;
  checks_green?: number | null;
  checks_red?: number | null;
  checks_pending?: number | null;
  session_short_id?: string | null;
  shepherd_enabled?: boolean | null;
  updated_at?: number | null;
}

/**
 * The `cast pr ls` table. Column widths come from the rows themselves so a
 * list of short branch names does not pay for a long one that is not there.
 */
export function formatPrTable(rows: PrRow[], now: number = Date.now()): string {
  if (rows.length === 0) return fmt.muted("No pull requests match.");

  const cells = rows.map((row) => ({
    number: `#${row.number}`,
    state: row.draft ? "draft" : row.state,
    shepherd: row.shepherd_enabled === false ? "" : (row.shepherd_state ?? ""),
    title: row.title ?? "",
    branch: row.head_ref ? `${row.head_ref} ${icons.arrow} ${row.base_ref ?? "?"}` : "",
    checks: formatChecks(row),
    reviews: formatReviews(row),
    session: row.session_short_id ?? "",
    age: row.updated_at ? formatAge(Math.max(0, now - row.updated_at)) : "",
    stateColor: STATE_COLOR[row.state],
    shepherdColor: SHEPHERD_COLOR[row.shepherd_state ?? ""],
  }));

  const width = (key: keyof (typeof cells)[number]) =>
    Math.max(...cells.map((cell) => String(cell[key] ?? "").length));
  const numberWidth = width("number");
  const stateWidth = width("state");
  const shepherdWidth = width("shepherd");
  const titleWidth = Math.min(Math.max(width("title"), 10), 54);
  const branchWidth = Math.min(width("branch"), 40);
  const checksWidth = width("checks");
  const reviewsWidth = width("reviews");

  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max - 1)}${icons.dot}` : text;

  return cells
    .map((cell) => {
      const parts = [
        color(cell.number.padStart(numberWidth), c.cyan),
        color(cell.state.padEnd(stateWidth), cell.stateColor),
        color(cell.shepherd.padEnd(shepherdWidth), cell.shepherdColor),
        clip(cell.title, titleWidth).padEnd(titleWidth),
        fmt.muted(clip(cell.branch, branchWidth).padEnd(branchWidth)),
        cell.checks.padEnd(checksWidth),
        cell.reviews.padEnd(reviewsWidth),
        cell.session ? color(cell.session, c.magenta) : "",
        fmt.muted(cell.age),
      ];
      return parts.filter((part) => part.trim() !== "").join("  ").trimEnd();
    })
    .join("\n");
}

/** One line per watch event, for a person reading the stream. */
export function formatPrChangeLine(event: PrWatchEvent): string {
  const head = `${c.cyan}${event.repository}#${event.number}${c.reset}`;
  const title = event.title ? ` ${fmt.muted(event.title.slice(0, 60))}` : "";
  if (event.event === "new") return `${icons.bullet} ${head} appeared as ${event.to}${title}`;
  if (event.event === "gone") return `${icons.dot} ${head} left the set (was ${event.from})${title}`;
  return `${icons.arrow} ${head} ${event.field}: ${fmt.muted(event.from ?? "none")} ${icons.arrow} ${fmt.highlight(event.to ?? "none")}${title}`;
}

function line(label: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return `  ${fmt.label(label.padEnd(10))} ${value}`;
}

/** The `cast pr show` block. */
export function formatPrShow(data: any, now: number = Date.now()): string {
  const pr = data.pull_request ?? data;
  const out: string[] = [];

  out.push(
    `${c.cyan}${pr.repository}#${pr.number}${c.reset} ${fmt.highlight(pr.title ?? "")} ` +
      color(pr.draft ? "draft" : pr.state, STATE_COLOR[pr.state]),
  );
  out.push("");

  const rows = [
    line("url", pr.url),
    line("page", pr.codecast_url),
    line("branch", pr.head_ref ? `${pr.head_ref} ${icons.arrow} ${pr.base_ref ?? "?"}` : null),
    line("sha", pr.head_sha ? String(pr.head_sha).slice(0, 12) : null),
    line("author", pr.author_github_username),
    line("merge", [pr.mergeable_state, pr.behind_by ? `${pr.behind_by} behind` : ""].filter(Boolean).join(", ")),
    line("updated", pr.updated_at ? `${formatAge(Math.max(0, now - pr.updated_at))} ago` : null),
  ].filter(Boolean) as string[];
  out.push(...rows);

  const shepherd = pr.shepherd;
  if (shepherd?.session_short_id) {
    out.push("");
    out.push(fmt.label("shepherd"));
    const wake = shepherd.last_wake_at
      ? `${formatAge(Math.max(0, now - shepherd.last_wake_at))} ago${shepherd.last_wake_reason ? ` (${shepherd.last_wake_reason})` : ""}`
      : null;
    out.push(
      ...([
        line("session", `${c.magenta}${shepherd.session_short_id}${c.reset}${shepherd.session_title ? ` ${fmt.muted(shepherd.session_title)}` : ""}`),
        line("enabled", shepherd.enabled ? "yes" : "no"),
        line("state", color(shepherd.state ?? "", SHEPHERD_COLOR[shepherd.state ?? ""])),
        line("last wake", wake),
        line("wakes", shepherd.wake_count ? String(shepherd.wake_count) : null),
        line("trigger", shepherd.trigger_short_id),
      ].filter(Boolean) as string[]),
    );
  }

  const checks: any[] = pr.checks ?? [];
  if (checks.length) {
    out.push("");
    out.push(fmt.label(`checks (${pr.checks_state ?? "unknown"})`));
    for (const check of checks) {
      const verdict = check.conclusion ?? check.status ?? "";
      const mark =
        verdict === "success" ? `${c.green}${icons.check}${c.reset}` :
        verdict === "failure" || verdict === "timed_out" ? `${c.red}${icons.cross}${c.reset}` :
        `${c.yellow}${icons.dot}${c.reset}`;
      out.push(`  ${mark} ${check.name} ${fmt.muted(verdict)}${check.url ? ` ${fmt.muted(check.url)}` : ""}`);
    }
  }

  const reviewLine = formatReviews(pr);
  const reviewers: string[] = pr.requested_reviewers ?? [];
  if (reviewLine || reviewers.length) {
    out.push("");
    out.push(fmt.label("reviews"));
    if (reviewLine) out.push(`  ${reviewLine}`);
    if (reviewers.length) out.push(`  ${fmt.muted(`requested: ${reviewers.join(", ")}`)}`);
  }

  const comments: any[] = data.unresolved_comments ?? [];
  if (comments.length) {
    out.push("");
    out.push(fmt.label(`unresolved comments (${comments.length})`));
    for (const comment of comments) {
      const where = comment.file_path
        ? `${comment.file_path}${comment.line_number ? `:${comment.line_number}` : ""}`
        : "";
      const first = String(comment.content ?? "").split("\n")[0].slice(0, 80);
      out.push(`  ${comment.author ?? "someone"} ${fmt.muted(where)} ${first}`);
    }
  }

  const sessions: any[] = data.sessions ?? [];
  const tasks: any[] = data.tasks ?? [];
  if (sessions.length || tasks.length) {
    out.push("");
    out.push(fmt.label("linked"));
    for (const session of sessions) {
      out.push(`  ${c.magenta}${session.short_id}${c.reset} ${fmt.muted(session.title ?? "")}`);
    }
    for (const task of tasks) {
      out.push(`  ${c.yellow}${task.short_id}${c.reset} ${fmt.muted(task.title ?? "")}${task.status ? ` ${fmt.muted(`[${task.status}]`)}` : ""}`);
    }
  }

  const events: any[] = data.events ?? [];
  if (events.length) {
    out.push("");
    out.push(fmt.label(`recent events (${events.length})`));
    out.push(formatPrEvents(events, now));
  }

  return out.join("\n");
}

/** The event list, newest first. */
export function formatPrEvents(events: any[], now: number = Date.now()): string {
  if (events.length === 0) return fmt.muted("No events recorded for this pull request yet.");
  return events
    .map((event) => {
      const age = event.created_at ? formatAge(Math.max(0, now - event.created_at)) : "";
      const actor = event.actor_login ? `${event.actor_login} ` : "";
      return `  ${fmt.muted(age.padStart(4))} ${c.blue}${event.kind}${c.reset} ${actor}${event.title ?? ""}`;
    })
    .join("\n");
}

// ── the command ──────────────────────────────────────────────────────────────

/** The convex websocket URL behind the HTTP site URL the CLI already holds. */
export function convexUrlFromSiteUrl(siteUrl: string): string {
  return siteUrl.replace(".site", ".cloud");
}

async function locate(
  deps: PublishDeps,
  ref: string | undefined,
  opts: { repo?: string } = {},
): Promise<PrLocator> {
  const local = readLocalGitContext();
  // --repo only narrows what the reference left out. buildPrLocator holds the
  // one rule for that, so a reference naming its own repository still wins.
  return buildPrLocator(ref, {
    session: deps.detectCurrentSessionId(),
    repository: opts.repo ?? local.repository,
    branch: local.branch,
  });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function registerPrCommand(program: Command, deps: PublishDeps): void {
  const pr = program
    .command("pr")
    .description(
      "Pull requests: their state, their checks, their reviews, and the session shepherding each one\n\n" +
      "A pull request reference is a number (123), an owner and name with a number\n" +
      "(owner/repo#123), a GitHub or codecast URL, or nothing at all. Nothing means\n" +
      "the PR this session is bound to, and failing that the PR for the branch you\n" +
      "are standing on.\n\n" +
      "Subcommands:\n" +
      "  cast pr ls                     Open pull requests, newest change first\n" +
      "  cast pr show [ref]             Everything known about one\n" +
      "  cast pr events [ref]           Its timeline\n" +
      "  cast pr watch [ref]            Live state changes, one line each\n" +
      "  cast pr shepherd on|off|status Bind a session to a PR until it merges\n" +
      "  cast pr open [ref]             Its codecast page\n" +
      "  cast pr comment [ref] \"text\"   Comment on GitHub from here",
    );

  // ── ls ──
  pr.command("ls")
    .description("List pull requests across your teams, newest change first")
    .option("--repo <owner/name>", "Only this repository")
    .option("--state <state>", "open (default) | merged | closed | all", "open")
    .option("--mine", "Only PRs you opened")
    .option("--shepherded", "Only PRs a session is shepherding")
    .option("-n, --limit <n>", "How many to show", "20")
    .option("--json", "Machine-readable output")
    .action(async (options) => {
      const local = readLocalGitContext();
      const result = await apiPost(deps, "/cli/pr/ls", {
        repository: options.repo ?? undefined,
        state: options.state === "all" ? undefined : options.state,
        mine: options.mine || undefined,
        shepherded: options.shepherded || undefined,
        limit: Number(options.limit) || 20,
      }, { read: true });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const rows: PrRow[] = result.pull_requests ?? [];
      console.log(formatPrTable(rows));
      if (rows.length === 0 && local.repository) {
        console.log(fmt.muted(`\nThis checkout is ${local.repository}. \`cast pr ls --state all\` widens the search.`));
      }
    });

  // ── show ──
  pr.command("show")
    .argument("[ref]", "PR reference (default: this session's PR, or your branch's)")
    .description("Everything on one pull request: state, checks, reviews, links and its last events")
    .option("--repo <owner/name>", "Repository to resolve the reference in")
    .option("--json", "Machine-readable output")
    .action(async (ref: string | undefined, options) => {
      const locator = await locate(deps, ref, options).catch((error: Error) => fail(error.message));
      const result = await apiPost(deps, "/cli/pr/show", locator, { read: true });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.pull_request) fail(noMatch(locator));
      console.log(formatPrShow(result));
    });

  // ── events ──
  pr.command("events")
    .argument("[ref]", "PR reference")
    .description("The pull request's timeline: pushes, reviews, checks, merges")
    .option("--repo <owner/name>", "Repository to resolve the reference in")
    .option("-n, --limit <n>", "How many events", "30")
    .option("--json", "Machine-readable output")
    .action(async (ref: string | undefined, options) => {
      const locator = await locate(deps, ref, options).catch((error: Error) => fail(error.message));
      const result = await apiPost(deps, "/cli/pr/events", {
        ...locator,
        limit: Number(options.limit) || 30,
      }, { read: true });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.pull_request) fail(noMatch(locator));
      console.log(formatPrEvents(result.events ?? []));
    });

  // ── watch ──
  pr.command("watch")
    .argument("[ref]", "PR reference (default: every PR you can see)")
    .description(
      "Stream state changes as they happen: one line per change, silent until something moves\n\n" +
      "Watches shepherd state, checks, review decision, merge state and open review\n" +
      "comments. The first frame is the silent baseline, so what prints is the change.",
    )
    .option("--repo <owner/name>", "Watch one repository")
    .option("--all", "Watch every pull request you can see")
    .option("--json", "NDJSON: one JSON object per change")
    .action(async (ref: string | undefined, options) => {
      const wantsOne = !!ref && !options.all;
      let prIds: string[] | undefined;
      if (wantsOne) {
        const locator = await locate(deps, ref, options).catch((error: Error) => fail(error.message));
        const resolved = await apiPost(deps, "/cli/pr/resolve", locator, { read: true });
        if (!resolved.pull_request) fail(noMatch(locator));
        prIds = [resolved.pull_request.id];
      }

      const { siteUrl, apiToken } = deps.getCliEndpoint();
      const { ConvexClient } = await import("convex/browser");
      const client = new ConvexClient(convexUrlFromSiteUrl(siteUrl));
      process.on("SIGINT", () => { try { client.close(); } catch {} process.exit(0); });

      const scope = prIds ? `${prIds.length} pull request` : options.repo ? options.repo : "every pull request you can see";
      const header = `cast pr: watching ${scope} for changes${icons.dot} Ctrl-C to stop`;
      if (options.json) { if (process.stderr.isTTY) process.stderr.write(`${header}\n`); }
      else console.log(`${header}\n`);

      let previous: PrWatchRow[] | null = null;
      client.onUpdate(
        "prCli:watchPRs" as any,
        { api_token: apiToken, repository: options.repo, pr_ids: prIds },
        (result: any) => {
          if (!result || result.error) return;
          const rows: PrWatchRow[] = result.pull_requests ?? [];
          for (const event of diffPrRows(previous, rows)) {
            if (options.json) console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
            else console.log(formatPrChangeLine(event));
          }
          previous = rows;
        },
      );
      await new Promise(() => {});
    });

  // ── shepherd ──
  pr.command("shepherd")
    .argument("<action>", "on | off | status")
    .argument("[ref]", "PR reference")
    .description(
      "Bind a session to a pull request until it merges\n\n" +
      "A shepherded PR wakes its session when the state moves: a review lands, CI\n" +
      "turns red, the branch falls behind, the merge is ready. `off` releases it.",
    )
    .option("--for <session>", "Bind another session of yours (default: this one)")
    .option("--repo <owner/name>", "Repository to resolve the reference in")
    .option("--json", "Machine-readable output")
    .action(async (action: string, ref: string | undefined, options) => {
      if (!["on", "off", "status"].includes(action)) {
        fail(`Unknown action "${action}". Use on, off, or status.`);
      }
      const locator = await locate(deps, ref, options).catch((error: Error) => fail(error.message));
      const session = options.for ?? deps.detectCurrentSessionId() ?? undefined;
      if (action === "on" && !session) {
        fail("No session to bind. Pass one with --for (e.g. cast pr shepherd on 123 --for jx7c6zk)");
      }
      const result = await apiPost(deps, "/cli/pr/shepherd", {
        ...locator,
        action,
        bind_session: action === "status" ? undefined : session,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.pull_request) fail(noMatch(locator));
      const target = `${c.cyan}${result.pull_request.repository}#${result.pull_request.number}${c.reset}`;
      const shepherd = result.pull_request.shepherd ?? {};
      if (action === "status") {
        if (!shepherd.session_short_id) {
          console.log(fmt.muted(`${result.pull_request.repository}#${result.pull_request.number} has no shepherd`));
          return;
        }
        console.log(
          `${target} shepherded by ${c.magenta}${shepherd.session_short_id}${c.reset} ` +
          `${shepherd.enabled ? fmt.success("on") : fmt.warning("off")}` +
          (shepherd.state ? ` ${color(shepherd.state, SHEPHERD_COLOR[shepherd.state])}` : "") +
          (shepherd.trigger_short_id ? ` ${fmt.muted(shepherd.trigger_short_id)}` : ""),
        );
        return;
      }
      console.log(
        action === "on"
          ? `${c.green}ok${c.reset} ${target} is shepherded by ${c.magenta}${shepherd.session_short_id}${c.reset}` +
            (shepherd.trigger_short_id ? ` ${fmt.muted(`via ${shepherd.trigger_short_id}`)}` : "")
          : `${c.green}ok${c.reset} ${target} is no longer shepherded`,
      );
    });

  // ── open ──
  pr.command("open")
    .argument("[ref]", "PR reference")
    .description("Open the pull request's codecast page")
    .option("--repo <owner/name>", "Repository to resolve the reference in")
    .option("--print", "Print the URL instead of opening it")
    .action(async (ref: string | undefined, options) => {
      const locator = await locate(deps, ref, options).catch((error: Error) => fail(error.message));
      const result = await apiPost(deps, "/cli/pr/resolve", locator, { read: true });
      if (!result.pull_request) fail(noMatch(locator));
      const url = result.pull_request.codecast_url
        ?? codecastPrUrl(result.pull_request.repository, result.pull_request.number);
      console.log(url);
      if (!options.print) {
        try { await open(url); } catch {}
      }
    });

  // ── comment ──
  pr.command("comment")
    .argument("[ref]", "PR reference")
    .argument("[text]", stdinText("The comment body"))
    .description(
      "Comment on the pull request through GitHub, recorded against this session\n\n" +
      "With --file and --line the comment lands on that line of the diff; without\n" +
      "them it lands on the conversation. Text `-` reads stdin.",
    )
    .option("--repo <owner/name>", "Repository to resolve the reference in")
    .option("--file <path>", "Anchor the comment to a file in the diff")
    .option("--line <n>", "Anchor the comment to a line of that file")
    .option("--json", "Machine-readable output")
    .action(async (ref: string | undefined, text: string | undefined, options) => {
      const { ref: refArg, body } = splitCommentArgs(ref, text);
      if (!body || !body.trim()) fail("Nothing to say. Pass the comment text, or `-` to read stdin.");
      if (options.line && !options.file) fail("--line needs --file. A line number alone anchors nothing.");

      const locator = await locate(deps, refArg, options).catch((error: Error) => fail(error.message));
      const result = await apiPost(deps, "/cli/pr/comment", {
        ...locator,
        content: body,
        file_path: options.file,
        line_number: options.line ? Number(options.line) : undefined,
        session: deps.detectCurrentSessionId() ?? undefined,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `${c.green}ok${c.reset} commented on ${c.cyan}${result.repository}#${result.number}${c.reset} ` +
        fmt.muted(`${result.url ?? ""} (mirrored to GitHub in a moment)`),
      );
    });
}

/**
 * Sort out the two optional arguments of `cast pr comment`. One argument means
 * the reference was left out and this is the body: a reference always parses,
 * a comment almost never does.
 *
 * A body still reading "-" got there through the reference slot, which the
 * parser's stdin expansion never looks at, so read the heredoc here.
 */
export function splitCommentArgs(
  ref: string | undefined,
  text: string | undefined,
  readBody: () => string = readStdinBody,
): { ref?: string; body?: string } {
  let refArg = ref;
  let body = text;
  if (refArg !== undefined && body === undefined && !parsePrRef(refArg)) {
    body = refArg;
    refArg = undefined;
  }
  if (body === "-") body = readBody();
  return { ref: refArg, body };
}

function noMatch(locator: PrLocator): string {
  if (locator.number != null) {
    return locator.repository
      ? `No pull request ${locator.repository}#${locator.number} in your teams.`
      : `No pull request #${locator.number} in your teams. Name the repository with owner/repo#${locator.number}.`;
  }
  const tried = [
    locator.session ? "this session's binding" : "",
    locator.branch ? `branch ${locator.branch}` : "",
  ].filter(Boolean).join(" or ");
  return tried
    ? `No pull request found by ${tried}. Pass one: cast pr show 123`
    : "No pull request given, and none could be inferred here. Pass one: cast pr show 123";
}
