// Settings › Connected agents (docs/architecture/agent-mcp.md). The jobs: add
// codecast to an agent (copy the address or the client's one line), see what a
// connected agent can and cannot do, and disconnect one. Rows render from the
// store (mcpConnections), fed here; Disconnect paints on the press.
import { useState } from "react";
import { Cable, Check, Copy, ShieldCheck, Unplug } from "lucide-react";
import { MCP_CAN, MCP_CANNOT, MCP_CLIENT_SETUPS, MCP_PATH } from "@codecast/shared/contracts";
import { useMcpConnections } from "../../../hooks/useMcpConnections";
import { useInboxStore } from "../../../store/inboxStore";
import type { McpConnectionRow } from "../../../store/agentConnectionsSlice";
import { formatRelativeTime } from "../../../lib/conversationFormat";
import { copyToClipboard } from "../../../lib/utils";
import { Button } from "../../../components/ui/button";
import { SegmentedToggle } from "../../../components/SegmentedToggle";
import { SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { SwitchReview } from "../../../components/consequential/ConsequentialSwitch";
import { castTokenRevokeLedger } from "../../../components/consequential/ledgers";

/** The address agents connect to: this origin when it is a web origin (codecast.sh in prod), else codecast.sh. */
function mcpAddress(): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${/^https?:\/\//.test(origin) ? origin : "https://codecast.sh"}${MCP_PATH}`;
}

function CopyBox({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch overflow-hidden rounded-lg border border-sol-border bg-sol-bg">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-3 py-2.5 font-mono text-[13px] text-sol-green" data-copy-text={label}>{text}</code>
      <button
        type="button"
        className="flex shrink-0 items-center gap-1.5 border-l border-sol-border px-3 text-[12px] text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text"
        onClick={async () => { await copyToClipboard(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-sol-green" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function ConnectedAgentsPage() {
  const address = mcpAddress();
  const [client, setClient] = useState(MCP_CLIENT_SETUPS[1].id);
  const setup = MCP_CLIENT_SETUPS.find((c) => c.id === client) ?? MCP_CLIENT_SETUPS[0];
  const { rows, ready } = useMcpConnections();
  const disconnect = useInboxStore((s) => s.disconnectAgent);
  const [revoking, setRevoking] = useState<McpConnectionRow | null>(null);

  return (
    <SettingsPanel>
      <SettingsSection title="Add codecast to an agent" icon={Cable} padded>
        <div className="space-y-3">
          <CopyBox text={address} label="address" />
          <SegmentedToggle value={client} onChange={(key) => setClient(key)} items={MCP_CLIENT_SETUPS.map((c) => ({ key: c.id, label: c.name }))} />
          {setup.command(address) !== address && <CopyBox text={setup.command(address)} label={`${setup.name} setup`} />}
          <p className="text-[12.5px] text-sol-text-muted" data-setup-then>{setup.then}</p>
        </div>
      </SettingsSection>

      <SettingsSection title="What it can do" icon={ShieldCheck} padded>
        <div className="grid grid-cols-1 gap-4 text-[13px] sm:grid-cols-2" data-mcp-access>
          <ul className="space-y-1.5">
            {MCP_CAN.map((line) => (
              <li key={line} className="flex gap-2 text-sol-text"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sol-green" />{line}</li>
            ))}
          </ul>
          <ul className="space-y-1.5">
            {MCP_CANNOT.map((line) => (
              <li key={line} className="flex gap-2 text-sol-text-muted"><span aria-hidden className="mt-[7px] h-px w-3 shrink-0 bg-sol-text-dim" />{line}</li>
            ))}
          </ul>
        </div>
      </SettingsSection>

      <SettingsSection title="Connected" icon={Unplug}>
        {rows.length === 0 ? (
          <div className="px-4 py-5 text-[13px] text-sol-text-dim" data-connections-empty>{ready ? "No agents connected" : "Loading"}</div>
        ) : (
          <ul className="divide-y divide-sol-border/60" data-connections>
            {rows.map((r) => (
              <li key={r._id} className="flex items-center gap-3 px-4 py-2.5" data-connection={r.kind}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] text-sol-text">{r.name}</div>
                  <div className="truncate text-[12px] text-sol-text-dim">
                    {r.kind === "grant" ? r.host : <span className="text-sol-orange">cast token</span>}
                    {" · "}
                    {r.last_used_at ? `read ${formatRelativeTime(r.last_used_at)}` : `connected ${formatRelativeTime(r.created_at)}`}
                  </div>
                </div>
                {r.kind === "grant" ? (
                  <Button size="sm" variant="ghost" onClick={() => disconnect("grant", r._id)} data-disconnect>Disconnect</Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(r)} data-revoke>Revoke</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {revoking && (
        <SwitchReview
          ledger={castTokenRevokeLedger({ name: revoking.name, lastRead: revoking.last_used_at ? formatRelativeTime(revoking.last_used_at) : "never" })}
          onClose={() => setRevoking(null)}
          onConfirm={() => { disconnect("cast_token", revoking._id); setRevoking(null); }}
        />
      )}
    </SettingsPanel>
  );
}
