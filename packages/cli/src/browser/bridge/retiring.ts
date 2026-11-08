/**
 * A bridge host that agreed to make way for a newer cast (host.ts /retire)
 * exits a moment later; a request that lands in between is answered 503
 * with RETIRING_HEADER. Every CLI-side HTTP call to the bridge goes through
 * fetchBridge, which waits that handover out instead of failing: it retries
 * the retiring answer, and the refused connections until the replacement
 * host is up, within a short budget.
 */

import { setTimeout as sleep } from "node:timers/promises";

export const RETIRING_HEADER = "x-cast-retiring";
const HANDOVER_BUDGET_MS = 10_000;

export async function fetchBridge(url: string | URL, init: RequestInit = {}, budgetMs = HANDOVER_BUDGET_MS): Promise<Response> {
  const deadline = Date.now() + budgetMs;
  let handingOver = false;
  for (;;) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 503 || !res.headers.get(RETIRING_HEADER)) return res;
      handingOver = true;
    } catch (err) {
      // A refused connection is the handover's gap only after the host said it was going.
      if (!handingOver || init.signal?.aborted) throw err;
    }
    if (Date.now() >= deadline) throw new Error(`the bridge host was restarting for a newer cast and no replacement answered within ${Math.round(budgetMs / 1000)}s`);
    await sleep(250);
  }
}
