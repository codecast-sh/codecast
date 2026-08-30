"use client";

import {
  DeviceDot,
  deviceDisplayName,
  deviceKindLabel,
  relativeSeen,
  type Device,
} from "../DeviceBadge";

/**
 * The shared head of a device-scoped settings surface: optional pills to pick
 * which machine you're configuring, and a status line naming the device and
 * whether changes land now. Used by Agent Features and Provider keys as the
 * panel head, and by Devices as each machine's title line.
 */
export function DevicePanelHeader({
  devices,
  selected,
  onSelect,
  note = "apply",
  className,
}: {
  /** All candidate devices; pills render only when there is more than one. */
  devices?: Device[];
  selected: Device;
  onSelect?: (id: string) => void;
  /** "apply" narrates whether changes land now; "seen" is a plain presence line. */
  note?: "apply" | "seen";
  className?: string;
}) {
  const showPicker = !!devices && !!onSelect && devices.length > 1;
  return (
    <div className={className ?? "space-y-3"}>
      {showPicker && (
        <div className="flex flex-wrap gap-2">
          {devices.map((d) => {
            const active = d.device_id === selected.device_id;
            return (
              <button
                key={d.device_id}
                type="button"
                onClick={() => onSelect(d.device_id)}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                  active
                    ? "border-sol-cyan bg-sol-cyan/10 text-sol-text"
                    : "border-sol-border bg-sol-bg-alt text-sol-text-muted hover:border-sol-text-muted"
                }`}
              >
                <DeviceDot online={d.online} />
                <span className="font-medium">{deviceDisplayName(d)}</span>
                <span className="opacity-60">{deviceKindLabel(d)}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <DeviceDot online={selected.online} />
          <span className="truncate font-medium text-sol-text">{deviceDisplayName(selected)}</span>
          {/* With a picker, the pills already name each machine's kind. */}
          {!showPicker && <span className="shrink-0 text-xs text-sol-text-muted">{deviceKindLabel(selected)}</span>}
        </div>
        <span className="shrink-0 text-[11px] text-sol-text-muted">
          {note === "apply"
            ? selected.online
              ? "Online — changes apply now"
              : `Offline — last seen ${relativeSeen(selected.last_seen)}`
            : selected.online
              ? "Online"
              : `Last seen ${relativeSeen(selected.last_seen)}`}
        </span>
      </div>
    </div>
  );
}
