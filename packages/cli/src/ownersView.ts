// How `cast own`, `cast disown` and `cast owners` name a session's owners,
// read from sessionOwnership.listOwners: the people, at most one role, the one
// owner who drives, and the account that runs it. Its own module so the
// wording is unit-testable (index.ts runs the CLI on import).

/** A role as an owner ref: `@handle` or its short id (or-N). */
export const isRoleRef = (arg: string) => /^@[\w-]+$/.test(arg.trim()) || /^or-\d+$/.test(arg.trim());

type OwnersRead = {
  owners?: Array<{ user_id: string; name?: string | null; email?: string | null }>;
  role?: { role_id: string; short_id: string; handle: string } | null;
  driver?: { kind: "role"; role_id: string } | { kind: "user"; user_id: string } | null;
  runner?: { name?: string | null; email?: string | null; is_bot?: boolean } | null;
};

const nameOf = (p: { name?: string | null; email?: string | null } | null | undefined) => p?.name || p?.email || "?";

/** Whether `ref` names the role this session is filed under. */
export function namesFiledRole(read: OwnersRead, ref: string): boolean {
  const r = read.role;
  if (!r) return false;
  const want = ref.trim().replace(/^@/, "").toLowerCase();
  return r.handle.toLowerCase() === want || r.short_id === ref.trim() || r.role_id === ref.trim();
}

/** The owners as words: people (the driver marked), the role (driving or
 *  paused), and who runs it. */
export function describeOwners(read: OwnersRead): { people: string; role: string | null; runner: string | null } {
  const driver = read.driver ?? null;
  const people = (read.owners ?? []).map((o) => `${nameOf(o)}${driver?.kind === "user" && driver.user_id === o.user_id ? " (drives)" : ""}`);
  const driverName = driver?.kind === "user" ? nameOf((read.owners ?? []).find((o) => o.user_id === driver.user_id)) : null;
  const role = read.role
    ? `@${read.role.handle} ${driver?.kind === "role" ? "(drives)" : `(paused${driverName ? `: ${driverName} drives` : ""})`}`
    : null;
  const runner = read.runner ? `${nameOf(read.runner)}${read.runner.is_bot ? " (agent account)" : ""}` : null;
  return { people: people.length ? people.join(", ") : "nobody", role, runner };
}

/** One line for `own`/`disown` to confirm with: the people, then the role. */
export function ownersLine(read: OwnersRead): string {
  const d = describeOwners(read);
  return d.role ? `${d.people} · ${d.role}` : d.people;
}
