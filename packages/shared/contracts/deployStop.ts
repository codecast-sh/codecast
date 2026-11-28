// What a change run's Deploy stop says of its targets, in the words the Go live station writes (cli
// workflow/awaitDeploy.ts): "The deploy that carried 929c5d8 failed: desktop dp-3559 (Stopped at Send.), web dp-12."
// (or "No deploy took 929c5d8 out: …" when none of them sent anything), and "Deploy stuck: cli is not live with
// acbd8d2 after 60m …". The run page and `cast workflow show` both read a landed run's way on from here: the target's
// next deploy takes the change live.

/** The deploys a Deploy stop names as failed, by target, each once, in the order the stop names them; `unsent` when
 *  the stop says that deploy stopped before sending anything. */
export function failedDeploysOf(reason: string | null | undefined): Array<{ target: string; deploy: string; unsent: boolean }> {
  const list = reason?.match(/(?:deploy that carried|No deploy took) \S+ (?:failed|out):\s*([\s\S]*)$/)?.[1].replace(/\([^)]*\)/g, "") ?? "";
  const out = new Map<string, { deploy: string; unsent: boolean }>();
  for (const m of list.matchAll(/\b([a-z][a-z0-9-]{0,31}) (dp-\d+)\b( stopped at \S+ before sending anything)?/g)) if (!out.has(m[1])) out.set(m[1], { deploy: m[2], unsent: !!m[3] });
  return [...out].map(([target, f]) => ({ target, ...f }));
}

/** The targets a stuck Deploy stop names as not live ("cli is not live with acbd8d2 …; web is not live with …"), each once. */
export function stuckTargetsOf(reason: string | null | undefined): string[] {
  return [...new Set([...(reason ?? "").matchAll(/\b([a-z][a-z0-9-]{0,31}) is not live\b/g)].map((m) => m[1]))];
}

type StoppedRun = {
  status?: string;
  current_node_id?: string | null;
  merge?: { sha?: string | null } | null;
  fail_reason?: string | null;
  node_statuses?: ReadonlyArray<{ node_id: string; status?: string; result_preview?: string | null }> | null;
};

/**
 * The Deploy segment a run stopped in (`deploy`, `direct_deploy`): its change merged, its wait failed, and the run
 * ended at the segment's Deploy failed or Deploy stuck. A run that reached that exit before the stored node copy kept
 * an exit's stop (cli graphPayload.ts) ended completed there, its runner having read that copy: it stopped all the same.
 * Null for a run that stopped anywhere else.
 */
export function deployStopOf(run: StoppedRun): string | null {
  if ((run.status !== "failed" && run.status !== "completed") || !run.merge?.sha) return null;
  const m = /^(.+)__(failed|stuck)$/.exec(run.current_node_id ?? "");
  if (!m) return null;
  return (run.node_statuses ?? []).some((n) => n.node_id === `${m[1]}__wait` && n.status === "failed") ? m[1] : null;
}

/** A Deploy stop's words: the run's reason, else (a run that lost its stop and has none) what its Go live wait said. */
export function deployStopWords(run: StoppedRun): string | null {
  const stop = deployStopOf(run);
  if (!stop) return null;
  return run.fail_reason || [...(run.node_statuses ?? [])].reverse().find((n) => n.node_id === `${stop}__wait`)?.result_preview || null;
}

/**
 * The targets a Deploy stop says this run could not send because another person's machine sends them, each with who
 * sends it (awaitDeploy.ts: "This run could not send mobile: mobile is sent only from Jason Benn's machine (jb-m5-max),
 * not from this machine. …"). Nothing failed: the change is on main and goes out with that machine's next send. Empty
 * unless the stop names only such targets.
 */
export function awaySendsOf(reason: string | null | undefined): Array<{ target: string; sender: string }> {
  if (!/^(?:Stopped:\s*)?This run could not send /.test(reason ?? "")) return [];
  return [...reason!.matchAll(/\b([a-z][a-z0-9-]{0,31}) is sent only from (.+?), not from this machine/g)].map((m) => ({ target: m[1], sender: m[2] }));
}
