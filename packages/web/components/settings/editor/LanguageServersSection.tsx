// Settings > Editor, Language servers: for one vault at a time, every server
// the daemon knows, whether this machine has it (and where), and the command
// that installs a missing one, ready to copy. A project's own node_modules
// copy can make a server available in one vault and not another, hence the
// vault picker (Files' active vault first).

import { useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import type { LspServerInfo, LspServersResponse, VaultInfo } from "@codecast/shared/contracts";
import { SettingsBadge, SettingsSection } from "../ui";
import { copyToClipboard, shortenHome } from "../../../lib/utils";
import { SelectBox } from "../../ui/select-box";
import { useVaultStore } from "../../../store/vaultStore";
import { listVaults, loopbackFetch } from "../../../lib/vault/client";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import type { EndpointState } from "./useEditorEndpoint";

/** One vault's answer; an answer for another vault reads as loading. */
type Load = { vaultId: string | null } & ({ status: "loading" } | { status: "ok"; servers: LspServerInfo[] } | { status: "error"; message: string });

/** The install command alone: the daemon's hint reads "Install it with: <cmd>". */
export function installCommand(hint: string): string {
  return hint.replace(/^install it with:\s*/i, "").trim();
}

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void copyToClipboard(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="group flex min-w-0 items-center gap-1.5 rounded bg-sol-bg-highlight/40 px-1.5 py-0.5 text-left hover:bg-sol-bg-highlight/70"
      title="Copy"
    >
      <code className="truncate font-mono text-xs text-sol-text">{text}</code>
      {copied ? <Check className="h-3 w-3 shrink-0 text-sol-green" /> : <Copy className="h-3 w-3 shrink-0 text-sol-text-dim group-hover:text-sol-text" />}
    </button>
  );
}

export function LanguageServersSection({ endpoint }: { endpoint: EndpointState }) {
  const storeVaults = useVaultStore((s) => s.vaults);
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const ep = endpoint.status === "ready" ? endpoint.ep : null;
  // Files may not have listed the vaults on this page load: ask the daemon.
  const [listed, setListed] = useState<VaultInfo[] | null>(null);
  useWatchEffect(() => {
    if (!ep || storeVaults.length) return;
    let live = true;
    listVaults(ep).then((v) => live && setListed(v), () => {});
    return () => {
      live = false;
    };
  }, [ep, storeVaults.length]);
  const vaults = storeVaults.length ? storeVaults : (listed ?? []);
  const [picked, setPicked] = useState<string | null>(null);
  const vaultId = picked ?? activeVaultId ?? vaults[0]?.id ?? null;
  const [loaded, setLoad] = useState<Load>({ vaultId: null, status: "loading" });
  const load: Load = loaded.vaultId === vaultId ? loaded : { vaultId, status: "loading" };
  const [nonce, setNonce] = useState(0);

  useWatchEffect(() => {
    if (!ep || !vaultId) return;
    let live = true;
    loopbackFetch(ep, `/lsp/servers?vault=${encodeURIComponent(vaultId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`language servers: ${res.status}`);
        const body = (await res.json()) as LspServersResponse;
        if (live) setLoad({ vaultId, status: "ok", servers: body.servers ?? [] });
      })
      .catch((e) => live && setLoad({ vaultId, status: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [ep, vaultId, nonce]);

  const servers = load.status === "ok" ? load.servers : [];
  const available = servers.filter((s) => s.available).length;

  return (
    <SettingsSection
      title="Language servers"
      actions={
        vaultId ? (
          <span className="flex items-center gap-2">
            {vaults.length > 1 && (
              <SelectBox
                aria-label="Vault"
                value={vaultId ?? ""}
                onChange={(e) => setPicked(e.target.value)}
                wrapperClassName="max-w-[14rem]"
                className="h-7 font-mono text-xs"
              >
                {vaults.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name || v.root}
                  </option>
                ))}
              </SelectBox>
            )}
            {load.status === "ok" && (
              <span className="font-mono text-xs tabular-nums text-sol-text-dim" title={`${available} of ${servers.length} available`}>
                {available}/{servers.length}
              </span>
            )}
            <button
              type="button"
              onClick={() => setNonce((n) => n + 1)}
              className="rounded p-1 text-sol-text-dim hover:bg-sol-bg-highlight/50 hover:text-sol-text"
              title="Check again"
              aria-label="Check language servers again"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </span>
        ) : null
      }
    >
      {endpoint.status === "offline" ? (
        <div className="px-5 py-3">
          <SettingsBadge tone="red">daemon offline</SettingsBadge>
        </div>
      ) : !vaultId ? (
        <div className="px-5 py-3 text-xs text-sol-text-dim">{ep && listed ? "No vaults" : "checking…"}</div>
      ) : load.status === "error" ? (
        <div className="truncate px-5 py-3 text-xs text-sol-red" title={load.message}>
          {load.message}
        </div>
      ) : load.status === "loading" ? (
        <div className="px-5 py-3 text-xs text-sol-text-dim">checking…</div>
      ) : (
        <ul className="divide-y divide-sol-border/30">
          {servers.map((s) => (
            <li key={s.id} className="grid grid-cols-[9rem_minmax(0,1fr)_auto] items-center gap-4 px-4 py-2 sm:px-5">
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm text-sol-text">
                  {s.running && <span className="h-1.5 w-1.5 rounded-full bg-sol-green" title="Running" />}
                  <span className="truncate">{s.name}</span>
                </span>
                <span className="block truncate font-mono text-meta text-sol-text-dim" title={s.languages.join(", ")}>
                  {s.languages.join(" ")}
                </span>
              </span>
              <span className="min-w-0">
                {s.available ? (
                  <span className="block truncate font-mono text-xs text-sol-text-muted" title={s.command}>
                    {s.command ? shortenHome(s.command) : ""}
                  </span>
                ) : s.install_hint ? (
                  <CopyText text={installCommand(s.install_hint)} />
                ) : null}
              </span>
              <SettingsBadge tone={s.available ? "green" : "muted"}>{s.available ? "available" : "missing"}</SettingsBadge>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
