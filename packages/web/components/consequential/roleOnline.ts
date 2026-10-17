// Bringing a role online, as the review's data (ConsequentialSwitch
// SwitchLedger), and any ledger as plain lines for a surface that can only
// show text (the phone's native alert). Its own file with no imports beyond
// types, so the mobile bundle can read it.
import type { SwitchLedger } from "./ConsequentialSwitch";

/** A role's standing session started on its host's machine; with its own switch on, it then starts work unasked. */
export function roleOnlineLedger(r: { handle: string; name: string; host: string; startsOnItsOwn: boolean; sessionsPerDay: number }): SwitchLedger {
  return {
    name: `Bring @${r.handle} online`,
    subject: r.name,
    shift: ["Offline", "Online"],
    figures: [
      { value: "1", label: "session now", tone: "warn" },
      r.startsOnItsOwn ? { value: String(r.sessionsPerDay), label: "a day, unasked", tone: "warn" } : { value: "0", label: "unasked" },
    ],
    rows: [
      { k: "Runs on", v: `${r.host}'s machine` },
      r.startsOnItsOwn ? { k: "Starts work", v: "On its own", tone: "warn" } : { k: "Starts work", v: "When asked", tone: "ok" },
    ],
    stop: "Pause or retire",
    confirm: "Bring online",
    keep: "Keep offline",
  };
}

/** Approving new roles: each starts its standing session on the approver's machine. One role reads as bringing it online. */
export function newRolesLedger(roles: { handle: string; name: string; startsOnItsOwn: boolean; sessionsPerDay: number }[], host: string): SwitchLedger {
  if (roles.length === 1) return { ...roleOnlineLedger({ ...roles[0], host }), confirm: "Accept and bring online", keep: "Not yet" };
  const unasked = roles.filter((r) => r.startsOnItsOwn).reduce((n, r) => n + r.sessionsPerDay, 0);
  return {
    name: `Bring ${roles.length} roles online`,
    subject: roles.map((r) => `@${r.handle}`).join(", "),
    shift: ["Offline", "Online"],
    figures: [
      { value: String(roles.length), label: "sessions now", tone: "warn" },
      unasked ? { value: String(unasked), label: "a day, unasked", tone: "warn" } : { value: "0", label: "unasked" },
    ],
    rows: [{ k: "Runs on", v: `${host}'s machine` }],
    stop: "Pause or retire",
    confirm: "Accept and bring online",
    keep: "Not yet",
  };
}

/** Leeway to hire: the role brings roles under itself online with nobody approving each; every hire is a standing session of its own. */
export function hireLeewayLedger(r: { handle: string; name: string }): SwitchLedger {
  return {
    name: "Hires without approval",
    subject: r.name,
    figures: [
      { value: "0", label: "approvals a hire", tone: "warn" },
      { value: "1", label: "new session a hire", tone: "warn" },
    ],
    rows: [
      { k: "May hire", v: `Roles under @${r.handle}` },
      { k: "Each hire", v: "Default limits" },
      { k: "Undo a hire", v: "Retire it" },
    ],
    stop: "Turn off",
    confirm: "Let it hire",
    keep: "Keep approvals",
  };
}

/** A ledger as short lines: the figures, then each row, then how to stop. */
export function ledgerLines(l: SwitchLedger): string[] {
  return [
    ...l.figures.map((f) => `${f.value} ${f.label}`),
    ...l.rows.map((r) => `${r.k}: ${r.v}`),
    ...(l.stop ? [`To stop: ${l.stop}`] : []),
  ];
}

/** Hiring the Head of People: its standing session starts (or the workspace's
 *  standing agent takes the seat), and its first company review runs at once,
 *  then weekly, each ending in proposals the person decides. */
export function hireHeadLedger(r: { workspace: string; host: string; seats: string | null }): SwitchLedger {
  return {
    name: "Hire the Head of People",
    subject: r.workspace,
    shift: null,
    figures: [
      r.seats ? { value: "0", label: "new sessions" } : { value: "1", label: "session now", tone: "warn" },
      { value: "1", label: "review now", tone: "warn" },
    ],
    rows: [
      r.seats ? { k: "Seat", v: `${r.seats}, kept as it is` } : { k: "Runs on", v: `${r.host}'s machine` },
      { k: "Reviews", v: "Now, then weekly", tone: "warn" },
      { k: "Changes", v: "Only what you approve", tone: "ok" },
    ],
    stop: "Pause or retire",
    confirm: "Hire and start",
    keep: "Not now",
  };
}

/** Hiring an Executive Assistant: its standing session starts on the hirer's machine and checks in daily. */
export function hireAssistantLedger(r: { name: string; reach: string; host: string }): SwitchLedger {
  return {
    name: `Hire ${r.name}`,
    subject: r.reach,
    shift: null,
    figures: [
      { value: "1", label: "session now", tone: "warn" },
      { value: "1", label: "check a day", tone: "warn" },
    ],
    rows: [
      { k: "Runs on", v: `${r.host}'s machine` },
      { k: "Reach", v: r.reach },
    ],
    stop: "Pause or retire",
    confirm: "Hire and start",
    keep: "Not now",
  };
}
