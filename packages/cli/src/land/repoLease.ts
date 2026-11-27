// The server's lease on a repository's merges and the deploys that go with them
// (convex repoLeases.ts), from any machine, granted in the order takers asked:
// the Merge station holds it from before its rebase to the landed sha, `cast
// ship checkout` from its first before-push deploy to its push, and `cast repo
// lease` around a command. A holder renews it every minute; a holder that dies
// frees it within the lease's ten minutes.
//
// A holder can lose it without dying: a laptop that sleeps past the lease
// comes back to a lease someone else took. So the background renewal marks the
// lease lost when the server says another holds it or when no renewal has
// succeeded for half the lease, and `assertHeld` asks the server outright
// before anything that must happen under it.

import { randomUUID } from "node:crypto";
import os from "node:os";

export type LeasePost = (path: string, body: Record<string, unknown>) => Promise<any>;

export type RepoLease = {
  /** True only when the server has just answered that this holder still holds it. */
  assertHeld: () => Promise<boolean>;
  /** Take it back after losing it, trying until `waitMs` has passed (once, by default). */
  retake: (waitMs?: number) => Promise<boolean>;
  release: () => Promise<void>;
};

const POLL_MS = 5000;
const RENEW_MS = 60_000;
/** Half the server's ten-minute lease: a holder that has not renewed for this long may have lost it. */
const STALE_MS = 5 * 60_000;

/** A server older than the lease has no route for it (castApi missingRouteError): the one failure a holder goes on without. */
export const leaseRouteMissing = (err: unknown) => /has no \/cli\/repo-lease route/.test(errorText(err));

/** A failure worth asking again: the network or the server's gateway, never an answer the server gave. */
const transient = (err: unknown) => /ECONN|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network|timed? ?out|took too long|not answering|HTTP 5\d\d|API error \(5\d\d\)/i.test(errorText(err));
const errorText = (err: unknown) => { const e = err as { message?: string; code?: string; cause?: { code?: string } } | null; return [e?.message ?? String(err), e?.code, e?.cause?.code].filter(Boolean).join(" "); };

/** Who holds a lease, as a person waiting on it reads it: what, on which machine. */
export const leaseHolder = (what: string) => `${what} on ${os.hostname()}`;

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** Take the repository's lease, waiting in line (one line per new place or holder) while another holds it. */
/** `runId`: the flow run whose station holds it, whose workspace scopes the lease; without one the repository's team does.
 *  `signal`: stops the wait, leaving the line, and throws. */
export async function holdRepoLease(post: LeasePost, o: { repository: string; holder: string; runId?: string; log: (line: string) => void; signal?: AbortSignal; pollMs?: number; renewMs?: number; staleMs?: number; now?: () => number }): Promise<RepoLease> {
  const now = o.now ?? Date.now;
  const token = randomUUID();
  const ask = (op: "take" | "renew" | "release") => post("/cli/repo-lease", { repository: o.repository, op, token, holder: o.holder, ...(o.runId ? { run_id: o.runId } : {}) });
  const pause = () => new Promise<void>((res) => {
    const t = setTimeout(res, o.pollMs ?? POLL_MS);
    o.signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });
  let told = "";
  for (;;) {
    if (o.signal?.aborted) {
      await ask("release").catch(() => {});
      throw new Error(`stopped waiting for the lease on ${o.repository}`);
    }
    // A post that failed on the way (the network, the gateway) is asked again: going on would deploy beside a holder.
    // A missing route (an older server) or a refusal ends the wait with the error.
    const r = await ask("take").catch((err) => {
      if (!transient(err)) throw err;
      const said = `could not ask for the lease on ${o.repository} (${errorText(err).slice(0, 200)}); asking again`;
      if (said !== told) { told = said; o.log(said); }
      return null;
    });
    if (r === null) { await pause(); continue; }
    if (r?.held) break;
    const place = `${r?.position ? `${ordinal(r.position)} in line ` : ""}behind ${r?.holder || "another holder"}`;
    if (place !== told) {
      told = place;
      const since = Math.max(0, Math.round((now() - Number(r?.since ?? now())) / 60_000));
      o.log(`waiting for the lease on ${o.repository}: ${place} (${since}m)`);
    }
    await pause();
  }
  let lastHeld = now();
  let lost = false;
  const answer = (r: any) => { if (r?.held) lastHeld = now(); else lost = true; return !!r?.held; };
  const renew = setInterval(() => { void ask("renew").then(answer, () => {}); }, o.renewMs ?? RENEW_MS);
  renew.unref?.();
  return {
    assertHeld: async () => {
      if (lost || now() - lastHeld > (o.staleMs ?? STALE_MS)) { lost = true; return false; }
      try { return answer(await ask("renew")); } catch { return false; }
    },
    retake: async (waitMs = 0) => {
      const until = now() + waitMs;
      for (;;) {
        try {
          const r = await ask("take");
          if (r?.held) { lost = false; lastHeld = now(); return true; }
        } catch { /* the server could not be asked: try again within the wait */ }
        if (now() >= until) return false;
        await new Promise((res) => setTimeout(res, o.pollMs ?? POLL_MS));
      }
    },
    release: async () => {
      clearInterval(renew);
      await ask("release").catch(() => {});
    },
  };
}
