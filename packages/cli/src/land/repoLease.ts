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

/** How long the Merge station waits in line before it hands the graph exit 4, apart from the work after it. */
export const LEASE_LINE_MS = 40 * 60_000;

/** The wait ran past its `waitMs` while still in line. With `keepPlace` the place is not given up: a taker that asks
 *  again with `token` within the server's waiter grace (a minute) keeps it; without, the taker has left the line. */
export class LeaseLineWait extends Error {
  constructor(readonly token: string, readonly place: string, waitedMs: number) {
    super(`still waiting for the lease after ${Math.round(waitedMs / 60_000)}m: ${place}`);
  }
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const placeOf = (r: any) => `${r?.position ? `${ordinal(r.position)} in line ` : ""}behind ${r?.holder || "another holder"}`;

/** Take the repository's lease, waiting in line (one line per new place or holder) while another holds it. */
/** `runId`: the flow run whose station holds it, whose workspace scopes the lease; without one `teamId` names the team,
 *  else the repository's team does.
 *  `signal`: stops the wait, leaving the line, and throws.
 *  `waitMs`: how long to wait in line before throwing LeaseLineWait, leaving the line, or with `keepPlace` keeping
 *  the place for a retake with its `token` (the Merge station runs again; `cast repo lease --wait` exits).
 *  `onLost`: told once each time the lease, once held, is found lost (another holds it, or no renewal for half the lease). */
export async function holdRepoLease(post: LeasePost, o: { repository: string; holder: string; runId?: string; teamId?: string; token?: string; keepPlace?: boolean; log: (line: string) => void; onLost?: () => void; signal?: AbortSignal; waitMs?: number; pollMs?: number; renewMs?: number; staleMs?: number; now?: () => number }): Promise<RepoLease> {
  const now = o.now ?? Date.now;
  const token = o.token || randomUUID();
  const started = now();
  const waitedOut = (place: string) => o.waitMs !== undefined && now() - started >= o.waitMs ? new LeaseLineWait(token, place, now() - started) : null;
  const ask = (op: "take" | "renew" | "release") => post("/cli/repo-lease", { repository: o.repository, op, token, holder: o.holder, ...(o.runId ? { run_id: o.runId } : {}), ...(o.teamId ? { team_id: o.teamId } : {}) });
  const pause = () => new Promise<void>((res) => {
    // A signal that came during the take before this pause: an aborted signal fires no more abort events.
    if (o.signal?.aborted) return res();
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
    const out = r === null ? waitedOut(told) : r?.held ? null : waitedOut(placeOf(r));
    if (out) {
      if (!o.keepPlace) await ask("release").catch(() => {});
      throw out;
    }
    if (r === null) { await pause(); continue; }
    if (r?.held) break;
    const place = placeOf(r);
    if (place !== told) {
      told = place;
      const since = Math.max(0, Math.round((now() - Number(r?.since ?? now())) / 60_000));
      o.log(`waiting for the lease on ${o.repository}: ${place} (${since}m)`);
    }
    await pause();
  }
  let lastHeld = now();
  let lost = false;
  const staleMs = o.staleMs ?? STALE_MS;
  const markLost = () => { if (!lost) { lost = true; o.onLost?.(); } };
  const answer = (r: any) => { if (r?.held) lastHeld = now(); else markLost(); return !!r?.held; };
  const renew = setInterval(() => { void ask("renew").then(answer, () => { if (now() - lastHeld > staleMs) markLost(); }); }, o.renewMs ?? RENEW_MS);
  renew.unref?.();
  let released: Promise<void> | null = null;
  return {
    assertHeld: async () => {
      if (lost || now() - lastHeld > staleMs) { markLost(); return false; }
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
    // One release however many ask for it: the station's own end and a signal that stops it.
    release: () => (released ??= (clearInterval(renew), ask("release").then(() => {}, () => {}))),
  };
}
