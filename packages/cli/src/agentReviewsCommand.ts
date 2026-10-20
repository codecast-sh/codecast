// `cast line reviews` (docs/architecture/learning-loop.md LL8; convex
// agentReviews.ts, agentReviewsHost.ts): an agent judge's reviews, started in
// bulk, run on this machine's slots, watched, stopped and read back.
//
//   cast line reviews start --source <s> [--kind <k>] [--batch <label>] (--file <subjects.txt> | <subject>...)
//   cast line reviews run [--slots N] [--accounts a,b] [--max-percent 85] [--per-account 3] [--root <source>=<path>]
//   cast line reviews stop
//   cast line reviews status [--source <s>] [--batch <label>] [--json]
//   cast line reviews cancel|retry --source <s> [--batch <label>]
//   cast line reviews show <rv-N|mo-N> [--json]
import fs from "node:fs";
import type { Command } from "commander";
import { fmt } from "./colors.js";
import { apiPost, type PublishDeps } from "./castApi.js";
import { durationWords } from "@codecast/shared/contracts/moments";
import type { ReviewTranscript } from "@codecast/shared/contracts/agentJudges";
import { REVIEWS_DEFAULTS, REVIEWS_TICK_MS, harnessScript, heldRuns, pickAccounts, readReviewsConfig, reviewsConfigFile, tickReviews, writeReviewsConfig } from "./agentReviewsHost.js";

const START_BATCH = 500;
const mins = (ms?: number | null) => (ms == null ? "–" : `${(ms / 60_000).toFixed(1)}m`);
const usd = (n?: number | null) => (n == null ? "–" : `$${n.toFixed(2)}`);

export function registerReviewsCommands(line: Command, deps: PublishDeps): void {
  const scope = async () => {
    const { scopeFor } = await import("./lineScope.js");
    const s: Record<string, unknown> = { ...(await scopeFor(deps, undefined, true)) };
    delete s.project;
    return s;
  };
  const reviews = line.command("reviews").description("An agent judge's reviews: start them for many subjects, run them on this machine, watch, stop and read them");

  reviews
    .command("start [subjects...]")
    .description("Open a moment as of now for each subject (a contact id); each is read by the kind's extractor and reviewed by its agent judges")
    .requiredOption("--source <name>", "The source whose extractor and agent judge read them")
    .option("--kind <kind>", "The moment kind", "contact-conversation")
    .option("--file <path>", "Subjects, one per line (or - for stdin)")
    .option("--batch <label>", "A label to watch, cancel or retry these by")
    .option("--as-of <iso>", "Read each as it stood at this time instead of now (a replay, to compare with an earlier review)")
    .option("--json", "Machine-readable output")
    .action(async (given: string[], options: { source: string; kind: string; file?: string; batch?: string; asOf?: string; json?: boolean }) => {
      const asOf = options.asOf ? Date.parse(options.asOf) : undefined;
      if (options.asOf && !Number.isFinite(asOf)) { console.error(fmt.error(`--as-of takes a time, not ${options.asOf}`)); process.exit(2); }
      const fromFile = options.file ? fs.readFileSync(options.file === "-" ? 0 : options.file, "utf8").split(/\s+/) : [];
      const subjects = [...new Set([...given, ...fromFile].map((s) => s.trim()).filter(Boolean))];
      if (!subjects.length) { console.error(fmt.error("Name the subjects: as arguments, or --file with one per line")); process.exit(2); }
      let opened = 0;
      let joined = 0;
      for (let i = 0; i < subjects.length; i += START_BATCH) {
        const r = await apiPost(deps, "/cli/reviews/start", { ...(await scope()), source: options.source, kind: options.kind, subjects: subjects.slice(i, i + START_BATCH), ...(options.batch ? { batch: options.batch } : {}), ...(asOf ? { as_of: asOf } : {}) });
        opened += r.opened;
        joined += r.joined;
      }
      if (options.json) return console.log(JSON.stringify({ subjects: subjects.length, opened, joined, batch: options.batch ?? null }, null, 2));
      console.log(`${subjects.length} subject${subjects.length === 1 ? "" : "s"}: ${opened} moment${opened === 1 ? "" : "s"} opened as of ${options.asOf ?? "now"}${joined ? `, ${joined} joined one already waiting` : ""}${options.batch ? `, batch ${options.batch}` : ""}.`);
      console.log("The machine that runs the extractor reads them; each queues its agent review. Watch with: cast line reviews status" + (options.batch ? ` --batch ${options.batch}` : ""));
    });

  reviews
    .command("run")
    .description("Run reviews on this machine: N at once, on the saved profiles with room (the daemon does the work every 30 seconds)")
    .option("--slots <n>", "Reviews at once on this machine")
    .option("--accounts <names>", "Only these saved profiles, comma separated (default: every profile with a setup token)")
    .option("--max-percent <n>", "A profile above this share of its worst limit window takes no new review")
    .option("--per-account <n>", "Reviews one profile runs at once")
    .option("--root <source=path>", "Where the judge's repo is on this machine, when not where it was published", (v: string, acc: string[] = []) => [...acc, v], [] as string[])
    .action((options: { slots?: string; accounts?: string; maxPercent?: string; perAccount?: string; root: string[] }) => {
      const before = readReviewsConfig();
      const roots = { ...(before.roots ?? {}) };
      for (const r of options.root) {
        const [source, ...rest] = r.split("=");
        if (!source || !rest.length) { console.error(fmt.error(`--root takes <source>=<path>, not ${r}`)); process.exit(2); }
        roots[source] = rest.join("=");
      }
      const cfg = writeReviewsConfig({
        slots: options.slots !== undefined ? Math.max(0, Number(options.slots) || 0) : before.slots || 4,
        ...(options.accounts !== undefined ? { accounts: options.accounts.split(",").map((a) => a.trim()).filter(Boolean) } : {}),
        ...(options.maxPercent !== undefined ? { max_percent: Number(options.maxPercent) || REVIEWS_DEFAULTS.max_percent } : {}),
        ...(options.perAccount !== undefined ? { per_account: Math.max(1, Number(options.perAccount) || 1) } : {}),
        roots,
      });
      if (!harnessScript()) console.log(fmt.warning("This build carries no dry-run harness (scripts/prompt-dry-run.ts); this machine cannot run reviews."));
      printMachine(cfg);
    });

  reviews
    .command("pass")
    .description("Run the daemon's pass here now: hand back what finished, renew what runs, fill free slots (--watch repeats it every 30 seconds)")
    .option("--watch", "Keep passing until stopped")
    .action(async (options: { watch?: boolean }) => {
      const { deviceId } = await import("./remote/device.js");
      for (;;) {
        const r = await tickReviews({ post: (route, body) => apiPost(deps, route, body, { exitOnError: false }), deviceId: deviceId(), log: console.log });
        console.log(fmt.muted(`${new Date().toISOString().slice(11, 19)} ${r.handed} handed back, ${r.started} started, ${r.running} running here`));
        if (!options.watch) return;
        await new Promise((done) => setTimeout(done, REVIEWS_TICK_MS));
      }
    });

  reviews
    .command("stop")
    .description("This machine takes no new review; the ones running finish and hand back")
    .action(() => {
      const cfg = writeReviewsConfig({ slots: 0 });
      printMachine(cfg);
    });

  reviews
    .command("status")
    .description("The queue: how many wait, run, finished and failed, what runs where, and what the newest took")
    .option("--source <name>", "One source")
    .option("--batch <label>", "One bulk start")
    .option("--json", "Machine-readable output")
    .action(async (options: { source?: string; batch?: string; json?: boolean }) => {
      const r = await apiPost(deps, "/cli/reviews/status", { ...(await scope()), ...(options.source ? { source: options.source } : {}), ...(options.batch ? { batch: options.batch } : {}) }, { read: true });
      if (options.json) return console.log(JSON.stringify({ ...r, machine: { config: readReviewsConfig(), running_here: heldRuns().length } }, null, 2));
      const c = r.counts;
      const total = c.queued + c.running + c.done + c.failed;
      if (r.moments) console.log(`Moments: ${r.moments.ready} read, ${r.moments.extracting} being read, ${r.moments.waiting} waiting, ${r.moments.failed} failed`);
      console.log(`${fmt.highlight(`${c.done} of ${total}`)} done · ${c.running} running · ${c.queued} queued · ${c.failed} failed${c.cancelled ? ` · ${c.cancelled} cancelled` : ""}`);
      const a = r.averages;
      if (a.of) {
        const perHour = a.last_hour;
        const eta = perHour && c.queued + c.running ? ` · about ${durationWords(((c.queued + c.running) / perHour) * 3_600_000)} left at this pace` : "";
        console.log(`Newest ${a.of}: ${mins(a.took_ms)} each, ${Math.round(a.turns ?? 0)} turns, ${usd(a.notional_usd)} at list price (subscription quota), ${(a.findings ?? 0).toFixed(1)} findings · ${perHour} finished in the last hour${eta}`);
      }
      for (const x of r.running) console.log(`  ${fmt.muted("running")} ${x.review} ${x.moment} ${x.subject} on ${x.device?.slice(0, 8) ?? "?"}/${x.account ?? "?"} for ${mins(Date.now() - (x.started_at ?? Date.now()))}${x.attempts > 1 ? `, try ${x.attempts}` : ""}`);
      for (const x of r.recent.slice(0, 8)) console.log(`  ${fmt.muted("done")} ${x.review} ${x.moment} ${x.findings} found, ${x.filed} filed, ${mins(x.took_ms)}, ${usd(x.notional_usd)}, ${x.account ?? ""}`);
      for (const x of r.failed.slice(0, 8)) console.log(`  ${fmt.warning("failed")} ${x.review} ${x.moment}: ${x.error ?? "no reason"}`);
      printMachine(readReviewsConfig());
    });

  for (const [name, route, what] of [["cancel", "/cli/reviews/cancel", "Queued reviews stop waiting (running ones finish)"], ["retry", "/cli/reviews/retry", "Failed reviews queue again with fresh tries"]] as const) {
    reviews
      .command(name)
      .description(what)
      .requiredOption("--source <name>", "The source")
      .option("--batch <label>", "Only this bulk start")
      .option("--cancelled", "retry: the cancelled ones instead of the failed")
      .action(async (options: { source: string; batch?: string; cancelled?: boolean }) => {
        let n = 0;
        for (;;) {
          const r = await apiPost(deps, route, { ...(await scope()), source: options.source, ...(options.batch ? { batch: options.batch } : {}), ...(options.cancelled && name === "retry" ? { cancelled: true } : {}) });
          n += r.cancelled ?? r.queued ?? 0;
          if (!r.left) break;
        }
        console.log(`${n} review${n === 1 ? "" : "s"} ${name === "cancel" ? "cancelled" : "queued again"}.`);
      });
  }

  reviews
    .command("show <review>")
    .description("One review's whole session (rv-N, or a moment's newest review by mo-N)")
    .option("--json", "Machine-readable output")
    .action(async (ref: string, options: { json?: boolean }) => {
      const r: { review: any; transcript: ReviewTranscript | null } = await apiPost(deps, "/cli/reviews/transcript", { ...(await scope()), review: ref }, { read: true });
      if (options.json) return console.log(JSON.stringify(r, null, 2));
      const v = r.review;
      console.log(`${v.short_id} ${v.moment_short_id} ${v.subject}: ${v.status}${v.findings !== undefined ? `, ${v.findings} found, ${v.filed ?? 0} filed` : ""}${v.took_ms ? `, ${mins(v.took_ms)}` : ""}${v.notional_usd !== undefined ? `, ${usd(v.notional_usd)} at list price` : ""}${v.account ? ` on ${v.account}` : ""}${v.error ? ` (${v.error})` : ""}`);
      if (!r.transcript) return console.log(fmt.muted("No transcript kept."));
      r.transcript.turns.forEach((turn, i) => {
        console.log(fmt.highlight(`\n── Turn ${i + 1} ──`));
        for (const e of turn) {
          if (e.kind === "prompt") console.log(fmt.muted(`[prompt, ${e.text.length.toLocaleString("en-US")} characters]`));
          else if (e.kind === "text") console.log(`\n${e.text}`);
          else if (e.kind === "tool_use") console.log(fmt.muted(`\n> ${e.name}: ${e.text.replace(/\s+/g, " ").slice(0, 300)}`));
          else if (e.kind === "tool_result") console.log(fmt.muted(`  ${e.error ? "error: " : ""}${e.text.replace(/\s+/g, " ").slice(0, 200)}`));
        }
      });
    });
}

/** This machine's part: its slots, what it runs, and the profiles a new review would start on now. */
function printMachine(cfg: ReturnType<typeof readReviewsConfig>) {
  const held = heldRuns();
  const busy = new Map<string, number>();
  for (const r of held.filter((h) => h.alive)) busy.set(r.account, (busy.get(r.account) ?? 0) + 1);
  const ready = pickAccounts(cfg, busy, new Map());
  console.log(`This machine: ${cfg.slots ? `${cfg.slots} slot${cfg.slots === 1 ? "" : "s"}` : "off"}, ${held.filter((h) => h.alive).length} running here · profiles with room: ${ready.length ? ready.join(", ") : "none"} (under ${cfg.max_percent}%, ${cfg.per_account} each) · ${reviewsConfigFile()}`);
}
