"use client";

import { copyToClipboard } from "../../../lib/utils";
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

type RepoPlane = NonNullable<Device["git_plane"]>[number];

function repoTone(r: RepoPlane): { dot: string; label?: string } {
  if (r.needs_access) return { dot: "bg-sol-yellow", label: "needs access" };
  if (!r.origin_ok) return { dot: "bg-sol-red", label: "no usable origin" };
  if (r.fetch_ok === false) return { dot: "bg-sol-red", label: "fetch failing" };
  return { dot: "bg-sol-green" };
}

function repoBase(root: string): string {
  return root.split("/").filter(Boolean).pop() ?? root;
}

/** One repo's git health on a device: dot, name, branch, drift, identity. */
function RepoPlaneRow({ r }: { r: RepoPlane }) {
  const tone = repoTone(r);
  return (
    <li className="flex items-center gap-2 text-[11px] min-w-0">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} />
      <span className="font-mono text-gray-300 truncate">{repoBase(r.root)}</span>
      {r.branch && <span className="text-gray-500 truncate">{r.branch}</span>}
      {(r.ahead ?? 0) > 0 && <span className="text-sol-cyan shrink-0">↑{r.ahead}</span>}
      {(r.behind ?? 0) > 0 && <span className="text-sol-orange shrink-0">↓{r.behind}</span>}
      {r.identity === "device" && (
        <span className="px-1 py-px rounded border border-sol-violet/30 bg-sol-violet/10 text-sol-violet shrink-0">
          device key
        </span>
      )}
      {tone.label && <span className="text-sol-yellow shrink-0">{tone.label}</span>}
      {r.repaired_from && <span className="text-gray-500 shrink-0" title={`origin was ${r.repaired_from}`}>origin repaired</span>}
    </li>
  );
}

/**
 * The grant-access flow, productized: when a device cannot fetch a repo for
 * lack of credentials, its daemon mints a keypair and heartbeats the PUBLIC
 * half; this card shows it with copy-paste guidance. Recovery needs no further
 * action — the daemon retries on its cadence and the rows above turn green.
 */
function GrantAccessCard({ d, blocked }: { d: Device; blocked: RepoPlane[] }) {
  const [copied, setCopied] = useState(false);
  if (!blocked.length) return null;
  const repoNames = blocked.map((r) => repoBase(r.root)).join(", ");
  return (
    <div className="mt-2 rounded-md border border-sol-yellow/30 bg-sol-yellow/5 p-3 space-y-2">
      <div className="text-[11px] text-sol-yellow font-medium">
        This machine needs access to {repoNames}
      </div>
      {d.git_pubkey ? (
        <>
          <p className="text-[11px] text-gray-400">
            Add its key on GitHub — either your account&apos;s{" "}
            <a href="https://github.com/settings/ssh/new" target="_blank" rel="noreferrer" className="text-sol-blue hover:underline">
              SSH keys
            </a>{" "}
            (grants everything you can reach) or the repo&apos;s deploy keys with write access
            (grants just that repo). It starts working within minutes; nothing else to run.
          </p>
          <div className="flex items-start gap-2">
            <code className="flex-1 text-[10px] font-mono text-gray-300 bg-black/20 rounded px-2 py-1.5 break-all select-all">
              {d.git_pubkey}
            </code>
            <button
              type="button"
              onClick={() => {
                void copyToClipboard(d.git_pubkey!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="shrink-0 px-2 py-1 rounded border border-sol-border text-[11px] text-gray-300 hover:bg-sol-card"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </>
      ) : (
        <p className="text-[11px] text-gray-400">
          Its remotes need credentials this machine doesn&apos;t have (an https remote wants a
          token, or the machine can&apos;t mint an SSH key). Sign in to git on that machine, or
          switch the repo&apos;s origin to an SSH URL so a device key can be granted here.
        </p>
      )}
    </div>
  );
}

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
          {(d.git_plane?.length ?? 0) > 0 && (
            <ul className="mt-2 space-y-1">
              {d.git_plane!.map((r) => (
                <RepoPlaneRow key={r.root} r={r} />
              ))}
            </ul>
          )}
          <GrantAccessCard d={d} blocked={(d.git_plane ?? []).filter((r) => r.needs_access)} />
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
          messages from your phone route to your most-recently-active laptop or desktop — a{" "}
          <span className="text-sol-violet">cloud box</span> only runs a session you explicitly move there,
          and wakes from sleep when you do.
        </p>
        <p className="text-[11px] text-gray-500 mt-2">
          {onlineCount} of {sorted.length} online
          {sorted.length > 0 && (
            <>
              {" · "}
              <a href="/settings/cli" className="text-sol-yellow hover:text-sol-yellow/80">
                connect a machine
              </a>
            </>
          )}
        </p>
      </div>

      {sorted.length === 0 ? (
        <Card className="p-6 text-center text-sm text-gray-400">
          No devices yet. Install the CLI on a machine to see it here —{" "}
          <a href="/settings/cli" className="text-sol-yellow hover:text-sol-yellow/80">
            get the install command
          </a>
          . Already installed? Start it with <code className="font-mono text-gray-300">cast start</code>.
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
