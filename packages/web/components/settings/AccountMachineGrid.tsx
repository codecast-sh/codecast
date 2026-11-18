"use client";

// Settings › Claude Accounts › Where accounts run: your accounts as rows,
// your machines as columns, one cell per pair (lib/accountMachineGrid). A cell
// shows whether that machine can run sessions on that account and, through its
// mark, why. Pressing an open or closed cell writes your personal pool's
// machine list (setAccountDevices), the same fact `cast accounts devices`
// writes. Opening an account to the line hosts goes through the review,
// because line work then spends it.
import { Network } from "lucide-react";
import { worstUsagePercent } from "@codecast/shared/contracts";
import { SettingsSection } from "./ui";
import { useDevices } from "../DeviceBadge";
import { useInboxStore } from "../../store/inboxStore";
import { useAccountPool } from "../../hooks/useSyncAccountPool";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { openAccountLedger } from "../consequential/ledgers";
import { accountLabel, accountMachineGrid, toggledDeviceIds, type CellState, type GridCell, type GridColumn, type GridDeviceAccounts, type GridRow } from "../../lib/accountMachineGrid";

/** The anchor the blocked banner links to. */
export const WHERE_ACCOUNTS_RUN_ID = "where-accounts-run";

const MARK: Record<CellState, { glyph: string; tone: string; word: string }> = {
  own: { glyph: "●", tone: "text-sol-text", word: "its own login" },
  on: { glyph: "✓", tone: "text-sol-green", word: "runs here" },
  arriving: { glyph: "✓", tone: "text-sol-green/50", word: "opened, copy on its way" },
  line: { glyph: "L", tone: "text-sol-cyan", word: "through the team's line pool" },
  off: { glyph: "", tone: "", word: "kept off" },
  refused: { glyph: "✕", tone: "text-sol-text-dim", word: "line hosts refuse it" },
  local: { glyph: "–", tone: "text-sol-text-dim", word: "no token to share it" },
};

export function AccountMachineGrid({ accounts }: { accounts: readonly GridDeviceAccounts[] }) {
  const now = useCoarseNow(60_000);
  const { devices } = useDevices();
  const pool = useAccountPool();
  const setAccountDevices = useInboxStore((s) => s.setAccountDevices);
  const machines = devices.map((d) => ({ device_id: d.device_id, label: d.display_name || d.label, is_remote: d.is_remote, line_host: d.line_host, online: d.online }));
  const { columns, rows } = accountMachineGrid({ machines, accounts, pool, now });
  if (rows.length === 0 || columns.length === 0) return null;
  const allIds = machines.map((m) => m.device_id);
  const write = (row: GridRow, col: GridColumn, open: boolean) => setAccountDevices(row.email, toggledDeviceIds(row, col, open, allIds));

  return (
    <section id={WHERE_ACCOUNTS_RUN_ID} className="scroll-mt-4">
      <SettingsSection title="Where accounts run" icon={Network}>
        <div className="overflow-x-auto px-4 py-3 sm:px-5" data-account-grid>
          <table className="border-separate border-spacing-[3px] text-meta">
            <thead>
              <tr>
                <th />
                {columns.map((col) => (
                  <th key={col.key} className="max-w-[7rem] truncate px-1 pb-1 text-left font-medium text-sol-text-muted" title={col.machines.map((m) => m.label).join(", ")}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const pct = worstUsagePercent(row.usage, now);
                return (
                  <tr key={row.email} data-account-row={row.email}>
                    <th className="pr-3 text-left font-normal" title={row.email}>
                      <span className="text-sol-text">{accountLabel(row.email, rows.map((r) => r.email))}</span>
                      {pct != null && <span className={`ml-1.5 tabular-nums ${pct >= 100 ? "text-sol-orange" : "text-sol-text-dim"}`}>{Math.round(pct)}%</span>}
                    </th>
                    {row.cells.map((cell, i) => (
                      <td key={columns[i].key} className="p-0">
                        <Cell row={row} col={columns[i]} cell={cell} now={now} write={write} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-meta text-sol-text-dim" data-account-grid-legend>
            {(["own", "on", "line", "off", "refused", "local"] as CellState[]).map((s) => (
              <span key={s} className="flex items-center gap-1">
                <CellBox state={s} />
                {MARK[s].word}
              </span>
            ))}
          </div>
        </div>
      </SettingsSection>
    </section>
  );
}

function CellBox({ state, count }: { state: CellState; count?: string }) {
  const m = MARK[state];
  const box = state === "off" ? "border border-sol-border/70" : state === "arriving" ? "border border-dashed border-sol-green/40" : "bg-sol-bg-alt/60";
  return (
    <span className={`inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-[11px] font-semibold ${box} ${m.tone}`}>
      {m.glyph}
      {count && <span className="ml-0.5 font-normal tabular-nums">{count}</span>}
    </span>
  );
}

function Cell({ row, col, cell, now, write }: { row: GridRow; col: GridColumn; cell: GridCell; now: number; write: (row: GridRow, col: GridColumn, open: boolean) => void }) {
  const n = col.machines.length;
  const reached = (cell.counts.own ?? 0) + (cell.counts.on ?? 0) + (cell.counts.arriving ?? 0) + (cell.counts.line ?? 0);
  const count = n > 1 && reached > 0 && reached < n ? `${reached}/${n}` : undefined;
  const title = `${row.email} on ${col.label}: ${(Object.keys(cell.counts) as CellState[]).map((s) => (n > 1 ? `${cell.counts[s]} ${MARK[s].word}` : MARK[s].word)).join(", ")}`;
  const box = <CellBox state={cell.state} count={count} />;
  if (!cell.toggle) return <span title={title} data-cell={cell.state}>{box}</span>;
  // Line work spends whatever reaches the hosts: opening one goes through the review.
  if (cell.toggle === "open" && col.line) {
    const ledger = openAccountLedger({ email: row.email, percent: worstUsagePercent(row.usage, now), machines: col.machines.map((m) => m.label), lineHosts: true });
    return (
      <ConsequentialSwitch
        on={false}
        ledger={ledger}
        onTurnOn={() => write(row, col, true)}
        onTurnOff={() => {}}
        trigger={({ press }) => (
          <button type="button" onClick={press} title={title} data-cell={cell.state} data-cell-toggle="open" className="rounded hover:ring-1 hover:ring-amber-500/50">
            {box}
          </button>
        )}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => write(row, col, cell.toggle === "open")}
      title={title}
      data-cell={cell.state}
      data-cell-toggle={cell.toggle}
      className="rounded hover:ring-1 hover:ring-sol-border"
    >
      {box}
    </button>
  );
}
