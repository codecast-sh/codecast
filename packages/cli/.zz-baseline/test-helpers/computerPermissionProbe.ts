/**
 * Read the helper's own TCC grants from a test or a script (A7, ct-49523).
 *
 * This used to be a second implementation of the probe, because the production
 * one could not be used from here: `resolveCastInvocation()` handed a test or a
 * script a `main.ts` that did not exist and the detached spawn hid the ENOENT
 * (ct-49674), and the poll gave up after 5 seconds while the helper needed
 * longer than that to answer (ct-49671). Both are fixed in the production path,
 * so this is now an adapter: `getPermissionStatus` does the launching, the
 * polling and the reading, and the only thing left here is the shape the
 * verification procedures want and a route they can name.
 *
 * Naming the route is the point of `confirm-route` (design 3.4): the disclaimed
 * spawn must report the HELPER's permission state rather than one inherited
 * from its parent, and the comparison only proves something if both routes run
 * the code that ships.
 *
 * It answers three ways, not two — the same rule `hasBinary` follows for the
 * tmux suites (binaryProbe.ts, ct-49770). This adapter used to swallow every
 * failure into `no-answer`, and the granted suite turned that into a skip. On a
 * loaded full-directory run the poll timed out, the suite skipped itself, and
 * `0 pass 12 skip 0 fail` read as a pass on a machine that was granted
 * (ct-49883). So:
 *
 *   - granted / not-granted / unsupported -> returned; the caller decides
 *   - could not ask (the probe threw, or the helper was not there to answer)
 *     -> retried, then THROWN with every failure's reason
 *
 * A throw at gate time turns the suite red, which is the point: the only thing
 * that may skip a granted suite is a definite answer that the grant is missing.
 */

import { getPermissionStatus, type PermissionProbeRoute } from "../computer/permissions.js";
import { resolveCastInvocation } from "../castInvocation.js";
import type { ComputerPermissionId, ComputerPermissionStatus, ComputerPermissionStatusResult } from "../computer/types.js";

export type ProbeRoute = PermissionProbeRoute;
export type ProbeResult = Record<ComputerPermissionId, ComputerPermissionStatus>;

export interface PermissionProbeOptions {
  /** The probe itself. Injected by the tests to fake a wedged helper. */
  status?: (route: ProbeRoute) => Promise<ComputerPermissionStatusResult>;
  /**
   * Total attempts before giving up. Two by default, not four: one attempt
   * already carries a 30-second poll ceiling, so the retry is here to ride out
   * a momentary spike on a loaded box, not to wait out a genuinely wedged
   * helper — that one has to become a failure while somebody is still reading.
   */
  attempts?: number;
  /** Base backoff between attempts; grows linearly. */
  delayMs?: number;
  /** Sleep between attempts. Injected by the tests to keep them instant. */
  sleep?: (ms: number) => Promise<void>;
}

/** How to invoke this CLI as a child, for code whose argv[1] is not the CLI. */
export function castLaunch(args: string[]): { cmd: string; args: string[] } {
  const cast = resolveCastInvocation();
  return { cmd: cast.cmd, args: [...cast.prefixArgs, ...args] };
}

/** The disclaimed spawn, the way `defaultHelperLaunch` builds it. */
export function disclaimedHelperLaunch(exe: string, helperArgs: string[]): { cmd: string; args: string[] } {
  return castLaunch(["_disclaimed", "--", exe, ...helperArgs]);
}

/**
 * One attempt: the two grants, or the reason this attempt could not ask.
 *
 * `helperUnavailableReason` is a could-not-ask even though the result carries
 * `not-granted` for both ids. Nothing was asked — the helper was missing from
 * the fixed path — and a suite that read that as "not granted" would skip for
 * a reason that sends whoever reads it to System Settings.
 */
async function attemptProbe(
  route: ProbeRoute,
  status: (route: ProbeRoute) => Promise<ComputerPermissionStatusResult>,
): Promise<{ result: ProbeResult } | { couldNotAsk: string }> {
  let answer: ComputerPermissionStatusResult;
  try {
    answer = await status(route);
  } catch (e) {
    return { couldNotAsk: e instanceof Error ? e.message : String(e) };
  }
  if (answer.helperUnavailableReason) return { couldNotAsk: answer.helperUnavailableReason };
  const of = (id: ComputerPermissionId): ComputerPermissionStatus =>
    answer.permissions.find((p) => p.id === id)?.status ?? "not-granted";
  return { result: { accessibility: of("accessibility"), screenshots: of("screenshots") } };
}

export async function probeHelperPermissions(
  route: ProbeRoute = "disclaimed",
  opts: PermissionProbeOptions = {},
): Promise<ProbeResult> {
  const status = opts.status ?? ((r: ProbeRoute) => getPermissionStatus({ route: r }));
  const attempts = opts.attempts ?? 2;
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));

  const failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = await attemptProbe(route, status);
    if ("result" in outcome) return outcome.result;
    failures.push(`attempt ${attempt}: ${outcome.couldNotAsk}`);
    if (attempt < attempts) await sleep(delayMs * attempt);
  }

  throw new Error(
    `cannot tell what \`codecast computer\` is granted over the ${route} route: ` +
    `every probe failed to answer (${failures.join("; ")}). Failing instead of ` +
    `skipping — a suite that skips here reports 0 pass 0 fail and reads as ` +
    `green on a machine that is granted (ct-49883).`,
  );
}
