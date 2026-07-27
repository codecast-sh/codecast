"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { KeyRound, ExternalLink, Trash2, Loader2, Check } from "lucide-react";
import { PROVIDER_KEYS, type ProviderKeySpec } from "@codecast/shared/contracts";
import { Card } from "../../../components/ui/card";
import {
  useDevices,
  deviceDisplayName,
  deviceKindLabel,
  relativeSeen,
  DeviceDot,
  type Device,
} from "../../../components/DeviceBadge";
import { useProviderKeyCommand, deviceManagedKeys } from "../../../lib/useProviderKeyCommand";

/**
 * "Provider keys" — manage the optional LLM API keys codecast injects into
 * opencode/pi launches. Keys are additive: by default a client uses whatever auth is
 * already on the machine; a managed key just adds the provider's env var. Keys stay
 * on your devices — sealed to the device's public key in the browser, so Convex only
 * ever relays ciphertext, never plaintext — and this page is scoped to your primary
 * online machine (the daemon there decrypts, stores, and fans out to remotes).
 */
export default function ProviderKeysPage() {
  const { mostRecentOnlineLocal } = useDevices();
  const device = mostRecentOnlineLocal;

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <header className="flex items-start gap-3">
        <div className="mt-0.5 text-sol-cyan">
          <KeyRound className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-sol-text">Provider keys</h1>
          <p className="text-sm text-sol-base1 mt-1">
            Optional API keys for opencode and pi. They&apos;re injected as each provider&apos;s
            env var when a client launches — additive on top of the system default auth. Keys stay
            on your devices, encrypted in transit and never stored as plaintext in the cloud.
          </p>
        </div>
      </header>

      {!device ? (
        <Card className="p-6 text-center text-sm text-sol-base1">
          No online machine to manage keys on. Start the daemon with{" "}
          <code className="font-mono text-sol-text">cast daemon</code> on a machine, then manage its
          provider keys here.
        </Card>
      ) : (
        <ProviderKeyList device={device} />
      )}
    </div>
  );
}

function ProviderKeyList({ device }: { device: Device }) {
  const { pubkey, managedIds } = useMemo(() => deviceManagedKeys(device), [device]);
  const managed = useMemo(() => new Set(managedIds), [managedIds]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="inline-flex items-center gap-2 text-sm">
          <DeviceDot online={device.online} />
          <span className="font-medium text-sol-text">{deviceDisplayName(device)}</span>
          <span className="text-xs text-sol-base1">{deviceKindLabel(device)}</span>
        </div>
        <span className="text-[11px] text-sol-base1">
          {device.online ? "Online — changes apply now" : `Offline — last seen ${relativeSeen(device.last_seen)}`}
        </span>
      </div>

      {!pubkey && (
        <Card className="p-4 text-[13px] text-sol-base1">
          This machine&apos;s daemon predates managed keys. Update it with{" "}
          <code className="font-mono text-sol-text">cast update</code> to set keys from here.
        </Card>
      )}

      <div className="space-y-2.5">
        {PROVIDER_KEYS.map((spec) => (
          <ProviderKeyRow
            key={spec.id}
            spec={spec}
            device={device}
            pubkey={pubkey}
            isManaged={managed.has(spec.id)}
          />
        ))}
      </div>
    </>
  );
}

/** One provider: status, a "get a key" link, and Set/Replace + Remove actions. */
function ProviderKeyRow({
  spec,
  device,
  pubkey,
  isManaged,
}: {
  spec: ProviderKeySpec;
  device: Device;
  pubkey?: string;
  isManaged: boolean;
}) {
  const { setKey, removeKey } = useProviderKeyCommand();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const canSet = !!pubkey && device.online;

  const save = async () => {
    const key = value.trim();
    if (!key || !pubkey) return;
    setBusy(true);
    try {
      await setKey(device.device_id, pubkey, spec.id, key);
      toast.success(`${spec.label} key saved`);
      setValue("");
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save that key");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeKey(device.device_id, spec.id);
      toast.success(`${spec.label} key removed`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove that key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-sol-text">{spec.label}</span>
            {isManaged ? (
              <span className="text-[10px] px-1.5 py-px rounded-full border bg-sol-green/10 text-sol-green border-sol-green/30">
                Managed
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-px rounded-full border bg-sol-bg-alt text-sol-base1 border-sol-border">
                — system default
              </span>
            )}
          </div>
          <a
            href={spec.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-sol-base1 hover:text-sol-cyan mt-1"
          >
            get a key
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        {!editing && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => canSet && setEditing(true)}
              disabled={!canSet || busy}
              title={pubkey ? undefined : "update your daemon to manage keys here"}
              className="rounded-md border border-sol-border bg-sol-bg-alt px-2.5 py-1.5 text-xs text-sol-text hover:border-sol-cyan disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isManaged ? "Replace" : "Set"}
            </button>
            {isManaged && (
              <button
                onClick={remove}
                disabled={busy || !device.online}
                title="Remove key"
                className="inline-flex items-center rounded-md border border-sol-border bg-sol-bg-alt px-2 py-1.5 text-xs text-sol-red hover:border-sol-red disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") { setEditing(false); setValue(""); }
            }}
            placeholder={spec.keyPrefix ? `${spec.keyPrefix}…` : `${spec.label} API key`}
            className="flex-1 rounded-md border border-sol-border bg-sol-bg px-2.5 py-1.5 text-sm text-sol-text font-mono placeholder:text-sol-base01 focus:border-sol-cyan focus:outline-none"
          />
          <button
            onClick={save}
            disabled={busy || !value.trim()}
            className="inline-flex items-center gap-1 rounded-md border border-sol-cyan bg-sol-cyan/10 px-2.5 py-1.5 text-xs text-sol-cyan hover:bg-sol-cyan/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Save
          </button>
          <button
            onClick={() => { setEditing(false); setValue(""); }}
            disabled={busy}
            className="rounded-md px-2 py-1.5 text-xs text-sol-base1 hover:text-sol-text transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </Card>
  );
}
