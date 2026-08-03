"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Card } from "../../../components/ui/card";
import {
  useDevices,
  deviceDisplayName,
  deviceKindLabel,
  relativeSeen,
  DeviceDot,
  type Device,
} from "../../../components/DeviceBadge";

function PlatformGlyph({ d }: { d: Device }) {
  const cls = "w-5 h-5";
  if (d.is_remote)
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h11a3 3 0 000-6 5 5 0 00-9.584-1.5A3.5 3.5 0 003 15z" />
      </svg>
    );
  if (/linux/i.test(d.platform))
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    );
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

/**
 * The SSH target for reaching this machine's tmux panes from elsewhere.
 *
 * Kept user-set rather than derived: an alias like "nose" only means anything
 * against the ~/.ssh/config of the machine you're sitting at, which no daemon
 * on the TARGET can see. The reported hostname is offered as a placeholder
 * because it's usually right, never as a silent default.
 */
function SshHostField({ d }: { d: Device }) {
  const setSshHost = useMutation(api.devices.setDeviceSshHost);
  const [value, setValue] = useState(d.ssh_host ?? "");
  const [saving, setSaving] = useState(false);
  // Server value wins whenever it changes under us (another tab, another
  // device), but never while the field is dirty — that would eat keystrokes.
  const [committed, setCommitted] = useState(d.ssh_host ?? "");
  if ((d.ssh_host ?? "") !== committed && value === committed) {
    setCommitted(d.ssh_host ?? "");
    setValue(d.ssh_host ?? "");
  }

  const dirty = value.trim() !== committed;
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const res = await setSshHost({ device_id: d.device_id, ssh_host: value.trim() });
      const next = res?.ssh_host ?? "";
      setCommitted(next);
      setValue(next);
      toast.success(next ? `SSH host set to ${next}` : "SSH host cleared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save SSH host");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3">
      <label className="block text-[11px] text-gray-400" htmlFor={`ssh-${d.device_id}`}>
        SSH host
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={`ssh-${d.device_id}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setValue(committed);
          }}
          placeholder={d.hostname || "e.g. nose"}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 px-2 py-1 rounded border border-gray-500/25 bg-transparent text-[11px] font-mono placeholder:text-gray-600 focus:outline-none focus:border-sol-blue/50"
        />
        {dirty && (
          <button
            onClick={save}
            disabled={saving}
            className="px-2 py-1 rounded text-[11px] border border-sol-blue/30 bg-sol-blue/10 text-sol-blue hover:bg-sol-blue/20 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-gray-500">
        {committed ? (
          <>
            A session on this machine copies{" "}
            <code className="font-mono text-gray-400">ssh {committed} -t &quot;tmux attach …&quot;</code>
          </>
        ) : (
          <>Set this to get a ready-to-paste attach command for sessions running here. Leave blank if you only ever attach while sitting at this machine.</>
        )}
      </p>
    </div>
  );
}

function DeviceRow({ d }: { d: Device }) {
  const accent = d.is_remote ? "text-sol-violet" : /linux/i.test(d.platform) ? "text-sol-orange" : "text-sol-blue";
  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div className={`mt-0.5 ${accent}`}>
          <PlatformGlyph d={d} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{deviceDisplayName(d)}</span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] border ${
                d.is_remote
                  ? "bg-sol-violet/10 text-sol-violet border-sol-violet/30"
                  : "bg-gray-500/10 text-gray-400 border-gray-500/25"
              }`}
            >
              {deviceKindLabel(d)}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <DeviceDot online={d.online} />
              {d.online ? "Online" : `Last seen ${relativeSeen(d.last_seen)}`}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-gray-500 font-mono truncate">{d.label}</div>
          <div className="mt-2 flex items-center gap-4 text-[11px] text-gray-500">
            <span>{d.platform}</span>
            <span>
              {d.local_project_roots.length} project root{d.local_project_roots.length === 1 ? "" : "s"}
            </span>
            <span className="font-mono opacity-60">{d.device_id.slice(0, 12)}</span>
          </div>
          {d.local_project_roots.length > 0 && (
            <details className="mt-2 group">
              <summary className="cursor-pointer text-[11px] text-gray-400 hover:text-gray-200 select-none">
                Show checkouts
              </summary>
              <ul className="mt-1 space-y-0.5">
                {d.local_project_roots.slice(0, 30).map((r) => (
                  <li key={r} className="text-[11px] text-gray-400 font-mono truncate">
                    {r}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <SshHostField d={d} />
        </div>
      </div>
    </Card>
  );
}

export default function DevicesSettingsPage() {
  const { devices } = useDevices();
  const sorted = useMemo(
    () =>
      [...devices].sort(
        (a, b) => Number(b.online) - Number(a.online) || Number(a.is_remote) - Number(b.is_remote) || b.last_seen - a.last_seen,
      ),
    [devices],
  );
  const onlineCount = sorted.filter((d) => d.online).length;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Devices</h1>
        <p className="text-sm text-gray-400 mt-1">
          Machines running the codecast daemon. A session runs on exactly one device. New sessions and
          messages from your phone route to your most-recently-active laptop or desktop — the{" "}
          <span className="text-sol-violet">remote Mac</span> only runs a session you explicitly move there.
        </p>
        <p className="text-[11px] text-gray-500 mt-2">
          {onlineCount} of {sorted.length} online
        </p>
      </div>

      {sorted.length === 0 ? (
        <Card className="p-6 text-center text-sm text-gray-400">
          No devices yet. Start the daemon with <code className="font-mono text-gray-300">cast daemon</code> on a machine
          to see it here.
        </Card>
      ) : (
        <div className="space-y-3">
          {sorted.map((d) => (
            <DeviceRow key={d.device_id} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}
