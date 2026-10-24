/**
 * Team machines (docs/architecture/team-machines.md), the facts the server,
 * the daemon and the web share: member states, the join steps, the box's
 * marker format, and how a member's Linux user is named. Pure data.
 */

export const TEAM_HOST_MEMBER_STATUSES = ["joining", "ready", "failed", "removing"] as const;
export type TeamHostMemberStatus = (typeof TEAM_HOST_MEMBER_STATUSES)[number];

/**
 * The steps of a join, in order, as the admin daemon reports them. The last
 * one ends when the member's own daemon beats from the box.
 */
export const TEAM_HOST_JOIN_STEPS = ["queued", "user", "tools", "login", "daemon"] as const;
export type TeamHostJoinStep = (typeof TEAM_HOST_JOIN_STEPS)[number];

export const TEAM_HOST_JOIN_STEP_LABELS: Record<TeamHostJoinStep, string> = {
  queued: "Waiting for the machine",
  user: "Creating your user",
  tools: "Installing your tools",
  login: "Signing you in",
  daemon: "Starting your daemon",
};

/** A join the admin daemon has not finished in this long has stalled (a dead daemon, a hung install). */
export const TEAM_HOST_JOIN_STALE_MS = 30 * 60_000;

/** Whether `name` is safe as a Linux login and a systemd instance name. */
export function isLinuxUserName(name: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(name);
}

/** Names a member never gets: system accounts and the images' default logins. */
const RESERVED_LINUX_USERS = new Set([
  "root", "daemon", "bin", "sys", "sync", "games", "man", "lp", "mail", "news", "uucp", "proxy",
  "www-data", "backup", "list", "irc", "gnats", "nobody", "syslog", "sshd", "messagebus", "uuidd",
  "tcpdump", "landscape", "pollinate", "fwupd-refresh", "polkitd", "dnsmasq", "usbmux", "ubuntu",
  "ec2-user", "admin", "codecast", "tss", "lxd", "dhcpcd", "chrony", "ssm-user",
]);

/** A Linux login made from free text: lowercase, letters and digits, starting with a letter. */
function slugLinuxUser(raw: string | undefined | null): string | null {
  const slug = (raw ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "").replace(/^[^a-z]+/, "").slice(0, 24);
  return slug && isLinuxUserName(slug) ? slug : null;
}

/**
 * The Linux user a person gets on a machine: the one they asked for when it
 * is valid and free, else their GitHub login, else the name part of their
 * email, else "member", with a number appended until it is free. `taken`
 * holds every Linux user already claimed on the machine.
 */
export function pickLinuxUser(
  person: { requested?: string | null; github?: string | null; email?: string | null; name?: string | null },
  taken: Iterable<string>,
): string {
  const used = new Set(taken);
  const free = (n: string) => !used.has(n) && !RESERVED_LINUX_USERS.has(n);
  const requested = person.requested?.trim();
  if (requested && isLinuxUserName(requested) && free(requested)) return requested;
  const base = slugLinuxUser(person.github) ?? slugLinuxUser(person.email?.split("@")[0]) ?? slugLinuxUser(person.name?.split(/\s+/)[0]) ?? "member";
  if (free(base)) return base;
  for (let i = 2; ; i++) if (free(`${base}${i}`)) return `${base}${i}`;
}

/**
 * The box's marker (/etc/codecast/shared-host): `key=value` lines. An empty
 * marker is a shared host no team has registered; `key` makes it a team
 * machine, `admin` names the Linux user that is its only sudoer.
 */
export type TeamHostMarker = { key?: string; admin?: string; team?: string };

export function parseTeamHostMarker(text: string): TeamHostMarker {
  const out: TeamHostMarker = {};
  for (const line of text.split("\n")) {
    const m = /^(key|admin|team)=([A-Za-z0-9_.-]{1,128})$/.exec(line.trim());
    if (m) out[m[1] as keyof TeamHostMarker] = m[2];
  }
  return out;
}

export function formatTeamHostMarker(m: Required<TeamHostMarker>): string {
  return `key=${m.key}\nadmin=${m.admin}\nteam=${m.team}\n`;
}
