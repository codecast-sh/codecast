// The blocked banner's model: which machines the parked sessions run on, and
// what each group of them can do now. Accounts belong to machines. A laptop
// holds its own logins, a line host holds only the pool copies opened to it, and
// a personal account can be narrowed off some machines on purpose. So "is there
// an account with room?" has one answer per machine, never one for the fleet.
// The banner draws one lane per group of machines that share an inventory, and
// each lane says what will happen there: continue, switch, or wait for a reset
// (with the account that would end the wait, when one is kept off them).
import { fleetAccount, isFleetProfile, isUsageExhausted, type CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { lineHostsRefuse } from "@codecast/convex/convex/ccSwitchAhead";
import { exhaustedLabel, fallbackProfiles, peggedWindow, rankByHeadroom } from "@codecast/shared/contracts";

export type LaneProfile = {
  name: string;
  email?: string;
  usage?: CcUsage;
  reserved_for?: string | null;
  access_refused_at?: number | null;
  login_expired_at?: number | null;
  setup_token?: { expires_at: number };
};

/** One machine as `accountSwitch.listAccountProfiles` reports it. */
export type LaneDevice = {
  device_id: string;
  label: string;
  is_remote: boolean;
  line_host?: boolean;
  online: boolean;
  active_email?: string;
  launch_profile?: string;
  fleet_store?: boolean;
  profiles: LaneProfile[];
};

/** One row of the account pool (`accountPool.listPool`). */
export type LanePoolRow = { mine: boolean; team_id: string | null; email: string; device_ids?: string[] | null; usage?: CcUsage | null };

export type LaneAccount = { key: string; name: string; email?: string; usage?: CcUsage; missingOn: string[] };

/** One of your accounts with room that the pool keeps off a lane's machines. */
export type KeptOffAccount = { email: string; usage?: CcUsage; deviceIds: string[] };

export type LaneSession = { _id: string; pending_api_error_kind?: string | null; model?: string | null };

export type BlockedLane = {
  key: string;
  /** The machines, as a person names them: "MacBook", "5 line hosts". */
  label: string;
  devices: LaneDevice[];
  sessionIds: string[];
  /** The accounts these machines run now. */
  fleetEmails: string[];
  fleetUsage?: CcUsage;
  /** How many accounts these machines can run at all. */
  heldAccounts: number;
  /**
   * continue: a continue can work on the account they run now.
   * switch: that account is spent and another one here has room.
   * wait: every account these machines can use is spent.
   * offline: no machine can act on them until their owner is back.
   */
  state: "continue" | "switch" | "wait" | "offline";
  /** Accounts to move to, ranked by room; `missingOn` names lane machines without it. */
  accounts: LaneAccount[];
  /** Saved accounts that cannot take the sessions, with why. */
  unavailable: Array<[email: string, why: string]>;
  /** When the first account these machines can use reopens, and which. */
  resumesAt?: number;
  resumesOn?: string;
  /** Accounts with room that the pool keeps off these machines, freshest first. */
  keptOff: KeptOffAccount[];
  /** Accounts opened to these machines whose copy has not reached all of them yet. */
  arriving: string[];
};

const emailKey = (e?: string | null) => (e ?? "").trim().toLowerCase();

const reachable = (p: LaneProfile, now: number) =>
  !p.access_refused_at && !p.reserved_for && (!p.login_expired_at || (!!p.setup_token && p.setup_token.expires_at > now));

/** A profile a machine may run: reachable, and not one a line host refuses. */
const usableOn = (d: LaneDevice, p: LaneProfile, now: number) => reachable(p, now) && !(d.line_host && lineHostsRefuse(p.email));

function laneLabel(devices: LaneDevice[]): string {
  if (devices.length === 0) return "Offline machine";
  if (devices.every((d) => d.line_host)) return devices.length === 1 ? devices[0].label : `${devices.length} line hosts`;
  if (devices.length === 1) return devices[0].label;
  if (devices.length === 2) return `${devices[0].label} + ${devices[1].label}`;
  return `${devices[0].label} + ${devices.length - 1} more`;
}

/** Machines that hold the same accounts and run the same one decide the same way. */
function inventoryKey(d: LaneDevice, now: number): string {
  const emails = [...new Set(d.profiles.map((p) => emailKey(p.email)).filter(Boolean))].sort();
  return `${d.line_host ? "line" : d.is_remote ? "remote" : "local"}|${emailKey(fleetAccount(d, now).email)}|${emails.join(",")}`;
}

export function blockedLanes(input: {
  sessions: readonly LaneSession[];
  executorFor: (session: LaneSession) => LaneDevice | undefined;
  pool: readonly LanePoolRow[];
  now: number;
}): BlockedLane[] {
  const { now } = input;
  type Group = { devices: Map<string, LaneDevice>; sessions: LaneSession[] };
  const groups = new Map<string, Group>();
  for (const sess of input.sessions) {
    const d = input.executorFor(sess);
    const key = d ? inventoryKey(d, now) : "offline";
    const g: Group = groups.get(key) ?? { devices: new Map(), sessions: [] };
    if (d) g.devices.set(d.device_id, d);
    g.sessions.push(sess);
    groups.set(key, g);
  }

  const lanes: BlockedLane[] = [];
  for (const [key, g] of groups) {
    const devices = [...g.devices.values()];
    const models = [...new Set(g.sessions.map((s) => s.model).filter((m): m is string => !!m))];
    const fleetEmailOf = (d: LaneDevice) => fleetAccount(d, now).email;
    const fleetUsageOf = (d: LaneDevice) => d.profiles.find((p) => isFleetProfile(p, d, now))?.usage;
    const fleetEmails = [...new Set(devices.map(fleetEmailOf).filter((e): e is string => !!e))];
    const fleetUsage = devices.map(fleetUsageOf).find((u) => !!u);

    // Switch targets: what auto-switch itself would rank on each machine.
    const options: LaneAccount[] = [];
    for (const d of devices) {
      const candidates = fallbackProfiles(d.profiles.filter((p) => usableOn(d, p, now)), fleetEmailOf(d), now, models);
      for (const p of candidates) {
        const k = p.email ? `email:${p.email}` : `name:${p.name}`;
        const existing = options.find((o) => o.key === k);
        if (!existing) options.push({ key: k, name: p.name, email: p.email, usage: p.usage, missingOn: [] });
        else if (!existing.usage && p.usage) existing.usage = p.usage;
      }
    }
    for (const o of options) {
      o.missingOn = devices.filter((d) => !d.profiles.some((p) => (o.email ? p.email === o.email : p.name === o.name))).map((d) => d.label);
    }
    const accounts = rankByHeadroom(options, now);
    const offered = new Set(accounts.map((a) => a.email).filter(Boolean));

    const unavailable = new Map<string, string>();
    for (const d of devices) {
      for (const p of d.profiles) {
        if (!p.email || p.email === fleetEmailOf(d) || offered.has(p.email) || unavailable.has(p.email)) continue;
        const why = d.line_host && lineHostsRefuse(p.email)
          ? "refused on line hosts"
          : p.reserved_for
            ? `reserved for ${p.reserved_for}`
            : p.access_refused_at
              ? "access refused"
              : !reachable(p, now)
                ? "signed out"
                : isUsageExhausted(p.usage, now, models)
                  ? exhaustedLabel(p.usage, now)
                  : null;
        if (why) unavailable.set(p.email, why);
      }
    }

    const limitOnly = g.sessions.every((s) => !s.pending_api_error_kind || s.pending_api_error_kind === "limit");
    const fleetSpent = devices.length > 0 && devices.every((d) => isUsageExhausted(fleetUsageOf(d), now, models));
    const state: BlockedLane["state"] =
      devices.length === 0 ? "offline" : !limitOnly || !fleetSpent ? "continue" : accounts.length > 0 ? "switch" : "wait";

    // The wait ends at the first reset of any account these machines can run.
    let resumesAt: number | undefined;
    let resumesOn: string | undefined;
    if (state === "wait") {
      for (const d of devices) {
        for (const p of d.profiles) {
          if (!usableOn(d, p, now)) continue;
          const at = peggedWindow(p.usage, now)?.resets_at;
          if (at && at > now && (resumesAt === undefined || at < resumesAt)) {
            resumesAt = at;
            resumesOn = p.email ?? p.name;
          }
        }
      }
    }

    // Your own accounts the pool narrowed off these machines. Only a wait asks
    // for them: anywhere else a saved account already has room.
    const held = (d: LaneDevice, email: string) => d.profiles.some((p) => emailKey(p.email) === email);
    const personal = input.pool.filter((r) => r.mine && !r.team_id);
    const keptOff: KeptOffAccount[] = [];
    const arriving: string[] = [];
    if (state === "wait") {
      for (const r of personal) {
        const email = emailKey(r.email);
        if (isUsageExhausted(r.usage ?? undefined, now, models)) continue;
        if (devices.some((d) => d.line_host) && lineHostsRefuse(email)) continue;
        const missing = devices.filter((d) => !held(d, email));
        if (missing.length === 0) continue;
        const list = r.device_ids ?? null;
        if (list && missing.some((d) => !list.includes(d.device_id))) keptOff.push({ email, usage: r.usage ?? undefined, deviceIds: list });
        else arriving.push(email);
      }
    }

    const heldAccounts = new Set(devices.flatMap((d) => d.profiles.filter((p) => usableOn(d, p, now)).map((p) => emailKey(p.email) || p.name))).size;
    lanes.push({
      key,
      label: laneLabel(devices),
      devices,
      sessionIds: g.sessions.map((s) => s._id),
      fleetEmails,
      fleetUsage,
      heldAccounts,
      state,
      accounts,
      unavailable: [...unavailable],
      resumesAt,
      resumesOn,
      keptOff: rankByHeadroom(keptOff, now),
      arriving,
    });
  }
  // Lanes a person can act on first, then the biggest.
  const rank = { switch: 0, continue: 1, wait: 2, offline: 3 } as const;
  return lanes.sort((a, b) => rank[a.state] - rank[b.state] || b.sessionIds.length - a.sessionIds.length);
}

/** The device list that opens `account` to a lane's machines as well. */
export function openedDeviceIds(account: KeptOffAccount, lane: Pick<BlockedLane, "devices">): string[] {
  return [...new Set([...account.deviceIds, ...lane.devices.map((d) => d.device_id)])].sort();
}
