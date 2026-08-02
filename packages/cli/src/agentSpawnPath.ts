/**
 * The PATH agent binaries are spawned with.
 *
 * The daemon usually runs under launchd, which hands it a bare
 * `/usr/bin:/bin:/usr/sbin:/sbin` — none of the places a user actually installs
 * a CLI. So every agent spawn has to re-add them itself; `process.env.PATH` is
 * only rich enough when the daemon happened to be started from a terminal,
 * which is why a missing entry here presents as "works until the next
 * automatic restart".
 *
 * `~/.local/bin` is where codex (and codecast itself) install, and its absence
 * from the three hand-maintained copies of this list is what made a machine
 * with codex installed report "Codex is not installed". One list now, so the
 * next agent can't be onboarded with a subtly different one.
 */
export function agentSpawnPath(...prefixes: Array<string | undefined>): string {
  const home = process.env.HOME;
  return [
    ...prefixes,
    home && `${home}/.local/bin`,
    home && `${home}/bin`,
    home && `${home}/.bun/bin`,
    process.env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(":");
}
