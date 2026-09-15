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
// W2 (docs/architecture/decisions-as-documents.md D6): an ask may carry a
// kind (single|multi|rank|form), a category proposal, a markdown document,
// option bodies, a JSON spec, and bind to a task, station and stack. The
// race verbs: `recommend` and `escalate` for a role on the ladder, `answer`
// for a person the decision was asked of or the holder role under a grant,
// `show` to read one decision with its document and ladder. Ids are the
// `sd-N` short ids the server prints (raw Convex ids still work).
//
// Registered from index.ts via registerDecideCommand(program, deps) — same
// deps contract as the publish command, so it reuses cliFetch auth and the
// artifact publish payload builder rather than growing its own plumbing.
import * as fs from "fs";
import * as path from "path";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { buildPublishPayload } from "./publish.js";
import { stdinText } from "./sendBody.js";
import { cliFetch } from "./cliHttp.js";
import { fmt } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { readTaskPulseFor } from "./taskPulse.js";

export interface DecideOption {
  label: string;
  description?: string;
  body_md?: string;
  evidence?: { label: string; url: string }[];
  cost?: string;
  risk?: string;
  // A published page of its own (the-line.md L6); the server adds page_url
  // on the rows it returns. A spec may carry `page` instead: a file to
  // publish or an existing slug or url, resolved before the ask is sent.
  page_slug?: string;
  page_url?: string;
  page?: string;
}

export type DecideKind = "single" | "multi" | "rank" | "form";
export const DECIDE_KINDS: DecideKind[] = ["single", "multi", "rank", "form"];

export interface DecideFormField {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "bool";
  options?: string[];
}

// `--spec decision.json`: the whole ask in one file. Every key is optional
// except options (or form fields for kind form); flags on the command line
// win over the spec.
export interface DecideSpec {
  question?: string;
  kind?: DecideKind;
  category?: string;
  context_md?: string;
  doc_md?: string;
  options?: DecideOption[];
  form?: { fields: DecideFormField[] };
  task?: string;
  station?: string;
  stack?: string;
  advisory?: boolean;
  default?: number; // 1-based, as on the command line
}

export function parseDecideSpec(text: string): DecideSpec {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`--spec must be JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("--spec must be a JSON object");
  if (raw.kind !== undefined && !DECIDE_KINDS.includes(raw.kind)) throw new Error(`--spec kind must be one of ${DECIDE_KINDS.join("|")}`);
  const options: DecideOption[] | undefined = Array.isArray(raw.options)
    ? raw.options.map((o: any) => (typeof o === "string" ? parseDecideOption(o) : o))
    : undefined;
  for (const o of options ?? []) if (!o || typeof o.label !== "string" || !o.label.trim()) throw new Error("--spec: every option needs a label");
  if (raw.form !== undefined) {
    const fields = raw.form?.fields;
    if (!Array.isArray(fields) || fields.length === 0) throw new Error("--spec: form.fields must be a non-empty array");
    for (const f of fields) {
      if (typeof f?.key !== "string" || typeof f?.label !== "string" || !["text", "number", "select", "bool"].includes(f?.type)) {
        throw new Error("--spec: each form field needs key, label, and type text|number|select|bool");
      }
    }
  }
  return { ...raw, options };
}

// `cast decide answer <sd> <what>`: "3" for single (also the first pick of a
// multi), "1,3" for multi, "2>1>3" for rank; form answers come from --form
// k=v pairs. Indexes on the wire are 0-based.
export function parseAnswerSpec(
  kind: DecideKind,
  raw: string | undefined,
  formPairs: string[] = [],
  optionCount?: number,
  formFields: DecideFormField[] = [],
): { answer_index?: number; answer_json?: any } {
  const idx = (s: string) => {
    const n = parseInt(s.trim(), 10);
    if (isNaN(n) || n < 1 || (optionCount !== undefined && n > optionCount)) {
      throw new Error(`"${s.trim()}" is not an option number (1-${optionCount ?? 9})`);
    }
    return n - 1;
  };
  if (kind === "form") {
    if (formPairs.length === 0) throw new Error("A form decision is answered with --form key=value (repeat per field).");
    const values: Record<string, string | number | boolean> = {};
    for (const pair of formPairs) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`--form expects key=value, got "${pair}"`);
      const key = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1);
      // Coerce by the field's DECLARED type, so a text field keeps "42" and
      // "true" as text; an unknown key stays a string for the server to refuse.
      const type = formFields.find((f) => f.key === key)?.type ?? "text";
      if (type === "number") {
        if (v.trim() === "" || isNaN(Number(v))) throw new Error(`--form ${key} must be a number`);
        values[key] = Number(v);
      } else if (type === "bool") {
        if (v !== "true" && v !== "false") throw new Error(`--form ${key} must be true or false`);
        values[key] = v === "true";
      } else values[key] = v;
    }
    return { answer_json: values };
  }
  if (!raw) throw new Error("Say which option: a number, \"1,3\" for several, \"2>1>3\" for an order.");
  if (kind === "rank") {
    const list = raw.split(">").map(idx);
    if (list.length < 2) throw new Error("A rank answer orders at least two options: \"2>1>3\".");
    return { answer_json: list, answer_index: list[0] };
  }
  if (kind === "multi") {
    const list = raw.split(",").map(idx);
    return { answer_json: list, answer_index: list[0] };
  }
  if (raw.includes(",") || raw.includes(">")) throw new Error("This decision takes one option number.");
  return { answer_index: idx(raw) };
}

// `--option-body 2=body.md` and `--option-page 2=mockup.html`: one grammar,
// n=file, for every flag that attaches a file to option n.
export function parseOptionFileArg(raw: string, flag: string, example: string): { index: number; file: string } {
  const m = raw.match(/^(\d+)\s*[=:]\s*(.+)$/);
  if (!m) throw new Error(`${flag} expects n=file (e.g. ${example}), got "${raw}"`);
  return { index: parseInt(m[1], 10) - 1, file: m[2].trim() };
}
export const parseOptionBodyArg = (raw: string) => parseOptionFileArg(raw, "--option-body", "2=why-b.md");
export const parseOptionPageArg = (raw: string) => parseOptionFileArg(raw, "--option-page", "2=mockup-b.html");

// An option page reference that is already published: a codecast page url
// (…/a/<slug>) or a bare slug. Anything else is a file to publish. A path
// that exists on disk is always a file, so a file named like a slug still
// publishes.
export function pageRefToSlug(ref: string): string | null {
  if (fs.existsSync(path.resolve(ref))) return null;
  const fromUrl = ref.match(/^https?:\/\/[^/]+\/a\/([A-Za-z0-9_-]+)(?:[?#].*)?$/);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Za-z0-9_-]{6,}$/.test(ref) && !/\.(html?|md|markdown|txt)$/i.test(ref)) return ref;
  return null;
}

// Option pages (the-line.md L6): `--option-page n=file` flags and `page` on
// spec options. A file publishes through the same path --report uses (one
// publish per option, session_ref set); an existing slug or url is kept as
// its slug. Returns the urls to print, by option index; the options are
// patched in place with page_slug and stripped of `page` so the wire shape
// matches the server validator.
export async function attachOptionPages(
  optionList: DecideOption[],
  pageArgs: string[],
  publish: (file: string) => Promise<{ slug?: string; url?: string }>,
): Promise<Record<number, string | undefined>> {
  const refs = new Map<number, string>();
  optionList.forEach((o, i) => {
    if (o.page) refs.set(i, o.page);
  });
  for (const raw of pageArgs) {
    const { index, file } = parseOptionPageArg(raw);
    if (index < 0 || index >= optionList.length) throw new Error(`--option-page ${raw}: no option ${index + 1}.`);
    refs.set(index, file);
  }
  const urls: Record<number, string | undefined> = {};
  for (const [index, ref] of refs) {
    const slug = pageRefToSlug(ref);
    let pageSlug: string | undefined = slug ?? undefined;
    if (!slug) {
      if (!fs.existsSync(path.resolve(ref))) throw new Error(`--option-page: no such file or page: ${ref}`);
      const published = await publish(ref);
      pageSlug = published.slug;
      urls[index] = published.url;
    }
    const { page: _page, ...rest } = optionList[index];
    optionList[index] = { ...rest, page_slug: pageSlug };
  }
  return urls;
}

// A markdown body from a file path, or the text itself when it arrived via
// '-' (stdin is expanded before the action runs).
function bodyFromArg(value: string, flag: string): string {
  const abs = path.resolve(value);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return fs.readFileSync(abs, "utf-8");
  const looksLikePath = !/\s/.test(value) && value.length < 300 && /\.(md|markdown|txt|html|json)$/i.test(value);
  if (looksLikePath) fail(`No such file for ${flag}: ${value}`);
  return value;
}

// "Label :: description" → { label, description }. A bare label stays a label.
export function parseDecideOption(raw: string): DecideOption {
  const idx = raw.indexOf("::");
  if (idx === -1) return { label: raw.trim() };
  const label = raw.slice(0, idx).trim();
  const description = raw.slice(idx + 2).trim();
  return description ? { label, description } : { label };
}


export interface DecisionRow {
  id: string;
  short_id?: string;
  question: string;
  kind?: DecideKind;
  category?: string;
  options: DecideOption[];
  form?: { fields: DecideFormField[] };
  task_id?: string;
  station?: string;
  stack_id?: string;
  holder?: { kind: "user" | "role"; id: string };
  hops?: { role_id: string; recommendation?: number; note?: string; at: number }[];
  answered_by?: { kind: "user" | "role" | "policy"; id: string };
  answer_json?: any;
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

const DECIDE_SUBCOMMANDS = new Set(["edit", "cancel", "rm", "withdraw", "ls", "list", "show", "recommend", "answer", "escalate"]);

// An `sd-N` short id, or a raw Convex id (opaque lowercase alphanumerics of
// 20+ chars); nothing else an agent types here (a question, a subcommand)
// looks like either.
export function looksLikeDecisionId(value: string | undefined): boolean {
  return !!value && (/^sd-\d+$/.test(value) || /^[a-z0-9]{20,}$/i.test(value));
}

// The handle to print for a row: the short id when the server minted one.
export function decisionHandle(row: { id: string; short_id?: string }): string {
  return row.short_id ?? row.id;
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
  if (open.length === 1) return { id: decisionHandle(open[0]) };
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
      open.map((r) => `  ${decisionHandle(r)}  ${r.question}`).join("\n"),
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

export function formatDecisionList(rows: DecisionRow[], now: number = Date.now(), empty = "No decisions posted from this session."): string {
  if (rows.length === 0) return empty;
  const body = rows
    .map((r) => {
      const head = `${r.status === "pending" ? "●" : "○"} ${decisionHandle(r)}  ${r.question}${r.kind && r.kind !== "single" ? `  [${r.kind}]` : ""}${r.category ? `  (${r.category})` : ""}`;
      const age =
        r.status === "pending"
          ? ` — asked ${formatAge(now - r.created_at)}${r.messages_since !== undefined ? `, ${r.messages_since} message${r.messages_since === 1 ? "" : "s"} since` : ""}`
          : "";
      const lines = [head, `    ${describeResolution(r)}${age}${r.blocking ? "" : "  (advisory)"}`];
      if (r.holder?.kind === "role") lines.push(`    held by role ${r.holder.id}`);
      const picked = new Set<number>(Array.isArray(r.answer_json) ? r.answer_json : r.answer_index !== undefined ? [r.answer_index] : []);
      r.options.forEach((o, i) => {
        const mark = picked.has(i) ? "✓" : r.default_option === i && r.status === "pending" ? "→" : " ";
        const recs = (r.hops ?? []).filter((h) => h.recommendation === i).length;
        lines.push(`    ${mark} ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}${recs ? `  (${recs} recommend${recs === 1 ? "s" : ""})` : ""}`);
        if (o.page_url ?? o.page_slug) lines.push(`         page: ${o.page_url ?? o.page_slug}`);
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

// POST to /cli/decide (the ask/edit/cancel/ls verbs) or one of the
// /cli/decide/<verb> routes.
async function decideApi(deps: PublishDeps, body: Record<string, unknown>, route = "/cli/decide"): Promise<any> {
  // exitOnError false so a resolved row's summary (rides along with `error`)
  // is readable here; apiPost throws only the message.
  const { siteUrl, apiToken } = deps.getCliEndpoint();
  const response = await cliFetch(`${siteUrl}${route}`, {
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
function printPreview(question: string, optionList: DecideOption[], defaultOption: number | undefined, contextMd: string | undefined, reportUrl: string | undefined, reportSlug: string | undefined, pageUrls: Record<number, string | undefined> = {}) {
  for (let i = 0; i < optionList.length; i++) {
    const opt = optionList[i];
    const marker = defaultOption === i ? "  (your default)" : "";
    const extras = [opt.cost ? `cost: ${opt.cost}` : "", opt.risk ? `risk: ${opt.risk}` : "", opt.body_md ? `${opt.body_md.length} chars body` : "", opt.evidence?.length ? `${opt.evidence.length} evidence` : ""].filter(Boolean);
    console.log(fmt.muted(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}${marker}${extras.length ? `  [${extras.join(", ")}]` : ""}`));
    if (pageUrls[i] ?? opt.page_slug) console.log(fmt.muted(`     page: ${pageUrls[i] ?? opt.page_slug}`));
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
    .description(commandGroup("decide").description)
    .argument("[question]", "The decision, phrased as one question — or a subcommand: ls | edit | cancel")
    .argument("[args...]", "subcommand arguments (edit/cancel take an optional decision id)")
    .option(
      "-o, --option <label>",
      'An option; repeat 2-9 times. "Label :: what happens if chosen" adds a description',
      (val: string, acc: string[]) => [...acc, val],
      [] as string[]
    )
    .option("--question <text>", stdinText("edit: replace the question"))
    .option("--context <text>", stdinText("Markdown context: the reasoning, the tradeoff, what happens under each choice"))
    .option("--report <file>", "HTML/markdown report published as the decision's body (reuses cast publish)")
    .option("--advisory", "Don't block: proceed with --default. Only when the default is cheap to undo — the answer often lands an hour later and may override you")
    .option("--default <n>", "1-based option you proceed with when --advisory (required with it)")
    .option("--blocking", "edit: turn an advisory decision into a blocking one (clears the default)")
    .option("--session <id>", "Session to attribute the decision to (default: detect current)")
    .option("--task <ct-N>", "The task this decision blocks or informs (default: the task this session is bound to)")
    .option("--no-task", "Do not bind the decision to the session's task")
    .option("--station <s>", "The task status (category or team status id) the task is held at until answered")
    .option("--stack <ds-N>", "Append to a decision stack (cast stack create); ls: list that stack's members")
    .option("--category <c>", "Proposed category: approach|scope|priority|retry|review|allocation (the server may pin a protected one)")
    .option("--kind <k>", `single|multi|rank|form (default single)`)
    .option("--doc <file>", stdinText("Markdown document as the decision's long body (creates a decision doc)"))
    .option("--spec <file>", "JSON spec: { question, kind, category, options[{label,description,body_md,evidence,cost,risk,page}], form{fields}, doc_md, task, station, stack, advisory, default }")
    .option(
      "--option-body <n=file>",
      "Markdown body for option n (repeatable): --option-body 2=why-b.md",
      (val: string, acc: string[]) => [...acc, val],
      [] as string[]
    )
    .option(
      "--option-page <n=file|slug|url>",
      "A page for option n (repeatable): a file publishes like --report, a slug or codecast url attaches an existing page",
      (val: string, acc: string[]) => [...acc, val],
      [] as string[]
    )
    .option("--mine", "ls: every pending decision you hold, across sessions")
    .option("--note <text>", stdinText("recommend/escalate: a short note for the card"))
    .option("--form <k=v>", "answer: a form field value (repeatable)", (val: string, acc: string[]) => [...acc, val], [] as string[])
    .option("--json", "Machine-readable output")
    .action(async (question: string | undefined, rest: string[], options: any) => {
      // `answer` is the one verb a person runs from a plain shell: without a
      // session the server treats the caller as the person; with one, only
      // the holder role under a grant may answer (a session never answers
      // as a person).
      const sessionId: string | null = options.session || deps.detectCurrentSessionId();
      if (!sessionId && question !== "answer") fail("No session detected. Run inside a codecast session or pass --session <id>.");

      const sub = question && DECIDE_SUBCOMMANDS.has(question) ? question : null;
      const spec: DecideSpec | null = options.spec ? parseDecideSpec(bodyFromArg(options.spec, "--spec")) : null;
      const rawOptions = options.option as string[];
      let optionList: DecideOption[] | undefined = rawOptions.length > 0 ? rawOptions.map(parseDecideOption) : spec?.options;
      const kind: DecideKind = options.kind ?? spec?.kind ?? "single";
      if (!DECIDE_KINDS.includes(kind)) fail(`--kind must be one of ${DECIDE_KINDS.join("|")}.`);
      if (kind === "form" && !optionList) optionList = [];
      if (optionList && !sub && ((kind !== "form" && optionList.length < 2) || optionList.length > 9)) {
        fail("Provide 2-9 options (-o), they map to keys 1-9 in the queue.");
      }
      for (const raw of options.optionBody as string[]) {
        const { index, file } = parseOptionBodyArg(raw);
        if (!optionList || index < 0 || index >= optionList.length) fail(`--option-body ${raw}: no option ${index + 1}.`);
        optionList[index] = { ...optionList[index], body_md: bodyFromArg(file, "--option-body") };
      }

      const contextMd: string | undefined = options.context?.trim() || spec?.context_md?.trim() || undefined;

      // ── ls ──
      if (sub === "ls" || sub === "list") {
        const result = await decideApi(deps, { action: "ls", session_id: sessionId, stack: options.stack, task: typeof options.task === "string" ? options.task : undefined, mine: options.mine ? true : undefined });
        const rows: DecisionRow[] = result.decisions ?? [];
        if (options.json) console.log(JSON.stringify(rows, null, 2));
        else console.log(formatDecisionList(rows, Date.now(), options.mine ? "No pending decisions held by you." : undefined));
        return;
      }

      // ── show / recommend / answer / escalate: the race verbs, by sd-N ──
      if (sub === "show" || sub === "recommend" || sub === "answer" || sub === "escalate") {
        const target = rest[0];
        if (!looksLikeDecisionId(target)) fail(`Usage: cast decide ${sub} <sd-N> ${sub === "recommend" ? "<n> [--note -]" : sub === "answer" ? '<n | "1,3" | "2>1>3" | --form k=v>' : sub === "escalate" ? "[--note -]" : ""}`.trim());
        if (sub === "show") {
          const result = await decideApi(deps, { decision_id: target }, "/cli/decide/show");
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          const d: DecisionRow = result.decision;
          console.log(formatDecisionList([d]));
          if (result.task) console.log(fmt.muted(`  task: ${result.task.short_id} ${result.task.title} (at ${d.station ?? result.task.status})`));
          if (result.stack) console.log(fmt.muted(`  stack: ${result.stack.short_id} ${result.stack.title}`));
          if (result.holder_role) console.log(fmt.muted(`  holder: role ${result.holder_role.name} (@${result.holder_role.handle}) under a grant`));
          for (const hop of result.ladder ?? []) {
            const who = hop.role ? `${hop.role.name} (@${hop.role.handle})` : hop.role_id;
            const what = hop.recommendation !== undefined ? `recommends ${hop.recommendation + 1}${hop.note ? ` — ${hop.note}` : ""}` : hop.note ?? "no recommendation yet";
            console.log(fmt.muted(`  ladder: ${who}: ${what}`));
          }
          if (result.doc?.content) {
            console.log(fmt.muted("\n  ── document ──"));
            for (const line of String(result.doc.content).split("\n")) console.log(fmt.muted(`  ${line}`));
          }
          for (let i = 0; i < d.options.length; i++) {
            const o = d.options[i];
            if (!o.body_md && !o.evidence?.length && !o.cost && !o.risk && !o.page_url) continue;
            console.log(fmt.muted(`\n  ── option ${i + 1}: ${o.label} ──`));
            if (o.page_url) console.log(fmt.muted(`  page: ${o.page_url}`));
            if (o.cost) console.log(fmt.muted(`  cost: ${o.cost}`));
            if (o.risk) console.log(fmt.muted(`  risk: ${o.risk}`));
            for (const e of o.evidence ?? []) console.log(fmt.muted(`  evidence: ${e.label} ${e.url}`));
            if (o.body_md) for (const line of o.body_md.split("\n")) console.log(fmt.muted(`  ${line}`));
          }
          return;
        }
        if (sub === "recommend") {
          const n = parseInt(rest[1] ?? "", 10);
          if (isNaN(n) || n < 1 || n > 9) fail("Usage: cast decide recommend <sd-N> <n> [--note -]");
          const result = await decideApi(deps, { decision_id: target, session_id: sessionId, recommendation: n - 1, note: options.note?.trim() || undefined }, "/cli/decide/recommend");
          if (options.json) console.log(JSON.stringify(result, null, 2));
          else {
            console.log(`${fmt.success("Recommended:")} option ${n} on ${decisionHandle(result)} as ${result.role?.name ?? "your role"}.`);
            if (result.late) console.log(fmt.muted("  Past the 5 minute hop deadline; the recommendation still lands on the card."));
            console.log(fmt.muted("  The people decide. If your role holds a grant for this category here, answer instead: cast decide answer."));
          }
          return;
        }
        if (sub === "escalate") {
          const result = await decideApi(deps, { decision_id: target, session_id: sessionId, note: options.note?.trim() || undefined }, "/cli/decide/escalate");
          if (options.json) console.log(JSON.stringify(result, null, 2));
          else console.log(`${fmt.success("Escalated:")} ${decisionHandle(result)} passes upward without a recommendation from ${result.role?.name ?? "your role"}.`);
          return;
        }
        // answer: the kind decides how the argument is read.
        const shown = await decideApi(deps, { decision_id: target }, "/cli/decide/show");
        const row: DecisionRow = shown.decision;
        let parsed: { answer_index?: number; answer_json?: any };
        try {
          parsed = parseAnswerSpec(row.kind ?? "single", rest[1], options.form as string[], row.options.length, row.form?.fields ?? []);
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
        // No session means a person at a plain shell: omit the key rather
        // than send null, which the route's validator refuses.
        const result = await decideApi(deps, { decision_id: target, ...(sessionId ? { session_id: sessionId } : {}), ...parsed }, "/cli/decide/answer");
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else if (result.already_resolved) console.log(fmt.muted(`${decisionHandle(result)} was already resolved; the first answer stands.`));
        else {
          console.log(`${fmt.success("Answered:")} ${decisionHandle(result)} → ${result.answer_label ?? "recorded"} (as ${result.answered_by?.kind === "role" ? "the holder role under a grant" : "a person"}).`);
          if (result.resumed_run) console.log(fmt.muted("  The paused run takes this answer and resumes."));
          else if (result.delivered !== false) console.log(fmt.muted("  The answer is delivered to the asking session as a message."));
        }
        return;
      }

      // Every remaining verb acts on this session's own decisions.
      if (!sessionId) fail("No session detected. Run inside a codecast session or pass --session <id>.");

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

        // edit: every ask field (the-line.md L10), each passed only when given.
        const changes: Record<string, unknown> = {};
        if (options.question) changes.question = options.question;
        let pageUrls: Record<number, string | undefined> = {};
        if (optionList) {
          pageUrls = await attachOptionPages(optionList, options.optionPage as string[], (file) => publishReport(deps, file, sessionId)).catch((err) => fail(err instanceof Error ? err.message : String(err)));
          changes.options = optionList;
        } else if ((options.optionPage as string[]).length > 0) {
          fail("--option-page needs the option list: pass every -o (or --spec) with it, pages attach by option number.");
        }
        if (contextMd !== undefined) changes.context_md = contextMd;
        if (options.kind ?? spec?.kind) changes.kind = options.kind ?? spec?.kind;
        if (spec?.form) changes.form = spec.form;
        if (options.doc ?? spec?.doc_md) changes.doc_md = options.doc ? bodyFromArg(options.doc, "--doc") : spec?.doc_md;
        if (typeof options.task === "string" || spec?.task) changes.task = typeof options.task === "string" ? options.task : spec?.task;
        if (options.station ?? spec?.station) changes.station = options.station ?? spec?.station;
        if (options.stack ?? spec?.stack) changes.stack = options.stack ?? spec?.stack;
        if (options.category ?? spec?.category) changes.category = options.category ?? spec?.category;
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
          fail("Nothing to change. Pass --question, -o, --context, --report, --doc, --kind, --task, --station, --stack, --category, --option-page, --advisory --default <n>, or --blocking.");
        }
        const result = await decideApi(deps, { action: "edit", session_id: sessionId, decision_id: target, ...payload });
        if (options.json) {
          console.log(JSON.stringify({ ...result, ...(reportUrl ? { report_url: reportUrl } : {}) }, null, 2));
          return;
        }
        console.log(`${fmt.success("Decision updated:")} ${target}`);
        console.log(fmt.muted(`  changed: ${Object.keys(payload).filter((k) => k !== "clear_default").join(", ")}`));
        if (result.task) console.log(fmt.muted(`  task: ${result.task.short_id} held at ${result.task.station}`));
        if (result.stack) console.log(fmt.muted(`  stack: ${result.stack.short_id}`));
        if (optionList || contextMd !== undefined) {
          printPreview(options.question ?? "(question unchanged)", optionList ?? [], payload.default_option, contextMd, reportUrl, payload.report_slug ?? "kept", pageUrls);
        }
        console.log(fmt.muted("The card in the conversation and the queue now show the new text. Do not restate it in prose."));
        return;
      }

      // ── ask ──
      question = question ?? spec?.question;
      if (!question) fail('Usage: cast decide "<question>" -o … -o … --context … — or: ls | show | edit [id] | cancel [id] | recommend | answer | escalate');
      if (!optionList) fail("Provide 2-9 options (-o), they map to keys 1-9 in the queue.");
      const docMd: string | undefined = options.doc ? bodyFromArg(options.doc, "--doc") : spec?.doc_md;
      if (!contextMd && !options.report && !docMd) {
        fail("A bare question is not decidable. Pass --context (or --report, or --doc) with the reasoning and the tradeoff.");
      }
      if (options.blocking) fail("--blocking is for `cast decide edit`; a new decision blocks unless you pass --advisory.");
      if (spec?.advisory && !options.advisory) {
        options.advisory = true;
        options.default = options.default ?? (spec.default !== undefined ? String(spec.default) : undefined);
      }
      const defaultOption = resolveDefault(options, optionList.length);
      // --task defaults to the task this session is bound to (D3); --no-task
      // opts out. A spec's task is used when no flag was passed.
      const task: string | undefined =
        options.task === false ? undefined : typeof options.task === "string" ? options.task : spec?.task ?? readTaskPulseFor(sessionId)?.task;
      const category: string | undefined = options.category ?? spec?.category;
      if (category && !/^[a-z]+$/.test(category)) fail("--category is one lowercase word from the vocabulary (approach, scope, priority, retry, review, allocation).");

      // Publish the report first (existing artifact pipeline) so the decision
      // row carries only the slug.
      let reportSlug: string | undefined;
      let reportUrl: string | undefined;
      if (options.report) {
        const report = await publishReport(deps, options.report, sessionId);
        reportSlug = report.slug;
        reportUrl = report.url;
      }
      // Option pages (the-line.md L6): one publish per option, same path.
      const pageUrls = await attachOptionPages(optionList, options.optionPage as string[], (file) => publishReport(deps, file, sessionId)).catch((err) => fail(err instanceof Error ? err.message : String(err)));

      const result = await decideApi(deps, {
        session_id: sessionId,
        question,
        options: optionList,
        context_md: contextMd,
        report_slug: reportSlug,
        blocking: !options.advisory,
        default_option: defaultOption,
        kind,
        category,
        doc_md: docMd,
        form: spec?.form,
        task,
        station: options.station ?? spec?.station,
        stack: options.stack ?? spec?.stack,
      });

      if (options.json) {
        console.log(JSON.stringify({ ...result, report_slug: reportSlug, report_url: reportUrl, option_pages: optionList.map((o, i) => (o.page_slug ? { index: i, slug: o.page_slug, url: pageUrls[i] } : null)).filter(Boolean) }, null, 2));
        return;
      }

      console.log(`${fmt.success(result.updated ? "Decision updated:" : "Decision posted:")} ${question}`);
      // The short id is the handle for edit/cancel/answer; the web renders
      // the row as a card keyed by the id, so both appear in the transcript.
      console.log(fmt.muted(`  id: ${result.short_id ?? result.id}${result.short_id ? `  (${result.id})` : ""}`));
      if (result.category) {
        console.log(fmt.muted(`  category: ${result.category}${result.category_pinned ? " (pinned by the server: a person answers this)" : category && category !== result.category ? ` (proposed ${category})` : ""}`));
      }
      if (result.task) console.log(fmt.muted(`  task: ${result.task.short_id} held at ${result.task.station}`));
      if (result.stack) console.log(fmt.muted(`  stack: ${result.stack.short_id}`));
      if (result.holder?.kind === "role") console.log(fmt.muted(`  holder: a role under a grant may answer this before a person does`));
      const ladder: Array<{ role_id: string; skipped?: string; woken: boolean }> = result.ladder ?? [];
      if (ladder.length) {
        console.log(fmt.muted(`  ladder: ${ladder.length} role${ladder.length === 1 ? "" : "s"} (${ladder.filter((h) => h.woken).length} woken${ladder.some((h) => h.skipped) ? `, ${ladder.filter((h) => h.skipped).length} skipped` : ""}); people: ${result.people ?? 1}`));
      }
      printPreview(question, optionList, defaultOption, contextMd, reportUrl, reportSlug, pageUrls);

      console.log(fmt.muted("\nThis renders as a card in the conversation and in their queue. Do not repeat the question, options, or reasoning in prose."));
      console.log(fmt.muted("If the facts change: cast decide edit — never a second decision. If it no longer applies: cast decide cancel."));

      // Earlier asks still open in this session: only the poster can tell
      // which ones the work has moved past, so say them here, at the moment
      // it is thinking about its decisions anyway.
      const otherOpen: Array<{ id: string; short_id?: string; question: string; created_at: number; messages_since?: number }> = result.other_open ?? [];
      if (otherOpen.length > 0) {
        console.log(fmt.muted(`\nStill open from this session (${otherOpen.length} earlier):`));
        for (const o of otherOpen) {
          const drift = o.messages_since !== undefined ? `, ${o.messages_since} message${o.messages_since === 1 ? "" : "s"} since` : "";
          console.log(fmt.muted(`  ${decisionHandle(o)}  ${o.question}  (asked ${formatAge(Date.now() - o.created_at)}${drift})`));
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
