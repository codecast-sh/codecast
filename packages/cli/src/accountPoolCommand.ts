/**
 * The actions behind `cast accounts share | unshare | devices | pool`
 * (declared in index.ts, loaded only when one runs): the account pool from the
 * shell. Each verb calls the server function the web's control calls
 * (accountPool.setAccountShares, setAccountDevices), the same way
 * `cast devices share` mirrors Settings > Machines.
 */

import { fmt } from "./colors.js";
import { deviceId } from "./remote/device.js";
import { listProfiles } from "./ccAccounts.js";

// The devices group's client and team pickers, loaded when a verb runs so the
// CLI's boot graph stays as it was.
const devicesKit = () => import("./devices/command.js");

const formatTokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

/** One of this machine's own saved profiles (never a pool copy), by name. */
async function ownProfile(name: string) {
  const { die } = await devicesKit();
  const p = listProfiles().find((x) => x.name === name);
  if (!p) return die(`no saved profile "${name}" on this machine (cast accounts ls)`);
  if (p.pool_share_id) return die(`"${name}" is a teammate's account from the pool; only the person who shared it can take it back`);
  if (!p.email) return die(`"${name}" has no email on record`);
  return { ...p, email: p.email };
}

/** Current pool teams of one of the caller's accounts, with each share's pool labels. */
const sharedTeams = async (b: any, email: string): Promise<Map<string, string[]>> =>
  new Map(((await b.client.query(b.api.accountPool.listPool, { api_token: b.token })) ?? [])
    .filter((r: any) => r.mine && r.team_id && r.email === email.toLowerCase())
    .map((r: any) => [String(r.team_id), (r.pools ?? []) as string[]]));

/** The label set for each named team after adding or removing `pool`. */
const relabel = (current: Map<string, string[]>, teamIds: string[], pool: string, add: boolean): Record<string, string[]> =>
  Object.fromEntries(teamIds.map((id) => {
    const labels = new Set(current.get(id) ?? []);
    if (add) labels.add(pool);
    else labels.delete(pool);
    return [id, [...labels].sort()];
  }));

const POOL_NOTE: Record<string, string> = { line: "the team's line hosts" };

export async function shareAccount(name: string, names: string[], o: { yes?: boolean; pool?: string }, publishInventory: () => Promise<void>): Promise<void> {
  const { backend, myTeams, pickTeams } = await devicesKit();
  const p = await ownProfile(name);
  const b = await backend();
  const add = pickTeams(await myTeams(b), names);
  const { requireDestructiveConfirm } = await import("./destructiveCommands.js");
  await requireDestructiveConfirm(["accounts", "share"], { yes: o.yes, args: [name, ...names] });
  // The server checks the account against this machine's published inventory.
  await publishInventory();
  const current = await sharedTeams(b, p.email);
  const addIds = add.map((t) => t._id);
  const next = [...new Set([...current.keys(), ...addIds])];
  await b.client.mutation(b.api.accountPool.setAccountShares, {
    api_token: b.token,
    device_id: deviceId(),
    email: p.email,
    team_ids: next,
    ...(o.pool ? { pools: relabel(current, addIds, o.pool, true) } : {}),
  });
  const reach = o.pool ? `teammates' machines and ${POOL_NOTE[o.pool] ?? `the ${o.pool} pool`}` : "teammates' machines";
  console.log(`${fmt.success("ok")} ${p.email} is in ${add.map((t) => t.name).join(", ")}'s ${o.pool ? `${o.pool} ` : ""}pool; ${reach} get a sealed copy within a minute`);
}

export async function unshareAccount(name: string, names: string[], o: { pool?: string } = {}): Promise<void> {
  const { backend, myTeams, pickTeams } = await devicesKit();
  const p = await ownProfile(name);
  const b = await backend();
  const teams = await myTeams(b);
  const current = await sharedTeams(b, p.email);
  if (o.pool) {
    // Only the label goes: the account stays in the team pool.
    const ids = names.length ? pickTeams(teams, names).map((t) => t._id) : [...current.keys()];
    const labelled = ids.filter((id) => current.get(id)?.includes(o.pool!));
    await b.client.mutation(b.api.accountPool.setAccountShares, {
      api_token: b.token,
      device_id: deviceId(),
      email: p.email,
      team_ids: [...current.keys()],
      pools: relabel(current, labelled, o.pool, false),
    });
    console.log(`${fmt.success("ok")} ${p.email} ${labelled.length ? `is out of the ${o.pool} pool of ${labelled.length} team(s)` : `was in no ${o.pool} pool`}`);
    return;
  }
  const drop = names.length ? new Set(pickTeams(teams, names).map((t) => t._id)) : null;
  const next = drop ? [...current.keys()].filter((id) => !drop.has(id)) : [];
  await b.client.mutation(b.api.accountPool.setAccountShares, { api_token: b.token, device_id: deviceId(), email: p.email, team_ids: next });
  console.log(`${fmt.success("ok")} ${p.email} ${next.length ? `stays in ${next.length} pool(s)` : "is out of every pool"}`);
}

/** Which of your machines run on one of your accounts: all of them (--all),
 *  the named ones, or none named: only the machine that holds it. */
export async function accountDevices(name: string, needles: string[], o: { all?: boolean }): Promise<void> {
  const { backend, ownDevice } = await devicesKit();
  const p = await ownProfile(name);
  const b = await backend();
  const ids = o.all ? null : await Promise.all(needles.map(async (n) => (await ownDevice(b, n)).device_id as string));
  await b.client.mutation(b.api.accountPool.setAccountDevices, { api_token: b.token, email: p.email, device_ids: ids });
  const where = ids === null ? "every machine of yours" : ids.length ? `${ids.length} machine(s) besides this one` : "this machine only";
  console.log(`${fmt.success("ok")} ${p.email} runs on ${where}; machines taken off drop it within a minute`);
}

export async function printPool(o: { json?: boolean }): Promise<void> {
  const { backend } = await devicesKit();
  const b = await backend();
  const rows = (await b.client.query(b.api.accountPool.listPool, { api_token: b.token })) ?? [];
  if (o.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(fmt.muted("No pooled accounts. An account joins once a machine of yours holds it with a setup-token: cast accounts token <profile>"));
    return;
  }
  for (const r of rows) {
    const s = r.usage?.session?.percent;
    const w = r.usage?.weekly?.percent;
    const meter = s === undefined && w === undefined ? fmt.muted("no meter yet") : `session ${Math.round(s ?? 0)}% · week ${Math.round(w ?? 0)}%`;
    const reach = r.team_id ? "" : r.device_ids ? `[${r.device_ids.length ? `narrowed to ${r.device_ids.length} machine(s)` : "holder only"}]` : "[all your machines]";
    const labels = [reach, ...(r.pools ?? []).map((l: string) => `[${l}]`)].filter(Boolean).map((l) => fmt.accent(l)).join(" ");
    console.log(`${fmt.accent(r.email)}${labels ? ` ${labels}` : ""}  ${fmt.muted(`from ${r.mine ? "you" : r.contributor_name}`)}  ${meter}  ${fmt.muted(`${r.machines} machine(s)`)}`);
    const total = r.split.reduce((a: number, x: any) => a + x.tokens, 0);
    for (const x of r.split) {
      console.log(`    ${x.name.padEnd(24)} ${formatTokens(x.tokens).padStart(6)}  ${total ? Math.round((100 * x.tokens) / total) : 0}%`);
    }
  }
}
