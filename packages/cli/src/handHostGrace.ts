// Whether a message to a session with no running process should wait for the
// terminal that last ran it instead of resuming it in codecast's tmux.
//
// A session the person runs in their own terminal (herdr, Ghostty) dies with a
// reboot like any other. Its host terminal brings it back on its own once the
// person logs in (herdr reattaches its panes and runs `claude --resume` in each),
// but the daemon starts first, and a message already queued for the session
// (a trigger, a worker's report) used to find no process and resume it in tmux.
// The host then reattached its copy too: two claudes on one transcript
// (2026-11-03, minutes apart).
//
// The witness is the session's own SessionStart claim
// (~/.codecast/session-registry/<id>.json, sessionRegisterHook.ts): its `term`
// is the TERM_PROGRAM the session ran under, and an EMPTY `launch_token` says
// codecast did not launch it. A claim written before the boot names a process
// the boot ended. For a short grace after boot such a session's messages stay
// pending; after it, the resume goes ahead as before, so a host that never
// comes back costs a few minutes, not the message.

/** How long after boot a hand-hosted session's message waits for its host. */
export const HAND_HOST_BOOT_GRACE_MS = 10 * 60_000;

/** Terminals the daemon itself runs sessions in, or that name no host. */
const NOT_A_HOST = new Set(["", "unknown", "tmux", "screen"]);

export type HandHostVerdict =
  | { wait: false }
  | { wait: true; term: string; remainingMs: number };

export function waitForHandHost(args: {
  claim: unknown;
  bootAtMs: number;
  nowMs: number;
  graceMs?: number;
}): HandHostVerdict {
  const grace = args.graceMs ?? HAND_HOST_BOOT_GRACE_MS;
  const claim = args.claim;
  if (!claim || typeof claim !== "object") return { wait: false };
  const { term, ts, launch_token } = claim as { term?: unknown; ts?: unknown; launch_token?: unknown };
  // Only a claim from the token-aware hook can say codecast did not launch it.
  if (launch_token !== "") return { wait: false };
  if (typeof term !== "string" || NOT_A_HOST.has(term)) return { wait: false };
  if (typeof ts !== "number" || !Number.isFinite(ts)) return { wait: false };
  // Written since the boot: that process died on its own, not with the boot,
  // and nothing is coming back for it.
  if (ts * 1000 >= args.bootAtMs) return { wait: false };
  const remainingMs = args.bootAtMs + grace - args.nowMs;
  if (remainingMs <= 0) return { wait: false };
  return { wait: true, term, remainingMs };
}
