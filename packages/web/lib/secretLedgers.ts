// The Vault's confirm ledgers (components/consequential): what each
// consequential press on a secret shows before it runs.
import type { SecretMeta, SecretVersionMeta } from "@codecast/shared/contracts/secrets";
import type { SwitchFigure, SwitchLedger } from "../components/consequential/ConsequentialSwitch";
import { envVars } from "../components/secrets/vaultModel";
import { formatRelativeTime } from "./conversationFormat";

export type LedgerTeam = { name: string; people: number } | null;

/** Where a ledger's secret lives, the same on every confirm. */
const scopeSubject = (team: { name: string } | null) => (team ? `Team · ${team.name}` : "Only me");

/** Whose agents the press reaches, named by audience (a count here would read as agents), and what it does to them ("lose it", "switch to it"). */
const audienceFigure = (team: LedgerTeam, verb: string): SwitchFigure =>
  team
    ? { value: team.name, label: `${team.people} ${team.people === 1 ? "person's" : "people's"} agents ${verb}`, tone: "warn" }
    : { value: "Only you", label: `your agents ${verb}`, tone: "warn" };

const readsFigure = (row: SecretMeta): SwitchFigure => ({ value: String(row.use_count ?? 0), label: "agent reads so far" });

/** Delete, as the confirm shows it: who loses the secret, and what goes with it. */
export function deleteLedger(row: SecretMeta, team: LedgerTeam): SwitchLedger {
  const injects = envVars(row);
  return {
    name: `Delete ${row.name}`,
    subject: scopeSubject(team),
    shift: null,
    figures: [audienceFigure(team, "lose it"), readsFigure(row)],
    rows: [
      ...(injects.length ? [{ k: "Env vars", v: injects.join(" "), tone: "warn" as const }] : []),
      ...(row.sites?.length ? [{ k: "Sites", v: row.sites.join(", ") }] : []),
      { k: "Activity", v: "Kept, under its name" },
      { k: "To undo", v: "Add it again, with the value", tone: "warn" },
    ],
    confirm: `Delete ${row.name}`,
    keep: "Keep it",
  };
}

/** Turning Ask first off, as the confirm shows it: which agents then read the secret without a person saying yes. */
export function askFirstOffLedger(row: SecretMeta, team: LedgerTeam): SwitchLedger {
  return {
    name: "Turn off Ask first",
    subject: `${row.name} · ${scopeSubject(team)}`,
    shift: ["On", "Off"],
    figures: [audienceFigure(team, "read it unasked"), readsFigure(row)],
    rows: [
      { k: "Approval", v: "None, from the next read", tone: "warn" },
      { k: "Activity", v: "Every read still logged" },
      { k: "To undo", v: "Turn Ask first on" },
    ],
    confirm: "Turn off Ask first",
    keep: "Keep it on",
  };
}

/** Restore, as the confirm shows it: the value coming back, and where the current one goes. */
export function restoreLedger(row: SecretMeta, version: SecretVersionMeta, team: LedgerTeam): SwitchLedger {
  return {
    name: `Restore ${row.name}`,
    subject: scopeSubject(team),
    shift: null,
    figures: [
      { value: formatRelativeTime(version.rotated_at), label: "replaced" },
      ...(version.fingerprint ? [{ value: version.fingerprint, label: "value coming back" }] : []),
    ],
    rows: [
      ...(version.rotated_by_name ? [{ k: "Replaced by", v: version.rotated_by_name }] : []),
      { k: "Agents", v: "Read it from their next use", tone: "warn" as const },
      { k: "Current", v: "Kept 7 days" },
      { k: "To undo", v: "Restore the current value" },
    ],
    confirm: "Restore",
    keep: "Keep current",
  };
}

/** Rotate, as the confirm shows it: who reads the new value, and that the current one stays restorable. */
export function rotateLedger(row: SecretMeta, team: LedgerTeam): SwitchLedger {
  const injects = envVars(row);
  return {
    name: `Replace ${row.name}`,
    subject: scopeSubject(team),
    shift: null,
    figures: [audienceFigure(team, "switch to it"), readsFigure(row)],
    rows: [
      ...(injects.length ? [{ k: "Env vars", v: injects.join(" ") }] : []),
      { k: "From", v: "Each agent's next use", tone: "warn" },
      { k: "Current", v: "Kept 7 days under Previous" },
      { k: "To undo", v: "Restore the current value" },
    ],
    confirm: "Replace",
    keep: "Keep current",
  };
}

/** Declining a request, as the confirm shows it: the session that asked wakes told no value is coming. */
export function declineLedger(row: SecretMeta): SwitchLedger {
  return {
    name: `Decline ${row.name}`,
    subject: `Asked by ${row.requested_by_name ?? "an agent"}`,
    shift: null,
    figures: [],
    rows: [
      ...(row.request_why ? [{ k: "For", v: row.request_why }] : []),
      { k: "Its session", v: "Wakes, told no value is coming", tone: "warn" as const },
      { k: "To undo", v: "The agent asks again" },
    ],
    confirm: "Decline",
    keep: "Keep it open",
  };
}

/** Sharing a sign-in with a team gives every agent there the person's own session, so it is reviewed first, with what the check found. */
export function shareSigninLedger(r: { host: string; team: string; people: number; laptop: string; cookies: number; account_hint?: string }): SwitchLedger {
  return {
    name: `Share your ${r.host} sign-in`,
    subject: `Team · ${r.team}`,
    shift: null,
    figures: [
      { value: String(r.people), label: r.people === 1 ? "person's agents sign in as you" : "people's agents sign in as you", tone: "warn" },
      { value: String(r.cookies), label: r.cookies === 1 ? "cookie" : "cookies" },
    ],
    rows: [
      { k: "Site", v: r.host },
      { k: "Account", v: r.account_hint ? `${r.account_hint}, from Chrome on ${r.laptop}` : `Yours, from Chrome on ${r.laptop}`, tone: "warn" },
      { k: "Stays alive", v: "Agents write newer cookies back" },
      { k: "To undo", v: "Delete it, then sign out on the site", tone: "warn" },
    ],
    confirm: "Share with the team",
    keep: "Cancel",
  };
}

/** Sharing many sign-ins at once (the Vault's Save all): every site the check found, with its count and account, and the ones Chrome is not signed in to, which stay asked for. */
export function shareSigninsLedger(r: { team: string; people: number; laptop: string; found: { host: string; cookies: number; account_hint?: string }[]; signedOut: string[] }): SwitchLedger {
  return {
    name: `Share ${r.found.length} sign-ins`,
    subject: `Team · ${r.team}`,
    shift: null,
    figures: [
      { value: String(r.people), label: r.people === 1 ? "person's agents sign in as you" : "people's agents sign in as you", tone: "warn" },
      { value: String(r.found.length), label: r.found.length === 1 ? "site" : "sites" },
    ],
    rows: [
      ...r.found.map((f) => ({ k: f.host, v: `${f.account_hint ?? "Yours"} · ${f.cookies} ${f.cookies === 1 ? "cookie" : "cookies"}`, tone: "warn" as const })),
      ...(r.signedOut.length ? [{ k: "Not signed in", v: `${r.signedOut.join(", ")}: stay asked for` }] : []),
      { k: "From", v: `Chrome on ${r.laptop}` },
      { k: "Stays alive", v: "Agents write newer cookies back" },
      { k: "To undo", v: "Delete each, then sign out on the site", tone: "warn" },
    ],
    confirm: `Share ${r.found.length} with the team`,
    keep: "Cancel",
  };
}
