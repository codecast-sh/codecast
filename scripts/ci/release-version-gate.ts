// Refuses a release whose version is not ahead of what is already published.
// Both laptop release paths bump from the version in a local package.json, so a
// checkout behind main computes a version that is already live and overwrites a
// newer release with older bytes. Reading the published manifest first turns
// that into a refusal (ct-49566).
//
// Lives under scripts/ci because that is the directory CI runs `bun test` over;
// the release scripts call it by path.
import { compareVersions } from "../../platform/packages/cli-kit/src/update/version.ts";

const SEMVER = /^\d+\.\d+\.\d+$/;

export type GateVerdict = { ok: true; note: string } | { ok: false; reason: string };

/**
 * Pure: may `next` replace `published`? `allowEqual` covers the recovery reruns
 * (`deploy.sh --no-bump`) that republish the same version on purpose.
 */
export function checkVersionAhead(input: {
  channel: string;
  published: string;
  next: string;
  allowEqual?: boolean;
}): GateVerdict {
  const { channel, published, next, allowEqual = false } = input;
  // compareVersions reads an unparseable segment as 0, so "1.x.0" would compare
  // equal to "1.0.0" and slip through. Demand the shape the bumpers produce.
  for (const [label, value] of [
    ["published", published],
    ["next", next],
  ] as const) {
    if (!SEMVER.test(value)) {
      return { ok: false, reason: `${channel}: unreadable ${label} version ${JSON.stringify(value)}` };
    }
  }
  const order = compareVersions(next, published);
  if (order > 0) return { ok: true, note: `${channel} ${next} is ahead of the published ${published}` };
  if (order === 0 && allowEqual) {
    return { ok: true, note: `${channel} ${next} republishes the published version` };
  }
  const verb = order === 0 ? "is already published" : `is behind the published ${published}`;
  return {
    ok: false,
    reason:
      `${channel} ${next} ${verb}. Releasing it would replace newer bytes with older ones. ` +
      `Pull main so the version in package.json matches what is live, then bump again.`,
  };
}

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const channel = argValue(argv, "--channel");
  const published = argValue(argv, "--published");
  const next = argValue(argv, "--next");
  if (!channel || !published || !next) {
    console.error(
      "Usage: bun scripts/ci/release-version-gate.ts --channel <name> --published <x.y.z> --next <x.y.z> [--allow-equal]",
    );
    process.exit(2);
  }
  const verdict = checkVersionAhead({
    channel,
    published,
    next,
    allowEqual: argv.includes("--allow-equal"),
  });
  if (!verdict.ok) {
    console.error(`ABORT: ${verdict.reason}`);
    process.exit(1);
  }
  console.log(verdict.note);
}
