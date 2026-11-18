"use client";

// One lane of the blocked banner (lib/blockedLanes): the machines a group of
// parked sessions runs on, and the one thing that can happen to them there.
// A lane that can continue carries the continue button and its own account
// picker, since accounts belong to machines. A lane that must wait says when it
// resumes and, when one of your accounts with room is kept off its machines,
// offers to open it there through the shared review.
import { formatCountdown, worstUsagePercent } from "@codecast/shared/contracts";
import { WHERE_ACCOUNTS_RUN_ID } from "./settings/AccountMachineGrid";
import { Button } from "./ui/button";
import { ContinueAccountPicker } from "./ContinueAccountPicker";
import { ConsequentialSwitch } from "./consequential/ConsequentialSwitch";
import { openAccountLedger } from "./consequential/ledgers";
import { useAccountRecoveryToggles } from "../hooks/useAccountRecoveryToggles";
import { useInboxStore } from "../store/inboxStore";
import { openedDeviceIds, type BlockedLane, type LaneAccount } from "../lib/blockedLanes";

const short = (email?: string) => email?.split("@")[0] ?? "account";

/** The person's machine, whose recovery mode every lane recovers under (hostRecovery.recoveryFleet). */
export type RecoveryDevice = { device_id: string; auto_switch: boolean; auto_continue?: boolean; ask_first?: boolean };

export function BlockedLaneRow({
  lane,
  showLabel,
  now,
  chosen,
  target,
  recommendedKey,
  localDeviceId,
  busy,
  continueLabel,
  continueTitle,
  onPick,
  onContinue,
  recoveryDevice,
}: {
  lane: BlockedLane;
  showLabel: boolean;
  now: number;
  /** How many of the lane's sessions are ticked. */
  chosen: number;
  target?: LaneAccount;
  recommendedKey?: string;
  localDeviceId?: string | null;
  busy: boolean;
  continueLabel: string;
  continueTitle: string;
  onPick: (key: string) => void;
  onContinue: () => void;
  recoveryDevice?: RecoveryDevice;
}) {
  const n = lane.sessionIds.length;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-blocked-lane={lane.state}>
      {showLabel && (
        <span className="min-w-0 truncate text-meta text-sol-text-muted" title={lane.devices.map((d) => d.label).join(", ")}>
          <span className="font-medium text-sol-text">{lane.label}</span>
          <span className="tabular-nums"> · {n}</span>
        </span>
      )}
      {(lane.state === "continue" || lane.state === "switch") && (
        <>
          <Button variant="amber" size="xs" onClick={onContinue} disabled={busy || chosen === 0} title={continueTitle}>
            {busy ? (target ? "Switching…" : "Continuing…") : continueLabel}
          </Button>
          {lane.accounts.length > 0 && (
            <ContinueAccountPicker
              machines={lane.devices.map((d) => ({
                deviceId: d.device_id,
                label: d.label,
                isLocal: d.device_id === localDeviceId,
                email: lane.fleetEmails.length === 1 ? lane.fleetEmails[0] : d.active_email,
                usage: lane.fleetUsage,
                sessions: n,
              }))}
              accounts={lane.accounts}
              unavailable={lane.unavailable}
              value={target?.key ?? ""}
              recommendedKey={recommendedKey}
              onChange={onPick}
              disabled={busy}
              now={now}
            />
          )}
        </>
      )}
      {lane.state === "wait" && <WaitLane lane={lane} now={now} recoveryDevice={recoveryDevice} />}
      {lane.state === "offline" && (
        <span className="text-meta text-sol-text-muted" title="No machine that runs these sessions is online">
          machine offline
        </span>
      )}
    </div>
  );
}

/** Settings › Claude Accounts, scrolled to the accounts × machines grid once the modal draws it. */
function openWhereAccountsRun() {
  useInboxStore.getState().openSettingsModal("claude-accounts");
  const started = Date.now();
  const find = () => {
    const el = document.getElementById(WHERE_ACCOUNTS_RUN_ID);
    if (el) el.scrollIntoView({ block: "start" });
    else if (Date.now() - started < 3000) requestAnimationFrame(find);
  };
  requestAnimationFrame(find);
}

function WaitLane({ lane, now, recoveryDevice }: { lane: BlockedLane; now: number; recoveryDevice?: RecoveryDevice }) {
  const resumesIn = lane.resumesAt ? formatCountdown(lane.resumesAt - now) : null;
  const spent = lane.fleetEmails.length === 1 ? short(lane.fleetEmails[0]) : `${lane.fleetEmails.length} accounts`;
  return (
    <>
      <span
        className="text-meta font-semibold text-amber-700 dark:text-amber-500"
        title={`Every account ${lane.label} can run is at its limit: ${[...lane.fleetEmails, ...lane.unavailable.map(([e, why]) => `${e} (${why})`)].join(", ")}`}
      >
        {lane.heldAccounts > 1 ? `all ${lane.heldAccounts} accounts spent` : `${spent} spent`}
      </span>
      {resumesIn && (
        <span className="text-meta tabular-nums text-sol-text-muted" title={`${lane.resumesOn} is the first of them to reset`}>
          {short(lane.resumesOn)} resets in {resumesIn}
        </span>
      )}
      {recoveryDevice && <ResumeAtReset device={recoveryDevice} />}
      {lane.arriving.map((email) => (
        <span key={email} className="text-meta text-sol-text-muted" title={`${email} is open to these machines; its copy lands on their next pool pass`}>
          {short(email)} arriving
        </span>
      ))}
      {lane.keptOff[0] && <OpenAccountHere lane={lane} now={now} resumesIn={resumesIn} />}
      <button
        type="button"
        onClick={openWhereAccountsRun}
        className="text-meta text-sol-text-dim underline decoration-dotted hover:text-sol-text"
        title="Which accounts each of your machines can run"
      >
        accounts per machine
      </button>
    </>
  );
}

/** Off: the sessions sit until someone continues them, so the lane offers the one mode that resumes them at the reset. */
function ResumeAtReset({ device }: { device: RecoveryDevice }) {
  const { recovery } = useAccountRecoveryToggles(device);
  if (recovery.mode !== "off") {
    return <span className="rounded border border-sol-cyan/30 px-1 text-meta text-sol-cyan" title="Your recovery mode continues them when an account reopens">resumes itself</span>;
  }
  return (
    <button
      type="button"
      onClick={() => void recovery.set("resume")}
      disabled={recovery.pending}
      className="rounded border border-sol-border/60 px-1.5 text-meta text-sol-text-muted hover:text-sol-text disabled:opacity-60"
      title="Recovery is off, so nothing continues them at the reset. Turn on continue-after-reset for your machines."
    >
      Resume at reset
    </button>
  );
}

function OpenAccountHere({ lane, now, resumesIn }: { lane: BlockedLane; now: number; resumesIn: string | null }) {
  const setAccountDevices = useInboxStore((s) => s.setAccountDevices);
  const account = lane.keptOff[0];
  const percent = worstUsagePercent(account.usage, now);
  const ledger = openAccountLedger({
    email: account.email,
    percent,
    machines: lane.devices.map((d) => d.label),
    lineHosts: lane.devices.some((d) => d.line_host),
    sessions: lane.sessionIds.length,
    resumesIn,
  });
  return (
    <ConsequentialSwitch
      on={false}
      ledger={ledger}
      onTurnOn={() => setAccountDevices(account.email, openedDeviceIds(account, lane))}
      onTurnOff={() => {}}
      trigger={({ press }) => (
        <button
          type="button"
          data-open-account={account.email}
          onClick={press}
          className="rounded border border-amber-500/40 px-2 py-0.5 text-meta font-medium text-amber-700 hover:bg-amber-500/10 dark:text-amber-500"
          title={`${account.email} has room but is kept off ${lane.label}`}
        >
          Open {short(account.email)} here{percent != null ? ` · ${Math.round(percent)}%` : ""}
        </button>
      )}
    />
  );
}
