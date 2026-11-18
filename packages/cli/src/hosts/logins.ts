/**
 * `cast hosts logins <id>`: which of this laptop's logins travel to a host.
 * The setting lives on the host's registry entry (CloudHost.logins), rides
 * onto the RemoteHost every push path dials (toRemoteHost), and
 * collectAgentAuthBundle leaves out what it turns off.
 */
import type { Command } from "commander";
import { fmt, icons } from "../colors.js";
import { patchHost, resolveCloudHost } from "../browser/cloudHost.js";
import { describeHostLogins, HOST_LOGIN_NAMES, hostLoginSetting } from "../remote/agentAuth.js";

export function registerHostLoginsCommand(hosts: Command): void {
  hosts
    .command("logins <id>")
    .description("Choose which of this laptop's logins travel to a host; with no option, show the setting (the Claude login always travels)")
    .option("--off <names>", "Every login but these (comma list)")
    .option("--only <names>", "Only these logins (comma list)")
    .option("--on <names>", "Turn these back on, keeping the rest of the setting")
    .option("--all", "Every login")
    .addHelpText("after", `\nLogins: ${HOST_LOGIN_NAMES.join(", ")}\nA host added from now on starts with aws, kube, pgpass, netrc and git-credentials off.`)
    .action((id: string, o: { off?: string; only?: string; on?: string; all?: boolean }) => {
      try {
        const h = resolveCloudHost(id);
        const next = hostLoginSetting(h.logins, o);
        if (next === h.logins) { console.log(`logins to ${h.id}: ${describeHostLogins(h.logins)}`); return; }
        patchHost(h.id, { logins: next });
        console.log(`${fmt.success(icons.check)} logins to ${h.id}: ${describeHostLogins(next)} (the daemon pushes the new set within a minute while the host is awake)`);
      } catch (err) {
        console.error(`${fmt.error(icons.cross)} ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
