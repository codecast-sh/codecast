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
// Registered from index.ts via registerDecideCommand(program, deps) — same
// deps contract as the publish command, so it reuses cliFetch auth and the
// artifact publish payload builder rather than growing its own plumbing.
import * as fs from "fs";
import * as path from "path";
import type { Command } from "commander";
import { apiPost, buildPublishPayload, type PublishDeps } from "./publish.js";
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

export function registerDecideCommand(program: Command, deps: PublishDeps): void {
  program
    .command("decide")
    .description(
      "Hand your human one decision: question, options, and the context to choose\n\n" +
        "The decision appears in their queue; the answer arrives back in this\n" +
        "session as a message. Default is blocking: post it, then end your turn.\n\n" +
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
        "    --context \"429s for 4m. Backing off costs ~20m of throughput.\""
    )
    .argument("<question>", "The decision, phrased as one question")
    .requiredOption(
      "-o, --option <label>",
      'An option; repeat 2-9 times. "Label :: what happens if chosen" adds a description',
      (val: string, acc: string[]) => [...acc, val],
      [] as string[]
    )
    .option("--context <text>", "Markdown context: the reasoning, the tradeoff, what happens under each choice. Pass - to read stdin")
    .option("--report <file>", "HTML/markdown report published as the decision's body (reuses cast publish)")
    .option("--advisory", "Don't block: you proceed with --default and the answer can override you later")
    .option("--default <n>", "1-based option you proceed with when --advisory (required with it)")
    .option("--session <id>", "Session to attribute the decision to (default: detect current)")
    .option("--json", "Machine-readable output")
    .action(async (question: string, options: any) => {
      const optionList: DecideOption[] = (options.option as string[]).map(parseDecideOption);
      if (optionList.length < 2 || optionList.length > 9) {
        console.error(fmt.error("Provide 2-9 options (-o), they map to keys 1-9 in the queue."));
        process.exit(1);
      }

      let contextMd: string | undefined = options.context;
      if (contextMd === "-") contextMd = readStdinSync().trim() || undefined;

      if (!contextMd && !options.report) {
        console.error(fmt.error("A bare question is not decidable. Pass --context (or --report) with the reasoning and the tradeoff."));
        process.exit(1);
      }

      let defaultOption: number | undefined;
      if (options.advisory) {
        if (!options.default) {
          console.error(fmt.error("--advisory requires --default <n>: say which option you are proceeding with."));
          process.exit(1);
        }
        defaultOption = parseInt(options.default, 10) - 1;
        if (isNaN(defaultOption) || defaultOption < 0 || defaultOption >= optionList.length) {
          console.error(fmt.error(`--default must be 1-${optionList.length}.`));
          process.exit(1);
        }
      } else if (options.default) {
        console.error(fmt.error("--default only makes sense with --advisory (a blocking ask has no default)."));
        process.exit(1);
      }

      const sessionId = options.session || deps.detectCurrentSessionId();
      if (!sessionId) {
        console.error(fmt.error("No session detected. Run inside a codecast session or pass --session <id>."));
        process.exit(1);
      }

      // Publish the report first (existing artifact pipeline) so the decision
      // row carries only the slug.
      let reportSlug: string | undefined;
      let reportUrl: string | undefined;
      if (options.report) {
        const absPath = path.resolve(options.report);
        if (!fs.existsSync(absPath)) {
          console.error(fmt.error(`No such report file: ${options.report}`));
          process.exit(1);
        }
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
        ).catch((err) => {
          console.error(fmt.error(`Report publish failed: ${err instanceof Error ? err.message : err}`));
          process.exit(1);
        });
        reportSlug = result?.slug;
        reportUrl = result?.url;
      }

      const result = await apiPost(
        deps,
        "/cli/decide",
        {
          session_id: sessionId,
          question,
          options: optionList,
          context_md: contextMd,
          report_slug: reportSlug,
          blocking: !options.advisory,
          default_option: defaultOption,
        },
        { exitOnError: false }
      ).catch((err) => {
        console.error(fmt.error(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      });

      if (options.json) {
        console.log(JSON.stringify({ ...result, report_slug: reportSlug, report_url: reportUrl }, null, 2));
        return;
      }

      console.log(`${fmt.success("Decision posted:")} ${question}`);
      for (let i = 0; i < optionList.length; i++) {
        const opt = optionList[i];
        const marker = defaultOption === i ? "  (your default)" : "";
        console.log(fmt.muted(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}${marker}`));
      }
      if (reportUrl) console.log(fmt.muted(`  report: ${reportUrl}`));
      if (options.advisory) {
        console.log(fmt.muted("Advisory: continue with your default. The human's answer arrives as a message and may override you."));
      } else {
        console.log(fmt.muted("Blocking: end your turn now. The answer arrives as a user message."));
      }
    });
}
