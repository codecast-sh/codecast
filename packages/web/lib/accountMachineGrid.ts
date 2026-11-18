// Where each of your Claude accounts can run: your accounts as rows, your
// machines as columns (convex/accountPool.ts). One cell answers one question,
// "can this machine run sessions on this account, and why", from the three
// facts that decide it: the machine's own saved login, your personal pool row's
// machine list (setAccountDevices), and a team share labelled for the line
// (which reaches the line hosts). Line hosts are one column, because they are
// one fleet that moves together. Pure, so the grid and its toggles are tested
// without a browser.
import { lineHostsRefuse } from "@codecast/convex/convex/ccSwitchAhead";
import { rankByHeadroom, type CcUsage } from "@codecast/shared/contracts";

export type GridMachine = { device_id: string; label: string; is_remote: boolean; line_host?: boolean; online?: boolean };
export type GridProfile = { name: string; email?: string; usage?: CcUsage; pool_share_id?: string };
export type GridDeviceAccounts = { device_id: string; profiles: GridProfile[] };
export type GridPoolRow = { mine: boolean; team_id: string | null; email: string; device_ids?: string[] | null; pools?: string[]; usage?: CcUsage | null; holder_device_id?: string };

/**
 * own: the machine's own saved login; it always keeps it.
 * on: the pool reaches the machine and its copy is there.
 * arriving: the pool reaches it, the copy has not landed yet.
 * line: reaches the line hosts through a team share labelled for the line.
 * off: kept off this machine (your choice, one press to open).
 * refused: line hosts never take this account.
 * local: no setup-token, so it stays on the machine that logged in.
 */
export type CellState = "own" | "on" | "arriving" | "line" | "off" | "refused" | "local";

const STATE_ORDER: CellState[] = ["own", "on", "arriving", "line", "off", "refused", "local"];

export type GridColumn = { key: string; label: string; machines: GridMachine[]; line: boolean };
export type GridCell = { state: CellState; /** Machines in the column per state, when they differ. */ counts: Partial<Record<CellState, number>>; toggle: "open" | "close" | null };
export type GridRow = { email: string; usage?: CcUsage; shareable: boolean; deviceIds: string[] | null; cells: GridCell[] };

const key = (e?: string | null) => (e ?? "").trim().toLowerCase();

function machineState(email: string, m: GridMachine, held: Map<string, GridProfile[]>, personal: GridPoolRow | undefined, linePooled: boolean): CellState {
  const profiles = held.get(m.device_id);
  const here = (profiles ?? []).filter((p) => key(p.email) === email);
  if (here.some((p) => !p.pool_share_id)) return "own";
  if (m.line_host && lineHostsRefuse(email)) return "refused";
  if (!personal) return "local";
  const allowed = !personal.device_ids || personal.device_ids.includes(m.device_id);
  // A machine reporting no inventory (offline) cannot show its copy: allowed reads as on.
  if (allowed) return here.length || !profiles ? "on" : "arriving";
  if (m.line_host && linePooled) return "line";
  return "off";
}

export function accountMachineGrid(input: {
  machines: readonly GridMachine[];
  accounts: readonly GridDeviceAccounts[];
  pool: readonly GridPoolRow[];
  now: number;
}): { columns: GridColumn[]; rows: GridRow[] } {
  const held = new Map(input.accounts.map((a) => [a.device_id, a.profiles]));
  const mine = input.pool.filter((r) => r.mine);
  // Every account you own: the personal pool, plus logins with no token yet.
  const emails = new Map<string, CcUsage | undefined>();
  for (const r of mine) if (!r.team_id) emails.set(key(r.email), r.usage ?? undefined);
  for (const a of input.accounts) {
    for (const p of a.profiles) {
      if (!p.email || p.pool_share_id || emails.has(key(p.email))) continue;
      emails.set(key(p.email), p.usage);
    }
  }
  const accounts = [...emails].map(([email, usage]) => ({
    email,
    usage,
    personal: mine.find((r) => !r.team_id && key(r.email) === email),
    linePooled: mine.some((r) => r.team_id && key(r.email) === email && r.pools?.includes("line")),
  }));
  const stateOf = (m: GridMachine, a: (typeof accounts)[number]) => machineState(a.email, m, held, a.personal, a.linePooled);

  // Columns. Each laptop or desk machine is its own. Line hosts are one fleet.
  // Other cloud hosts that run exactly the same accounts read as one column.
  const columns: GridColumn[] = [];
  const locals = input.machines.filter((m) => !m.is_remote && !m.line_host).sort((a, b) => a.label.localeCompare(b.label));
  for (const m of locals) columns.push({ key: m.device_id, label: m.label, machines: [m], line: false });
  const clouds = new Map<string, GridMachine[]>();
  for (const m of input.machines.filter((x) => x.is_remote && !x.line_host)) {
    const sig = accounts.map((a) => stateOf(m, a)).join(",");
    clouds.set(sig, [...(clouds.get(sig) ?? []), m]);
  }
  for (const group of [...clouds.values()].sort((a, b) => b.length - a.length)) {
    columns.push({ key: group.map((m) => m.device_id).join("+"), label: group.length === 1 ? group[0].label : `${group.length} cloud hosts`, machines: group, line: false });
  }
  const line = input.machines.filter((m) => m.line_host);
  if (line.length) columns.push({ key: "line", label: line.length === 1 ? line[0].label : `${line.length} line hosts`, machines: line, line: true });

  const rows: GridRow[] = accounts.map((a) => {
    const cells = columns.map((col): GridCell => {
      const counts: Partial<Record<CellState, number>> = {};
      for (const m of col.machines) {
        const st = stateOf(m, a);
        counts[st] = (counts[st] ?? 0) + 1;
      }
      // A mixed column reads as its most open state; the counts say the rest.
      const state = STATE_ORDER.find((s) => counts[s]) ?? "local";
      const openable = (counts.off ?? 0) > 0;
      const closable = (counts.on ?? 0) + (counts.arriving ?? 0) > 0;
      // A partly open column opens the rest first; a fully open one closes.
      const toggle = !a.personal ? null : openable ? "open" : closable ? "close" : null;
      return { state, counts, toggle };
    });
    return { email: a.email, usage: a.usage, shareable: !!a.personal, deviceIds: a.personal ? a.personal.device_ids ?? null : null, cells };
  });
  return { columns, rows: rankByHeadroom(rows, input.now) };
}

/** How a row names its account: the part before the @, unless two accounts share it. */
export function accountLabel(email: string, all: readonly string[]): string {
  const local = email.split("@")[0];
  return all.filter((e) => e.split("@")[0] === local).length > 1 ? email : local;
}

/**
 * The machine list that opens (or closes) an account on a column's machines.
 * Null when it reaches every machine you have: the pool's "all machines".
 * Machines that hold the account as their own login keep it whatever the list says.
 */
export function toggledDeviceIds(row: Pick<GridRow, "deviceIds">, column: GridColumn, open: boolean, allMachineIds: readonly string[]): string[] | null {
  const ids = column.machines.map((m) => m.device_id);
  const current = row.deviceIds ?? [...allMachineIds];
  const next = open ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id));
  return allMachineIds.every((id) => next.includes(id)) ? null : next.sort();
}
