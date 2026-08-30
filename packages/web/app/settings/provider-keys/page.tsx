"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { KeyRound, ExternalLink, Trash2, Loader2, Check } from "lucide-react";
import { PROVIDER_KEYS, type ProviderKeySpec } from "@codecast/shared/contracts";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { DevicePanelHeader } from "../../../components/settings/DevicePanelHeader";
import { useDevices, type Device } from "../../../components/DeviceBadge";
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
    <SettingsPanel>
      {!device ? (
        <SettingsSection title="Provider keys" icon={KeyRound} padded>
          <p className="text-center text-sm text-sol-text-muted">
            No online machine to manage keys on. Start the daemon with{" "}
            <code className="font-mono text-sol-text">cast daemon</code> on a machine, then manage its
            provider keys here.
          </p>
        </SettingsSection>
      ) : (
        <ProviderKeyList device={device} />
      )}
    </SettingsPanel>
  );
}

function ProviderKeyList({ device }: { device: Device }) {
  const { pubkey, managedIds } = useMemo(() => deviceManagedKeys(device), [device]);
  const managed = useMemo(() => new Set(managedIds), [managedIds]);

  return (
    <>
      <DevicePanelHeader selected={device} />

      <SettingsSection
        title="Providers"
        icon={KeyRound}
        description={
          <>
            Optional API keys for opencode and pi. They&apos;re injected as each provider&apos;s
            env var when a client launches — additive on top of the system default auth. Keys stay
            on your devices, encrypted in transit and never stored as plaintext in the cloud.
          </>
        }
      >
        {!pubkey && (
          <div className="px-4 py-3.5 text-[13px] text-sol-text-muted sm:px-5">
            This machine&apos;s daemon predates managed keys. Update it with{" "}
            <code className="font-mono text-sol-text">cast update</code> to set keys from here.
          </div>
        )}
        {PROVIDER_KEYS.map((spec) => (
          <ProviderKeyRow
            key={spec.id}
            spec={spec}
            device={device}
            pubkey={pubkey}
            isManaged={managed.has(spec.id)}
          />
        ))}
      </SettingsSection>
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
    <div className="px-4 py-3.5 sm:px-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-sol-text">{spec.label}</span>
            {isManaged ? (
              <span className="text-[10px] px-1.5 py-px rounded-full border bg-sol-green/10 text-sol-green border-sol-green/30">
                Managed
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-px rounded-full border bg-sol-bg-alt text-sol-text-muted border-sol-border">
                — system default
              </span>
            )}
          </div>
          <a
            href={spec.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-sol-text-muted hover:text-sol-cyan mt-1"
          >
            get a key
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>

        {!editing && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => canSet && setEditing(true)}
              disabled={!canSet || busy}
              title={pubkey ? undefined : "update your daemon to manage keys here"}
            >
              {isManaged ? "Replace" : "Set"}
            </Button>
            {isManaged && (
              <Button
                variant="outline"
                size="sm"
                onClick={remove}
                disabled={busy || !device.online}
                aria-label="Remove key"
                title="Remove key"
                className="px-2 text-sol-red hover:border-sol-red hover:text-sol-red"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              </Button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-3 flex items-center gap-2">
          <Input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") { setEditing(false); setValue(""); }
            }}
            placeholder={spec.keyPrefix ? `${spec.keyPrefix}…` : `${spec.label} API key`}
            className="h-8 flex-1 font-mono bg-sol-bg border-sol-border"
          />
          <Button
            size="sm"
            onClick={save}
            disabled={busy || !value.trim()}
            variant="cyan"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setEditing(false); setValue(""); }}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
