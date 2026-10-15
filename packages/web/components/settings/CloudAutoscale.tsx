"use client";

/**
 * Autoscale on a Linux host, the template: when a new cloud session finds no
 * awake host with room, the preparing laptop wakes a sleeping host, then
 * launches one like this, up to a cap. Turning it on spends money without a
 * further press, so it is a consequential switch: the review shows the most
 * it can add per hour and how it winds down; turning it off is one press and
 * leaves the hosts it added to sleep.
 */

import { useState } from "react";
import { CLOUD_AUTOSCALE_DEFAULT_SIZE, CLOUD_AUTOSCALE_MAX_EXTRA_CHOICES, CLOUD_HOST_SIZES, type CloudHostSize } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { ConsequentialSwitch, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { deviceDisplayName, useDevices, type Device } from "../DeviceBadge";

const IDLE_SLEEP_MIN = 20;
const DISK_MONTHLY_USD = 80 * 0.08;
const capLabel = (n: number) => `${n} host${n === 1 ? "" : "s"}`;

/** The review for turning autoscale on. Pure, for tests. */
export function autoscaleLedger(opts: { like: string; laptop: string; laptopOnline: boolean; maxExtra: number; size: CloudHostSize }): SwitchLedger {
  const size = CLOUD_HOST_SIZES.find((s) => s.type === opts.size)!;
  return {
    name: "Autoscale",
    subject: `Hosts like ${opts.like}`,
    figures: [
      { value: `$${(size.hourly_usd * opts.maxExtra).toFixed(2)}/h`, label: "most it adds, all awake", tone: "warn" },
      { value: String(opts.maxExtra), label: "hosts at most" },
      { value: `${IDLE_SLEEP_MIN} min`, label: "idle, then asleep" },
    ],
    pick: { k: "Up to", options: CLOUD_AUTOSCALE_MAX_EXTRA_CHOICES.map(capLabel), value: capLabel(opts.maxExtra) },
    rows: [
      { k: "When", v: "a new session finds no awake host with room" },
      { k: "First", v: "wakes a sleeping host" },
      { k: "Then", v: `launches a ${size.type} (${size.memory_gb} GB) like ${opts.like}` },
      { k: "Asleep", v: `$${DISK_MONTHLY_USD.toFixed(2)}/mo disk per host` },
      { k: "Waits", v: "10 to 20 min, the session that launches a host" },
      { k: "Runs through", v: opts.laptop },
    ],
    stop: "Turn off here; added hosts sleep",
    confirm: "Turn on autoscale",
    ...(opts.laptopOnline ? {} : { blocked: `${opts.laptop} is offline` }),
  };
}

export function CloudAutoscale({ d }: { d: Device }) {
  const set = useInboxStore((s) => s.setCloudAutoscale);
  const { devices, byId } = useDevices();
  const policy = d.cloud_autoscale;
  const [maxExtra, setMaxExtra] = useState(policy?.max_extra ?? 2);
  const report = d.cloud_host;
  if (!report || !/linux/i.test(d.platform)) return null;
  const size = policy?.size ?? CLOUD_AUTOSCALE_DEFAULT_SIZE;
  const manager = byId.get(report.managed_by);
  const added = devices.filter((x) => x.cloud_host?.autoscaled && x.cloud_host.state !== "missing").length;
  const on = !!policy?.enabled;
  return (
    <span className="inline-flex items-center gap-2 text-[11px]" data-cloud-autoscale={on ? "on" : "off"}>
      <ConsequentialSwitch
        on={on}
        trigger={({ on: isOn, press, reviewing }) => isOn ? (
          <span className="inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-sol-green"><i aria-hidden className="h-1.5 w-1.5 rounded-full bg-sol-green" />Autoscale</span>
            <span className="font-mono text-sol-text-dim" title="Hosts autoscale launched, awake or asleep">{added} of {policy!.max_extra} added · {size}</span>
            <button type="button" className="text-sol-text-muted underline decoration-dotted underline-offset-2 hover:text-sol-text" onClick={press}>Turn off</button>
          </span>
        ) : (
          <button type="button" aria-haspopup="dialog" aria-expanded={reviewing} className="h-7 rounded-md px-3 text-[11px] text-sol-text-secondary hover:bg-sol-bg-alt hover:text-sol-text" onClick={press}>Autoscale…</button>
        )}
        ledger={autoscaleLedger({ like: deviceDisplayName(d), laptop: manager ? deviceDisplayName(manager) : "your laptop", laptopOnline: !!manager?.online, maxExtra, size })}
        onPick={(option) => setMaxExtra(CLOUD_AUTOSCALE_MAX_EXTRA_CHOICES.find((n) => capLabel(n) === option) ?? maxExtra)}
        onTurnOn={() => set(d.device_id, { enabled: true, max_extra: maxExtra, size })}
        onTurnOff={() => set(d.device_id, { enabled: false, max_extra: policy?.max_extra ?? maxExtra, size })}
      />
    </span>
  );
}
