/**
 * `cast browser handoff "<what the human should do>"`: hand the human one step
 * on this session's tab (a sign-in, a 2FA code, a payment) and end the turn.
 *
 * The extension draws a card in the page saying what to do, with one Continue
 * button, and shows WAIT on its toolbar badge for that tab. Nothing is raised
 * unless --show asks. The card is the extension's own (background.js
 * setHandoff, page.js): a closed shadow root in the top layer, put back when
 * the page removes it, completed only by the human's trusted click on
 * Continue or the toolbar popup's Continue.
 *
 * The verb returns at once. It arms the shared browser subscription
 * (subscribe.ts) on the handoff's id, whose check reads the handoff's state
 * from the bridge host's tab list without touching the page, and wakes this
 * session when the human continues, the timeout passes, or the tab goes away.
 */

import type { Command } from "commander";
import { randomBytes } from "node:crypto";
import { CAST_HANDOFF_METHOD } from "./bridge/protocol.js";
import { isRealSession } from "./engine.js";
import { connectToTab } from "./pageEval.js";
import { readHandoffState, subscribeToPage, type BrowserSubDeps } from "./subscribe.js";

export const HANDOFF_DEFAULT_TIMEOUT = "30m";
/** How often the wake's precheck reads the tab list: cheap, no page access. */
export const HANDOFF_CHECK_EVERY = "10s";

/** "90s", "30m", "2h" as milliseconds, or null. Bounded to the extension's 10 s .. 24 h. */
export function parseHandoffTimeout(text: string): number | null {
  const m = /^(\d+)\s*(s|m|h)$/.exec(text.trim());
  if (!m) return null;
  const ms = Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
  return ms >= 10_000 && ms <= 24 * 3_600_000 ? ms : null;
}

/** The subscription's window in whole hours (cli-kit reads "m" as months): the timeout plus a margin. */
export function subscriptionWindow(timeoutMs: number): string {
  return `${Math.ceil((timeoutMs + 10 * 60_000) / 3_600_000)}h`;
}

type HandoffReply = { id: string; state: string; shown?: boolean; expires?: number };

/** Send `Cast.handoff` over this session's tab; the extension answers it without involving Chrome. */
async function sendHandoff(deps: BrowserSubDeps, params: Record<string, unknown>): Promise<HandoffReply> {
  const tab = await deps.currentTab();
  if (!isRealSession(tab.session)) throw new Error("a handoff needs the human's Chrome: the extension draws the card (cast browser target real)");
  const c = await connectToTab(tab);
  if ("error" in c) throw new Error(c.hint ? `${c.error} (${c.hint})` : c.error);
  try {
    return await c.conn.send<HandoffReply>(CAST_HANDOFF_METHOD, params, c.sessionId, 20_000);
  } catch (err) {
    const msg = (err as Error).message;
    // An extension from before handoffs passes the method on to Chrome, which does not know it.
    if (/wasn't found|not found|unknown method/i.test(msg)) throw new Error("the Codecast extension in this Chrome predates handoffs; update it (or reload it from chrome://extensions)");
    throw err;
  } finally {
    c.conn.close();
  }
}

export function registerHandoffCommand(br: Command, deps: BrowserSubDeps & { session: () => string | undefined }): void {
  br.command("handoff [words...]")
    .description("Hand the human a step on this session's tab (a card with Continue); returns at once and wakes this session when they continue, so end your turn")
    .option("--timeout <duration>", "give up after this long (90s, 30m, 2h); the wake says it timed out", HANDOFF_DEFAULT_TIMEOUT)
    .option("--show", "also bring the tab to the front of the human's screen")
    .option("--note <text>", "what to do when it wakes you; the wake prompt carries it")
    .option("--status", "say where this tab's handoff stands, then exit")
    .option("--cancel", "take this tab's handoff card down")
    .action(async (words: string[] | undefined, o: { timeout: string; show?: boolean; note?: string; status?: boolean; cancel?: boolean }) => {
      try {
        if (o.status) {
          const state = await readHandoffState(await deps.currentTab());
          if (typeof state !== "string") fail(state.error);
          console.log(state === "none" ? "No handoff on this session's tab." : `This tab's handoff is ${state}.`);
          return;
        }
        if (o.cancel) {
          const r = await sendHandoff(deps, { cancel: true });
          console.log(r.id ? `Handoff ${r.id} is ${r.state}.` : "No handoff was waiting on this tab.");
          return;
        }
        const text = (words ?? []).join(" ").trim();
        if (!text) fail('say what the human should do: cast browser handoff "Sign in with your work account, then press Continue"');
        const timeoutMs = parseHandoffTimeout(o.timeout);
        if (timeoutMs === null) fail(`--timeout takes 10s to 24h, like 90s, 30m or 2h, not "${o.timeout}"`);
        const session = deps.session();
        if (!session) fail("only an agent session can hand off: the wake goes back into the session that owns the tab");
        const id = randomBytes(6).toString("hex");
        const shown = await sendHandoff(deps, { text, id, timeoutMs, raise: !!o.show });
        const r = await subscribeToPage(deps, { handoff: id }, { note: o.note, every: HANDOFF_CHECK_EVERY, for: subscriptionWindow(timeoutMs), session });
        if ("already" in r) {
          console.log(`The handoff ended at once (${r.already.handoff}); carry on.`);
          return;
        }
        console.log(`Handed off on this tab: "${text}". The card waits ${o.timeout}${o.show ? "; the tab is in front" : "; nothing was raised (the human sees WAIT on the Codecast icon, or --show)"}.`);
        if (shown.shown === false) console.log("! This page cannot show the card (a Chrome page or the Web Store); the toolbar badge and popup still carry it.");
        console.log(`${r.sub.trigger} wakes this session when they continue or it times out. End your turn now (cast state --status dormant naming ${r.sub.id}). Cancel: cast browser handoff --cancel`);
      } catch (err) {
        fail((err as Error).message);
      }
    });
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}
