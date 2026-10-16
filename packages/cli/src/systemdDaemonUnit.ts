/**
 * The system unit that supervises THIS user's daemon on Linux, when one does.
 * A provisioned host runs `codecast-daemon.service` (User=ubuntu); a shared box
 * may add a template (`codecast-daemon-user@.service`, User=%i) so each person
 * gets `codecast-daemon-user@<name>`. Starting, stopping and autostart go
 * through that unit: a daemon started beside it makes the unit's own copy exit
 * "already running" and the unit crash-loops, and another user's unit is never
 * ours to stop.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function daemonUnitFor(units: { name: string; content: string }[], user: string): string | null {
  let template: string | null = null;
  for (const { name, content } of units) {
    if (!name.endsWith(".service")) continue;
    const lines = content.split("\n").map((l) => l.trim());
    if (!lines.some((l) => l.startsWith("ExecStart=") && /\s_daemon(\s|$)/.test(l))) continue;
    const owner = lines.find((l) => l.startsWith("User="))?.slice("User=".length).trim();
    if (owner === user) return name;
    if ((owner === "%i" || owner === "%I") && name.endsWith("@.service") && user !== "root") template ??= `${name.slice(0, -"@.service".length)}@${user}.service`;
  }
  return template;
}

export function findSystemDaemonUnit(user = os.userInfo().username, dir = "/etc/systemd/system"): string | null {
  if (process.platform !== "linux") return null;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const units = names.filter((n) => n.endsWith(".service")).flatMap((name) => {
    try { return [{ name, content: fs.readFileSync(path.join(dir, name), "utf-8") }]; } catch { return []; }
  });
  return daemonUnitFor(units, user);
}

/** `name@instance.service`: one person's copy of a shared box's template unit. */
export function isTemplateInstance(unit: string): boolean {
  return /@[^@/]+\.service$/.test(unit);
}

/** CODECAST_NO_AUTOSTART=1: something else (a system unit, a container entrypoint) runs the daemon. */
export function autostartDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODECAST_NO_AUTOSTART === "1" || env.CODECAST_NO_AUTOSTART === "true";
}

/** This process runs under a systemd service (INVOCATION_ID is set for every
 *  service process) and this user has a daemon unit: the unit restarts the
 *  daemon itself, so a restart is an exit, never a spawned replacement. */
export function supervisedBySystemdUnit(env: NodeJS.ProcessEnv = process.env, unit: () => string | null = findSystemDaemonUnit): boolean {
  return !!env.INVOCATION_ID && unit() !== null;
}
