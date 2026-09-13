/**
 * `cast browser pane <url>` (and its top-level alias `cast preview <url>`) —
 * the agent offers a page, the human opens it.
 *
 * An agent that has just started a dev server knows the one address the reader
 * wants and cannot reach it: the agent's shell is not the reader's screen. So
 * it writes the address onto the conversation and the viewer grows a chip next
 * to the session title. Opening the pane stays a click, never a push: the web
 * app refuses machine-initiated moves of what the reader is looking at (web
 * store/viewNav.ts), and a pane that opened itself would be the same
 * intrusion by another route.
 *
 * The command is pure network — no browser, no tab, nothing to attach to —
 * which is why it is registered before `registerBrowserCommand` hands the rest
 * of the verbs to the engine. It works on a machine with no Chrome at all.
 */

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "../castApi.js";
import { fmt, icons } from "../colors.js";
import { commandGroup } from "../commandGroups.js";
import { normalizePaneUrl } from "@codecast/shared/contracts";

/** What the backend answered, as the printer needs it. */
export interface PaneOfferResponse {
  short_id?: string;
  title?: string;
  url?: string;
}

export type PaneOfferPlan =
  | { ok: true; url: string; title?: string; session: string }
  | { ok: false; message: string; hint?: string };

/**
 * Decide what to send before anything is sent. Two ways to fail and they need
 * different words: an address the pane could never load, and no session to
 * attach the offer to (a human in a bare shell, which is most of the time this
 * command is typed by hand).
 */
export function planPaneOffer(
  rawUrl: string,
  opts: { title?: string; for?: string },
  sessionId: string | null,
): PaneOfferPlan {
  const url = normalizePaneUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      message: `'${rawUrl}' is not a web address`,
      hint: "pass a URL a browser can load: cast browser pane localhost:3000",
    };
  }
  const session = opts.for || sessionId;
  if (!session) {
    return {
      ok: false,
      message: "this shell is not a codecast session, so the offer has nowhere to land",
      hint: "run it from an agent session, or name one: cast browser pane <url> --for <session>",
    };
  }
  const title = opts.title?.trim();
  return { ok: true, url, title: title || undefined, session };
}

/** The one line the agent reads back, plus the note that says who acts next. */
export function paneOfferLines(url: string, res: PaneOfferResponse): string[] {
  const where = res.short_id ? `${res.short_id}` : "the viewer";
  return [
    `${fmt.success(icons.check)} Offered ${fmt.highlight(url)} as a pane in ${where}`,
    fmt.muted("  the reader opens it beside the conversation from the chip on the session header"),
  ];
}

/**
 * Attach the verb to a command. Mounted twice — under `cast browser` and as
 * the top-level `cast preview` — because the address of a running dev server
 * is the thing an agent offers most often, and a shorter name is one less
 * reason not to.
 */
export function registerPaneOfferCommand(
  parent: Command,
  deps: PublishDeps,
  name: string,
  description: string,
): void {
  parent
    .command(name + " <url>")
    .description(description)
    .option("--title <text>", "What to call the page in the chip")
    .option("--for <session>", "Offer it in another session (default: the current one)")
    .action(async (url: string, o: { title?: string; for?: string }) => {
      const plan = planPaneOffer(url, o, deps.detectCurrentSessionId());
      if (!plan.ok) {
        console.error(`${fmt.error(icons.cross)} ${plan.message}`);
        if (plan.hint) console.error(`  ${fmt.muted(plan.hint)}`);
        process.exit(1);
      }
      const res: PaneOfferResponse = await apiPost(deps, "/cli/browser/pane-offer", {
        session: plan.session,
        url: plan.url,
        ...(plan.title ? { title: plan.title } : {}),
      });
      for (const line of paneOfferLines(plan.url, res)) console.log(line);
    });
}

/** The top-level alias. `cast preview localhost:3000` is the whole gesture, and
 *  it loads none of the browser engine to make it. */
export function registerPreviewCommand(program: Command, deps: PublishDeps): void {
  registerPaneOfferCommand(program, deps, "preview", commandGroup("preview").description);
}
