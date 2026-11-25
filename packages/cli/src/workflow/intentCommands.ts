// The intent segment's two commands (templates/intent.cast), hidden under `cast flow`:
//
//   cast flow asker [conversation] [--task ct-N] [--run <id>]
//     what the Read station reads (flowAsker.ts): who started a change's line
//     of work, what people typed along it and their card answers, each with its
//     provenance, so a person's own "ship it" can be told from a program's relay.
//     A task alone reads the sessions tied to it.
//
//   cast flow intent-verify <run> (--cite <session:line> | --card sd-N) --quote <words> --head <sha> --record <file>
//     whether the line or card answer the Read station cited is the run
//     starter's own word to ship, checked by the server (/cli/intent/verify).
//     It writes nothing to the run: on success it writes `record` (intent.json:
//     {starter_id, starter_name, cite, quote, head}) for a flow composing the
//     segment to route on, and on a refusal it says why and exits 1.
import * as fs from "node:fs";
import type { Command } from "commander";
import { fitAskerRecord } from "./flowAsker.js";

type CliPost = (urlPath: string, body: Record<string, any>, opts?: { timeoutMs?: number; throwOnError?: boolean }) => Promise<any>;

export type IntentVerifyOptions = { cite?: string; card?: string; quote: string; head: string; record: string };

/** Verify a cited word with the server and write intent.json; throws with the server's words on a refusal. */
export async function intentVerify(cliPost: CliPost, run: string, o: IntentVerifyOptions): Promise<Record<string, unknown>> {
  const cite = o.cite?.match(/^(.+):(\d+)$/);
  if (o.cite !== undefined && !cite) throw new Error("--cite is <session short id>:<line>");
  const card = o.card?.trim();
  if (o.card !== undefined && !/^sd-\d+$/.test(card ?? "")) throw new Error("--card is a decision card, sd-N");
  if (!!cite === !!card) throw new Error("Give --cite or --card, one of them");
  const head = o.head.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`--head is a full commit sha, not ${head || "nothing"}`);
  const r = await cliPost("/cli/intent/verify", {
    run_id: run,
    ...(cite ? { cite: { conversation_short_id: cite[1], line: Number(cite[2]) } } : { card }),
    quote: o.quote,
    head,
  }, { throwOnError: true });
  const record = { starter_id: r.starter_id, starter_name: r.starter_name, cite: r.cite, quote: r.quote, head };
  fs.writeFileSync(o.record, `${JSON.stringify(record)}\n`);
  return record;
}

export function registerIntentCommands(flow: Command, cliPost: CliPost): void {
  flow
    .command("asker [conversation]", { hidden: true })
    .description("Print a session's chain up to the one that started its work, its originator, and every line a person typed and card a person answered along it (rendered for a model in `text`), as one JSON object")
    .option("--task <id>", "Also read the chain of the session that filed this task (ct-N) and the task's Ship cards; with no session, the task alone: the chains of the sessions that filed it, are bound to it or handed it off")
    .option("--run <id>", "Also name who started this workflow run (starter_id, starter_name), read from the run itself")
    .option("--record <chars>", "The JSON size to fit (default: what a station records)")
    .action(async (conversation: string | undefined, opts: { task?: string; run?: string; record?: string }) => {
      if (!conversation && !opts.task) {
        console.error("Name a session or a task (--task ct-N)");
        process.exit(1);
      }
      const read = await cliPost("/cli/sessions/originator", {
        ...(conversation ? { conversation_id: conversation } : {}), ...(opts.task ? { task: opts.task } : {}), ...(opts.run ? { run_id: opts.run } : {}),
      });
      console.log(JSON.stringify(fitAskerRecord(read, opts.record ? Number(opts.record) : undefined)));
    });

  flow
    .command("intent-verify <run>", { hidden: true })
    .description("Check with the server that the line or card answer the intent read cited is the run starter's own word to ship, and write intent.json")
    .option("--cite <session:line>", "The typed line the read cited")
    .option("--card <sd-N>", "In place of --cite: the decision card whose answer the read cited")
    .requiredOption("--quote <text>", "The words the read quoted")
    .requiredOption("--head <sha>", "The commit the read was given, recorded as head")
    .requiredOption("--record <file>", "Where to write {starter_id, starter_name, cite, quote, head} on success")
    .action(async (run: string, opts: IntentVerifyOptions) => {
      try {
        const record = await intentVerify(cliPost, run, opts);
        console.log(`verified: ${record.starter_name}'s word (${record.cite})`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
