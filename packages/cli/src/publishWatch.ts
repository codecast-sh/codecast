// `cast publish watch` and `cast publish unwatch`: a session signs up for the
// changes people make to a published page's state, and stops.
//
// A watch is an ordinary event trigger (`cast trigger add --on page_state
// --page <page>`), armed through that command so it binds to this session the
// same way every trigger does and shows in `cast trigger ls`. What this adds is
// the page check up front and a brief that tells the woken session what the
// page expects of it. The server fires the event on every write (pageState.ts),
// coalesces a burst into one run, and never wakes a session with its own write.
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";

/** What a woken session reads before the changes: the page's purpose is in its own history, so the brief says only how to answer. */
export function watchBrief(page: { title: string; slug: string; url: string }): string {
  return [
    `People changed the data on the published page "${page.title}" (${page.url}), which this session watches. The changes that woke you are listed below.`,
    "",
    "Act on them the way this page is meant to be used; your history here says why it exists. Answer on the page, where the person is looking:",
    `- \`cast publish state ${page.slug}\` reads the current rows.`,
    `- \`cast publish state ${page.slug} <collection> --set key=<json>\` (or --patch, --insert, --delete) writes a row; every open copy of the page shows it at once, marked as yours, and your own writes never wake you.`,
    "A change that asks nothing of you needs no answer.",
  ].join("\n");
}

/** The calling agent's session, as the server's write stamp wants it: exact evidence only, never a guess. */
export function callerSession(env: NodeJS.ProcessEnv = process.env): { conversation_id?: string } {
  return env.CODECAST_CONVERSATION_ID ? { conversation_id: env.CODECAST_CONVERSATION_ID } : {};
}

export async function runPublishWatch(
  program: Command,
  deps: PublishDeps,
  target: string,
  collections: string[],
  opts: { prompt?: string; spawn?: boolean },
): Promise<void> {
  // Read the page first: it proves the page and its collections exist and are
  // readable, and gives the brief its title and address.
  const page = await apiPost(deps, "/cli/artifacts/state", { target, ...(collections.length === 1 ? { collection: collections[0] } : {}) }, { read: true });
  const args = ["trigger", "add", opts.prompt ?? watchBrief(page), "--on", "page_state", "--page", page.slug, "--title", `Watch page ${page.title}`];
  if (collections.length) args.push("--collection", collections.join(","));
  if (opts.spawn) args.push("--spawn");
  await program.parseAsync(args, { from: "user" });
  console.log(fmt.muted(`  Each change to ${page.slug}${collections.length ? ` (${collections.join(", ")})` : ""} wakes ${opts.spawn ? "a fresh session" : "this session"}, a burst as one run. Stop with: cast publish unwatch ${page.slug}`));
}

export async function runPublishUnwatch(program: Command, deps: PublishDeps, target: string, opts: { all?: boolean }): Promise<void> {
  const page = await apiPost(deps, "/cli/artifacts/state", { target }, { read: true });
  const here = process.env.CODECAST_CONVERSATION_ID?.slice(0, 7);
  const watches: Array<{ trigger: string; session: string | null }> = page.watches ?? [];
  const mine = opts.all || !here ? watches : watches.filter((w) => w.session === here);
  if (!mine.length) {
    console.log(fmt.muted(watches.length ? `This session does not watch ${page.slug}; --all stops your other ${watches.length} watch${watches.length === 1 ? "" : "es"} of it.` : `Nothing of yours watches ${page.slug}.`));
    return;
  }
  for (const w of mine) await program.parseAsync(["trigger", "cancel", w.trigger], { from: "user" });
}
