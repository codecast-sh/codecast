// `cast decide` — the asking half of the decision queue.
//
// An agent hands its human ONE well-formed decision: the question, explicit
// options, and enough context (reasoning, tradeoff, consequences) to choose
// without opening the session. Optionally a full HTML report, published
// through the existing artifact pipeline so the queue can embed it.
//
// The row lands in session_decisions (convex) via /cli/decide. The human
// answers from the web queue; the chosen option arrives back in this session
// as a normal user message through the existing send pipeline — so after
// posting, the agent should END ITS TURN (blocking mode) or continue with the
// declared default (--advisory).
//
// A posted decision is not final. `cast decide edit [id]` changes the open
// question in place (the facts changed, the question changes with them);
// `cast decide cancel [id]` withdraws it; `cast decide ls` lists this session's
// decisions with their ids and how each was answered. With no id, edit and
// cancel act on the session's one open decision. Same first-word dispatch as
// `cast publish ls|rm|…`, so a question that happens to start with one of
// these words must be quoted — it always is.
//
// Registered from index.ts via registerDecideCommand(program, deps) — same
// deps contract as the publish command, so it reuses cliFetch auth and the
// artifact publish payload builder rather than growing its own plumbing.
import * as fs from "fs";
import * as path from "path";
import type { Command } from "commander";
import { apiPost, buildPublishPayload, type PublishDeps } from "./publish.js";
import { cliFetch } from "./cliHttp.js";
import { fmt } from "./colors.js";

export interface DecideOption {
  label: string;
  description?: string;
}

// "Label :: description" → { label, description }. A bare label stays a label.
export function parseDecideOption(raw: string): DecideOption {
  const idx = raw.indexOf("::");
  if (idx === -1) return { label: raw.trim() };
  const label = raw.slice(0, idx).trim();
  const description = raw.slice(idx + 2).trim();
  return description ? { label, description } : { label };
}

export function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

export interface DecisionRow {
  id: string;
  question: string;
  options: DecideOption[];
  blocking: boolean;
  default_option?: number;
  status: "pending" | "answered" | "dismissed" | "withdrawn";
  answer_index?: number;
  answer_text?: string;
  answer_label?: string;
  created_at: number;
  updated_at?: number;
  resolved_at?: number;
  // Pending rows only: how many messages the conversation has produced since
  // the ask — the server computes it from a message-count snapshot taken at
  // ask time.
  messages_since?: number;
}

export function formatAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// An open ask the session has visibly moved past. Either signal alone marks
// it: hours of wall clock, or enough conversation that the question likely no
// longer matches the work.
const STALE_AGE_MS = 2 * 60 * 60 * 1000;
const STALE_MESSAGES_SINCE = 30;

export function isStaleDecision(row: DecisionRow, now: number = Date.now()): boolean {
  if (row.status !== "pending") return false;
  return now - row.created_at >= STALE_AGE_MS || (row.messages_since ?? 0) >= STALE_MESSAGES_SINCE;
}

const DECIDE_SUBCOMMANDS = new Set(["edit", "cancel", "rm", "withdraw", "ls", "list"]);

// Convex ids are opaque lowercase alphanumerics of 20+ chars; nothing else an
// agent types here (a question, a subcommand) looks like one.
export function looksLikeDecisionId(value: string | undefined): boolean {
  return !!value && /^[a-z0-9]{20,}$/i.test(value);
}

// Which row `edit`/`cancel` acts on. An explicit id wins. Otherwise the
// session's single open decision — and if there are several, refuse rather
// than guess: editing the wrong question is worse than asking for the id.
export function pickDecisionTarget(
  rows: DecisionRow[],
  explicitId?: string
): { id: string } | { error: string } {
  if (explicitId) return { id: explicitId };
  const open = rows.filter((r) => r.status === "pending");
  if (open.length === 1) return { id: open[0].id };
  if (open.length === 0) {
    const last = rows[0];
    return {
      error: last
        ? `No open decision in this session. The latest one is ${describeResolution(last)} — run \`cast decide ls\`.`
        : "No open decision in this session. Post one with `cast decide \"<question>\" -o … -o … --context …`.",
    };
  }
  return {
    error:
      `${open.length} open decisions in this session; say which one:\n` +
      open.map((r) => `  ${r.id}  ${r.question}`).join("\n"),
  };
}

export function describeResolution(row: DecisionRow): string {
  if (row.status === "pending") return "still open";
  if (row.status === "answered") {
    const answer =
      row.answer_label ??
      (row.answer_index !== undefined ? row.options[row.answer_index]?.label : undefined) ??
      row.answer_text ??
      "an answer";
    return `answered: ${answer}`;
  }
  if (row.status === "dismissed") return "dismissed by your human without an answer";
  return "withdrawn";
}

export function formatDecisionList(rows: DecisionRow[], now: number = Date.now()): string {
  if (rows.length === 0) return "No decisions posted from this session.";
  const body = rows
    .map((r) => {
      const head = `${r.status === "pending" ? "●" : "○"} ${r.id}  ${r.question}`;
      const age =
        r.status === "pending"
          ? ` — asked ${formatAge(now - r.created_at)}${r.messages_since !== undefined ? `, ${r.messages_since} message${r.messages_since === 1 ? "" : "s"} since` : ""}`
          : "";
      const lines = [head, `    ${describeResolution(r)}${age}${r.blocking ? "" : "  (advisory)"}`];
      r.options.forEach((o, i) => {
        const mark = r.answer_index === i ? "✓" : r.default_option === i && r.status === "pending" ? "→" : " ";
        lines.push(`    ${mark} ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
      });
      return lines.join("\n");
    })
    .join("\n");
  const stale = rows.filter((r) => isStaleDecision(r, now));
  if (stale.length === 0) return body;
  return (
    body +
    `\n\nThe work has likely moved past ${stale.length === 1 ? "an open decision" : `${stale.length} open decisions`}. ` +
    `Withdraw the ones that no longer apply (cast decide cancel <id>), or bring them up to date (cast decide edit <id>) — ` +
    `a stale question in your human's queue costs attention and earns nothing.`
  );
}

function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

// Validates the advisory/default pair the same way for ask and edit.
function resolveDefault(options: any, optionCount: number | undefined): number | undefined {
  if (options.advisory) {
    if (!options.default) fail("--advisory requires --default <n>: say which option you are proceeding with.");
    const n = parseInt(options.default, 10) - 1;
    if (isNaN(n) || n < 0 || (optionCount !== undefined && n >= optionCount)) {
      fail(`--default must be 1-${optionCount ?? 9}.`);
    }
    return n;
  }
  if (options.default) fail("--default only makes sense with --advisory (a blocking ask has no default).");
  return undefined;
}

// A resolved row answers the edit/cancel attempt itself: the agent learns the
// verdict instead of a bare "cannot change".
function explainResolved(err: unknown, result: any): never {
  if (result?.status && result.status !== "pending") {
    fail(`This decision is already ${describeResolution(result as DecisionRow)}. Act on that answer; it is in the conversation.`);
  }
  fail(err instanceof Error ? err.message : String(err));
}

async function decideApi(deps: PublishDeps, body: Record<string, unknown>): Promise<any> {
  // exitOnError false so a resolved row's summary (rides along with `error`)
  // is readable here; apiPost throws only the message.
  const { siteUrl, apiToken } = deps.getCliEndpoint();
  const response = await cliFetch(`${siteUrl}/cli/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, ...body }),
  });
  const text = await response.text();
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    fail(`API error (${response.status}): ${text.slice(0, 200)}`);
  }
  if (result?.error) explainResolved(new Error(String(result.error)), result);
  return result;
}

async function publishReport(deps: PublishDeps, file: string, sessionId: string): Promise<{ slug?: string; url?: string }> {
  const absPath = path.resolve(file);
  if (!fs.existsSync(absPath)) fail(`No such report file: ${file}`);
  const payload = buildPublishPayload(absPath);
  const result = await apiPost(
    deps,
    "/cli/artifacts/publish",
    {
      title: payload.title,
      source_path: payload.source_path,
      ...(payload.kind ? { kind: payload.kind } : {}),
      ...(payload.content !== undefined ? { content: payload.content } : {}),
      ...(payload.files ? { files: payload.files } : {}),
      session_ref: sessionId,
    },
    { exitOnError: false }
  ).catch((err) => fail(`Report publish failed: ${err instanceof Error ? err.message : err}`));
  return { slug: result?.slug, url: result?.url };
}

// What the human will see, printed back to the one party that can still fix a
// thin payload. Shared by ask and edit.
function printPreview(question: string, optionList: DecideOption[], defaultOption: number | undefined, contextMd: string | undefined, reportUrl: string | undefined, reportSlug: string | undefined) {
  for (let i = 0; i < optionList.length; i++) {
    const opt = optionList[i];
    const marker = defaultOption === i ? "  (your default)" : "";
    console.log(fmt.muted(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}${marker}`));
  }
  if (reportUrl) console.log(fmt.muted(`  report: ${reportUrl}`));
  if (contextMd) {
    const preview = contextMd.length > 400 ? `${contextMd.slice(0, 400)}…` : contextMd;
    console.log(fmt.muted("\n  ── what they will see ──"));
    for (const line of preview.split("\n")) console.log(fmt.muted(`  ${line}`));
  }
  // A decision they cannot resolve from the card costs them a session open,
  // which is the whole thing the queue exists to avoid.
  const contextChars = (contextMd ?? "").trim().length;
  if (!reportSlug && contextChars < 200) {
    console.log(
      fmt.muted(
        `\n  Note: ${contextChars} characters of context. They will probably have to open the session to answer this.\n  Say what you found, what each option costs, and why you cannot pick — or attach --report.`
      )
    );
  }
  if (optionList.every((o) => !o.description)) {
    console.log(
      fmt.muted("  Note: no option carries a consequence. \"Label :: what happens if chosen\" is what makes a choice decidable at a glance.")
    );
  }
}

export function registerDecideCommand(program: Command, deps: PublishDeps): void {
  program
    .command("decide")
    .description(
      "Hand your human one decision: question, options, and the context to choose\n\n" +
        "The decision appears in their queue and renders as a card in the conversation;\n" +
        "the answer arrives back in this session as a message. Default is blocking:\n" +
        "post it, then end your turn.\n\n" +
        "Subcommands:\n" +
        "  cast decide ls                      This session's decisions, with ids and answers\n" +
        "  cast decide edit [id] [flags]       Change the open decision in place (question, -o, --context, --report, --advisory/--blocking)\n" +
        "  cast decide cancel [id]             Withdraw the open decision\n\n" +
        "Examples:\n" +
        '  cast decide "Which schema wins?" -o "Frontmatter wins" -o "Path wins" --context -  <<\'EOF\'\n' +
        "  The daemon writes note ids from the file path; the web index derives\n" +
        "  them from frontmatter. Renames keep one id and change the other, so\n" +
        "  the same note indexes twice. Either side can be authoritative.\n" +
        "  EOF\n" +
        '  cast decide "Approve dropping agent_runs_v1?" -o "Approve :: frees the last migration" -o "Hold" \\\n' +
        "    --context \"Nothing wrote to it in 40 days. Not recoverable without a backup restore.\" \\\n" +
        "    --report drop-analysis.html\n" +
        '  cast decide "Back off or switch keys?" -o "Back off" -o "Switch keys" --advisory --default 1 \\\n' +
        "    --context \"429s for 4m. Backing off costs ~20m of throughput.\"\n" +
        '  cast decide edit --context - <<\'EOF\'          # new facts: rewrite the open decision\'s context\n' +
        "  …\n" +
        "  EOF\n" +
        "  cast decide cancel                           # the question no longer applies"
    )
    .argument("[question]", "The decision, phrased as one question — or a subcommand: ls | edit | cancel")
    .argument("[args...]", "subcommand arguments (edit/cancel take an optional decision id)")
    .option(
      "-o, --option <label>",
      'An option; repeat 2-9 times. "Label :: what happens if chosen" adds a description',
      (val: string, acc: string[]) => [...acc, val],
      [] as string[]
    )
    .option("--question <text>", "edit: replace the question")
    .option("--context <text>", "Markdown context: the reasoning, the tradeoff, what happens under each choice. Pass - to read stdin")
    .option("--report <file>", "HTML/markdown report published as the decision's body (reuses cast publish)")
    .option("--advisory", "Don't block: proceed with --default. Only when the default is cheap to undo — the answer often lands an hour later and may override you")
    .option("--default <n>", "1-based option you proceed with when --advisory (required with it)")
    .option("--blocking", "edit: turn an advisory decision into a blocking one (clears the default)")
    .option("--session <id>", "Session to attribute the decision to (default: detect current)")
    .option("--json", "Machine-readable output")
    .action(async (question: string | undefined, rest: string[], options: any) => {
      const sessionId = options.session || deps.detectCurrentSessionId();
      if (!sessionId) fail("No session detected. Run inside a codecast session or pass --session <id>.");

      const sub = question && DECIDE_SUBCOMMANDS.has(question) ? question : null;
      const rawOptions = options.option as string[];
      const optionList: DecideOption[] | undefined = rawOptions.length > 0 ? rawOptions.map(parseDecideOption) : undefined;
      if (optionList && (optionList.length < 2 || optionList.length > 9)) {
        fail("Provide 2-9 options (-o), they map to keys 1-9 in the queue.");
      }

      let contextMd: string | undefined = options.context;
      if (contextMd === "-") contextMd = readStdinSync().trim() || undefined;

      // ── ls ──
      if (sub === "ls" || sub === "list") {
        const result = await decideApi(deps, { action: "ls", session_id: sessionId });
        const rows: DecisionRow[] = result.decisions ?? [];
        if (options.json) console.log(JSON.stringify(rows, null, 2));
        else console.log(formatDecisionList(rows));
        return;
      }

      // ── edit / cancel: resolve the target first ──
      if (sub) {
        const explicitId = rest[0];
        if (explicitId && !looksLikeDecisionId(explicitId)) {
          fail(`"${explicitId}" is not a decision id. Ids are printed by \`cast decide\` and \`cast decide ls\`.`);
        }
        let target = explicitId;
        if (!target) {
          const listed = await decideApi(deps, { action: "ls", session_id: sessionId });
          const picked = pickDecisionTarget(listed.decisions ?? [], undefined);
          if ("error" in picked) fail(picked.error);
          target = picked.id;
        }

        if (sub === "cancel" || sub === "rm" || sub === "withdraw") {
          const result = await decideApi(deps, { action: "cancel", session_id: sessionId, decision_id: target });
          if (options.json) console.log(JSON.stringify(result, null, 2));
          else console.log(`${fmt.success("Decision withdrawn:")} ${target}. It leaves the queue; the conversation shows it as withdrawn.`);
          return;
        }

        // edit
        const changes: Record<string, unknown> = {};
        if (options.question) changes.question = options.question;
        if (optionList) changes.options = optionList;
        if (contextMd !== undefined) changes.context_md = contextMd;
        if (options.report) {
          const report = await publishReport(deps, options.report, sessionId);
          changes.report_slug = report.slug;
          changes.report_url = report.url;
        }
        if (options.blocking && options.advisory) fail("--blocking and --advisory contradict each other.");
        if (options.blocking) {
          changes.blocking = true;
          changes.clear_default = true;
        } else if (options.advisory) {
          changes.blocking = false;
          changes.default_option = resolveDefault(options, optionList?.length);
        } else if (options.default) {
          fail("--default only makes sense with --advisory (a blocking ask has no default).");
        }
        const { report_url: reportUrl, ...payload } = changes as any;
        if (Object.keys(payload).length === 0) {
          fail("Nothing to change. Pass --question, -o, --context, --report, --advisory --default <n>, or --blocking.");
        }
        const result = await decideApi(deps, { action: "edit", session_id: sessionId, decision_id: target, ...payload });
        if (options.json) {
          console.log(JSON.stringify({ ...result, ...(reportUrl ? { report_url: reportUrl } : {}) }, null, 2));
          return;
        }
        console.log(`${fmt.success("Decision updated:")} ${target}`);
        console.log(fmt.muted(`  changed: ${Object.keys(payload).filter((k) => k !== "clear_default").join(", ")}`));
        if (optionList || contextMd !== undefined) {
          printPreview(options.question ?? "(question unchanged)", optionList ?? [], payload.default_option, contextMd, reportUrl, payload.report_slug ?? "kept");
        }
        console.log(fmt.muted("The card in the conversation and the queue now show the new text. Do not restate it in prose."));
        return;
      }

      // ── ask ──
      if (!question) fail('Usage: cast decide "<question>" -o … -o … --context … — or: ls | edit [id] | cancel [id]');
      if (!optionList) fail("Provide 2-9 options (-o), they map to keys 1-9 in the queue.");
      if (!contextMd && !options.report) {
        fail("A bare question is not decidable. Pass --context (or --report) with the reasoning and the tradeoff.");
      }
      if (options.blocking) fail("--blocking is for `cast decide edit`; a new decision blocks unless you pass --advisory.");
      const defaultOption = resolveDefault(options, optionList.length);

      // Publish the report first (existing artifact pipeline) so the decision
      // row carries only the slug.
      let reportSlug: string | undefined;
      let reportUrl: string | undefined;
      if (options.report) {
        const report = await publishReport(deps, options.report, sessionId);
        reportSlug = report.slug;
        reportUrl = report.url;
      }

      const result = await decideApi(deps, {
        session_id: sessionId,
        question,
        options: optionList,
        context_md: contextMd,
        report_slug: reportSlug,
        blocking: !options.advisory,
        default_option: defaultOption,
      });

      if (options.json) {
        console.log(JSON.stringify({ ...result, report_slug: reportSlug, report_url: reportUrl }, null, 2));
        return;
      }

      console.log(`${fmt.success(result.updated ? "Decision updated:" : "Decision posted:")} ${question}`);
      // The id is the handle for edit/cancel; the web renders the row as a
      // card keyed by it, so it also appears in the transcript.
      console.log(fmt.muted(`  id: ${result.id}`));
      printPreview(question, optionList, defaultOption, contextMd, reportUrl, reportSlug);

      console.log(fmt.muted("\nThis renders as a card in the conversation and in their queue. Do not repeat the question, options, or reasoning in prose."));
      console.log(fmt.muted("If the facts change: cast decide edit — never a second decision. If it no longer applies: cast decide cancel."));

      // Earlier asks still open in this session: only the poster can tell
      // which ones the work has moved past, so say them here, at the moment
      // it is thinking about its decisions anyway.
      const otherOpen: Array<{ id: string; question: string; created_at: number; messages_since?: number }> = result.other_open ?? [];
      if (otherOpen.length > 0) {
        console.log(fmt.muted(`\nStill open from this session (${otherOpen.length} earlier):`));
        for (const o of otherOpen) {
          const drift = o.messages_since !== undefined ? `, ${o.messages_since} message${o.messages_since === 1 ? "" : "s"} since` : "";
          console.log(fmt.muted(`  ${o.id}  ${o.question}  (asked ${formatAge(Date.now() - o.created_at)}${drift})`));
        }
        console.log(fmt.muted("If the work has moved past any of these, withdraw them: cast decide cancel <id>."));
      }
      if (options.advisory) {
        console.log(fmt.muted("Advisory: continue with your default. The human's answer arrives as a message and may override you."));
      } else {
        console.log(fmt.muted("Blocking: end your turn now. The answer arrives as a user message."));
      }
    });
}
