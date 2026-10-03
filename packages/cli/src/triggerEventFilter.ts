// The event filter `cast trigger add --on` and `cast trigger update --on` arm,
// built from the flag and its narrowing flags (--repo, --pr, --source). The
// `--on <event>` vocabulary lives in @codecast/shared/contracts so the CLI and
// the web trigger pages cannot drift apart; `cast trigger add -h` generates its
// list from it.
//
// --source is stored as typed here. The server resolves it when the trigger is
// saved (agentTasks storedEventFilter): a source name or src-N becomes the
// source's canonical name, and an unknown one is refused with the known ones
// listed, because a firing matches on the name and a wrong one never fires.
import {
  TRIGGER_EVENT_NAMES,
  TRIGGER_EVENT_SHORTHANDS,
  isIngestTriggerEvent,
  isPrTriggerEvent,
  type TriggerScopeFilter,
} from "@codecast/shared/contracts";

export interface EventFilterFlags {
  repo?: string;
  pr?: string;
  source?: string;
}

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * The event filter a `--on` trigger arms.
 *
 * A pull request event is about one repository, and an unscoped trigger fires
 * for every repository the team has. Nobody standing in a checkout means that,
 * so the checkout's origin fills in --repo when the flag is absent. Pass
 * `--repo ""` to watch every repository on purpose.
 */
export async function buildEventFilter(
  eventName: string,
  opts: EventFilterFlags,
  checkoutRepository: () => Promise<string | undefined> = async () =>
    (await import("./prCommand.js")).readLocalGitContext().repository ?? undefined,
): Promise<TriggerScopeFilter> {
  const shorthand = TRIGGER_EVENT_SHORTHANDS[eventName];
  if (!shorthand) refuse(`Unknown event: ${eventName}. Valid: ${TRIGGER_EVENT_NAMES.join(", ")}`);

  const filter: TriggerScopeFilter = { ...shorthand };

  // A product event comes from one of the workspace's sources; --source
  // narrows it the way --repo narrows a pull request event.
  if (opts.source !== undefined) {
    if (!isIngestTriggerEvent(eventName)) refuse(`--source only narrows an event a source reports, and ${eventName} is not one.`);
    if (opts.source.trim()) filter.source = opts.source.trim();
  }

  if (opts.pr !== undefined) {
    if (!isPrTriggerEvent(eventName)) refuse(`--pr only narrows a pull request event, and ${eventName} is not one.`);
    const number = Number(opts.pr);
    if (!Number.isInteger(number) || number <= 0) refuse(`--pr wants a pull request number, got "${opts.pr}".`);
    filter.pr_number = number;
  }

  const repository = opts.repo !== undefined ? opts.repo : isPrTriggerEvent(eventName) ? await checkoutRepository() : undefined;
  if (repository) filter.repository = repository;

  return filter;
}

/** The narrowing flag passed without --on, if any: it would be dropped. */
export function narrowingWithoutOn(opts: EventFilterFlags & { on?: string }): string | undefined {
  if (opts.on) return undefined;
  return opts.repo !== undefined ? "--repo" : opts.pr !== undefined ? "--pr" : opts.source !== undefined ? "--source" : undefined;
}
