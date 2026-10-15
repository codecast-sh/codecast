"use client";

/**
 * Launch another cloud host like an existing one: same AWS region, network,
 * key and account, a size picked in the review. Spends money from the first
 * minute, so the press opens the shared review (consequential), never the
 * launch itself. The managing laptop runs `cast hosts create linux --like`,
 * which registers and provisions the new host; it joins the machine list
 * when its daemon comes online, and placements spread onto it from then.
 */

import { useState } from "react";
import { CLOUD_HOST_SIZES, type CloudHostSize } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { deviceDisplayName, useDevices, type Device } from "../DeviceBadge";

const DISK_GIB = 80;
const GP3_USD_PER_GIB_MONTH = 0.08;
const sizeLabel = (s: (typeof CLOUD_HOST_SIZES)[number]) => `${s.memory_gb} GB`;

/** The review for a new host. Pure, for tests. */
export function cloneHostLedger(opts: { like: string; region?: string; laptop: string; laptopOnline: boolean; size: CloudHostSize }): SwitchLedger {
  const size = CLOUD_HOST_SIZES.find((s) => s.type === opts.size)!;
  return {
    name: "New cloud host",
    subject: `Like ${opts.like}`,
    shift: null,
    figures: [
      { value: `$${size.hourly_usd.toFixed(2)}/h`, label: "while awake", tone: "warn" },
      { value: `$${Math.round(size.hourly_usd * 24 * 30)}/mo`, label: "if never asleep" },
      { value: `${size.memory_gb} GB`, label: `${size.vcpu} CPU · ${size.type}` },
    ],
    pick: { k: "Size", options: CLOUD_HOST_SIZES.map(sizeLabel), value: sizeLabel(size) },
    rows: [
      { k: "Region", v: opts.region ?? "as the host it copies" },
      { k: "Disk", v: `${DISK_GIB} GB · $${(DISK_GIB * GP3_USD_PER_GIB_MONTH).toFixed(2)}/mo, asleep too` },
      { k: "Starts from", v: "your newest saved image, else Ubuntu 24.04" },
      { k: "Ready in", v: "about 10 to 20 min" },
      { k: "Runs through", v: opts.laptop },
    ],
    confirm: `Launch ${size.type}`,
    keep: "Cancel",
    ...(opts.laptopOnline ? {} : { blocked: `${opts.laptop} is offline` }),
  };
}

/**
 * The trigger and its review. `like` is the host to copy (a Linux host with a
 * laptop report); `label` and `className` let a banner and the Machines page
 * wear their own button style.
 */
export function AddCloudHost({ like, label = "Add a host like this", className }: { like: Device; label?: string; className?: string }) {
  const act = useInboxStore((s) => s.cloudHostAction);
  const { byId } = useDevices();
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<CloudHostSize>("t3.xlarge");
  const report = like.cloud_host;
  if (!report || /^mac/.test(report.instance_type ?? "") || /darwin|mac/i.test(like.platform)) return null;
  const manager = byId.get(report.managed_by);
  const ledger = cloneHostLedger({
    like: deviceDisplayName(like),
    region: report.region,
    laptop: manager ? deviceDisplayName(manager) : "your laptop",
    laptopOnline: !!manager?.online,
    size,
  });
  return (
    <>
      <button type="button" className={className} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} data-add-cloud-host>
        {label}
      </button>
      {open && (
        <SwitchReview
          ledger={ledger}
          onClose={() => setOpen(false)}
          onPick={(option) => setSize(CLOUD_HOST_SIZES.find((s) => sizeLabel(s) === option)?.type ?? size)}
          onConfirm={() => { setOpen(false); act(like.device_id, "clone", size); }}
        />
      )}
    </>
  );
}
