// `cast guide <topic>` — the capability guidance, served by the binary that
// will run the commands.
//
// The same bodies `cast install` writes into CLAUDE.md (SNIPPET_CATALOG in
// @codecast/shared/contracts) printed on demand, under a header naming this
// cast's version and daemon build id. That header is the whole point: an
// agent reading flags out of a CLAUDE.md written months ago has no way to know
// the binary in $PATH moved on, whereas a guide it just asked for cannot be
// older than the command it is about to run.
//
// It is also what makes stub sections possible (`cast install --stubs`): a
// CLAUDE.md then says what a capability is and when to reach for it, and points
// here for the flags.

import type { Command } from "commander";
import {
  type SnippetDescriptor,
  guideTopics,
  snippetBySlug,
  stripSnippetStamp,
} from "@codecast/shared/contracts";
import { DAEMON_BUILD_ID } from "./daemonBuildId.js";
import { getVersion } from "./update.js";
import { c, fmt } from "./colors.js";

/** The guide text for one topic: the installed body without the installer's own
 *  bookkeeping (the end marker, and the version stamp the header already
 *  carries). */
export function guideBody(descriptor: SnippetDescriptor): string {
  const section = descriptor.section;
  if (!section) throw new Error(`snippet "${descriptor.slug}" has no markdown section`);
  return stripSnippetStamp(section.body).split(section.spec.endMarker).join("").trim();
}

/** The line that ties a guide to the binary that printed it. */
export function guideHeader(slug: string): string {
  return `cast guide ${slug} — cast v${getVersion()} (daemon build ${DAEMON_BUILD_ID})`;
}

export interface GuidePayload {
  topic: string;
  name: string;
  version: string;
  build_id: string;
  body: string;
}

export function guidePayload(descriptor: SnippetDescriptor): GuidePayload {
  return {
    topic: descriptor.slug,
    name: descriptor.name,
    version: getVersion(),
    build_id: DAEMON_BUILD_ID,
    body: guideBody(descriptor),
  };
}

/** What an unknown topic prints. Names every topic, so a typo costs one run. */
export function unknownTopicMessage(input: string): string {
  return (
    `unknown guide topic: ${input}\n` +
    `topics: ${guideTopics().map((t) => t.slug).join(", ")}\n` +
    `Run 'cast guide --list' for one line each.`
  );
}

function printList(json: boolean): void {
  const topics = guideTopics();
  if (json) {
    console.log(JSON.stringify(
      {
        version: getVersion(),
        build_id: DAEMON_BUILD_ID,
        topics: topics.map((t) => ({ topic: t.slug, name: t.name, desc: t.desc })),
      },
      null,
      2,
    ));
    return;
  }
  console.log("");
  console.log(fmt.muted(`  cast guide — cast v${getVersion()} (daemon build ${DAEMON_BUILD_ID})`));
  console.log("");
  const width = Math.max(...topics.map((t) => t.slug.length));
  for (const t of topics) {
    console.log(`  ${c.cyan}${t.slug.padEnd(width)}${c.reset}  ${t.desc}`);
  }
  console.log("");
  console.log(fmt.muted(`  cast guide <topic> prints that topic in full.`));
  console.log("");
}

export function registerGuideCommand(program: Command): void {
  program
    .command("guide")
    .description(
      "Print a capability guide from this binary (the one that will run the commands)\n\n" +
      "Same text `cast install` writes into CLAUDE.md, headed by this cast's version\n" +
      "and daemon build id — so a guide can never describe a different binary than\n" +
      "the one in your $PATH.\n\n" +
      "Examples:\n" +
      "  cast guide --list          Every topic, one line each\n" +
      "  cast guide browser         The full Browser guide\n" +
      "  cast guide tasks --json    Machine-readable {topic, version, build_id, body}"
    )
    .argument("[topic]", `topic to print (${guideTopics().map((t) => t.slug).join(", ")})`)
    .option("--list", "List every topic instead of printing one")
    .option("--json", "Machine-readable output")
    .action((topic: string | undefined, options: { list?: boolean; json?: boolean }) => {
      if (options.list || !topic) {
        printList(options.json === true);
        return;
      }
      const descriptor = snippetBySlug(topic);
      if (!descriptor?.section) {
        console.error(unknownTopicMessage(topic));
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(guidePayload(descriptor), null, 2));
        return;
      }
      console.log(guideHeader(descriptor.slug));
      console.log("");
      console.log(guideBody(descriptor));
    });
}
