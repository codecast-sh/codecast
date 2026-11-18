"use client";

// One lane of the blocked banner (lib/blockedLanes): the machines a group of
// parked sessions runs on, and the one thing that can happen to them there.
// A lane that can continue carries the continue button and its own account
// picker, since accounts belong to machines. A lane that must wait says when it
// resumes and, when one of your accounts with room is kept off its machines,
// offers to open it there through the shared review.
import type { ReactNode } from "react";
import { formatCountdown, worstUsagePercent } from "@codecast/shared/contracts";
import { WHERE_ACCOUNTS_RUN_ID } from "../lib/accountMachineAnchors";
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
  countLabel,
  children,
}: {
  lane: BlockedLane;
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
  /** What the lane holds, e.g. "3 sessions · 49 workers". */
  countLabel: string;
  /** The lane's sessions, drawn under it when the banner is expanded. */
  children?: ReactNode;
}) {
  const n = lane.sessionIds.length;
  const isThisMachine = lane.devices.length === 1 && lane.devices[0].device_id === localDeviceId;
  return (
    <div className="rounded border border-sol-border/40 bg-sol-bg/40 px-2.5 py-2" data-blocked-lane={lane.state}>
      <div className="flex items-baseline gap-2 text-meta" title={lane.devices.map((d) => d.label).join(", ")}>
        <span className="min-w-0 truncate font-medium text-sol-text">{isThisMachine ? "This machine" : lane.label}</span>
        <span className="ml-auto shrink-0 tabular-nums text-sol-text-dim">{countLabel}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {(lane.state === "continue" || lane.state === "switch") && (
        <>
          <Button variant="amber" size="xs" onClick={onContinue} disabled={busy || chosen === 0} title={continueTitle}>
            {busy ? (target ? "Switching…" : "Continuing…") : continueLabel}
          </Button>
          {lane.accounts.length > 0 && (
            <>
              <span className="-mx-0.5 text-meta text-sol-text-dim">on</span>
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
            </>
          )}
        </>
      )}
      {lane.state === "wait" && <WaitLane lane={lane} now={now} recoveryDevice={recoveryDevice} />}
      {lane.state === "offline" && (
        <span className="text-meta text-sol-text-muted">Offline: continue them once it is back</span>
      )}
      </div>
      {children}
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
  const spent = lane.heldAccounts > 1 ? `All ${lane.heldAccounts} accounts used up` : `${lane.fleetEmails.length === 1 ? short(lane.fleetEmails[0]) : "Its account"} used up`;
  const accounts = [...lane.fleetEmails, ...lane.unavailable.map(([e, why]) => `${e} (${why})`)].join(", ");
  return (
    <>
      <span
        className="text-meta text-amber-700 dark:text-amber-500"
        title={`${accounts}${resumesIn ? `. ${lane.resumesOn} resets first.` : ""}${lane.arriving.length > 0 ? ` Arriving: ${lane.arriving.join(", ")}.` : ""}`}
      >
        {spent}
        {resumesIn && (recoveryDevice ? <ResetLine device={recoveryDevice} resumesIn={resumesIn} /> : <ResetText verb="resets" resumesIn={resumesIn} />)}
      </span>
      {lane.keptOff[0] ? (
        <OpenAccountHere lane={lane} now={now} resumesIn={resumesIn} />
      ) : (
        <button
          type="button"
          onClick={openWhereAccountsRun}
          className="text-meta text-sol-text-dim underline decoration-dotted hover:text-sol-text"
        >
          Accounts
        </button>
      )}
    </>
  );
}

function ResetText({ verb, resumesIn }: { verb: string; resumesIn: string }) {
  return <span className="tabular-nums text-sol-text-muted"> · {verb} in {resumesIn}</span>;
}

/** With recovery on the lane comes back by itself at the reset; off, it offers the one mode that does. */
function ResetLine({ device, resumesIn }: { device: RecoveryDevice; resumesIn: string }) {
  const { recovery } = useAccountRecoveryToggles(device);
  if (recovery.mode !== "off") return <ResetText verb="resumes by itself" resumesIn={resumesIn} />;
  return (
    <>
      <ResetText verb="resets" resumesIn={resumesIn} />
      <button
        type="button"
        onClick={() => void recovery.set("resume")}
        disabled={recovery.pending}
        className="ml-2 rounded border border-sol-border/60 px-1.5 text-meta text-sol-text-muted hover:text-sol-text disabled:opacity-60"
        title="Turn on continue-after-reset for your machines"
      >
        Resume at reset
      </button>
    </>
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
          Use {short(account.email)} now
          {percent != null && <span className="ml-1 font-normal text-sol-text-dim">{Math.round(percent)}% used</span>}
        </button>
      )}
    />
  );
}
