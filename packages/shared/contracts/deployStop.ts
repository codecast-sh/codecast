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

/** The target a stuck Deploy stop names as not live ("cli is not live with acbd8d2"), or null. */
export function stuckTargetOf(reason: string | null | undefined): string | null {
  return reason?.match(/\b([a-z][a-z0-9-]{0,31}) is not live\b/)?.[1] ?? null;
}
