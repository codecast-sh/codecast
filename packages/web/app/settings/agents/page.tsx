import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Shield, SlidersHorizontal } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { SettingsOptionGroup, SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { toast } from "sonner";

type ClaudeMode = "default" | "bypass";
type CodexMode = "default" | "full_auto" | "bypass";
type GeminiMode = "default" | "bypass";

const claudeOptions: { value: ClaudeMode; label: string; description: string; flag: string }[] = [
  { value: "default", label: "Default", description: "Prompts for dangerous operations", flag: "(no extra flags)" },
  { value: "bypass", label: "Full access", description: "Every permission prompt is skipped", flag: "--permission-mode bypassPermissions" },
];

const codexOptions: { value: CodexMode; label: string; description: string; flag: string }[] = [
  { value: "default", label: "Default", description: "Prompts for every command", flag: "(no extra flags)" },
  { value: "full_auto", label: "Full auto", description: "Sandboxed, model decides when to escalate", flag: "--full-auto" },
  { value: "bypass", label: "Full access", description: "No approval prompts, no sandbox — full file and network access", flag: "-a never -s danger-full-access" },
];

const geminiOptions: { value: GeminiMode; label: string; description: string; flag: string }[] = [
  { value: "default", label: "Default", description: "Standard permission model", flag: "(no extra flags)" },
  { value: "bypass", label: "Full access", description: "Every permission prompt is skipped", flag: "(bypass flags)" },
];

export default function AgentsPage() {
  const { user } = useCurrentUser();
  const modes = user?.agent_permission_modes;
  const updateModes = useMutation(api.users.updateAgentPermissionModes);
  const defaultParams = user?.agent_default_params;
  const updateDefaultParamsMutation = useMutation(api.users.updateAgentDefaultParams);

  const claude = modes?.claude ?? "default";
  const codex = modes?.codex ?? "default";
  const gemini = modes?.gemini ?? "default";

  const handleUpdate = async (updates: {
    claude?: ClaudeMode;
    codex?: CodexMode;
    gemini?: GeminiMode;
  }) => {
    try {
      await updateModes({
        claude: updates.claude ?? claude,
        codex: updates.codex ?? codex,
        gemini: updates.gemini ?? gemini,
      });
      toast.success("Permission mode updated");
    } catch (err) {
      toast.error(`Failed to update: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const updateDefaultParams = async (args: { agent: string; params: Record<string, string> }) => {
    try {
      await updateDefaultParamsMutation({
        agent: args.agent as "claude" | "codex" | "gemini" | "cursor",
        params: args.params,
      });
    } catch (err) {
      toast.error(`Failed to update: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <SettingsPanel>
      <SettingsSection
        title="Permissions"
        icon={Shield}
        description="Control how much autonomy each agent has when running commands. Sessions managed by codecast run in tmux without a terminal attached, so restrictive modes will cause sessions to block on approval prompts."
      >
        <AgentSection
          name="Claude Code"
          current={claude}
          options={claudeOptions}
          onChange={(v) => handleUpdate({ claude: v as ClaudeMode })}
        />
        <AgentSection
          name="Codex"
          current={codex}
          options={codexOptions}
          onChange={(v) => handleUpdate({ codex: v as CodexMode })}
        />
        <AgentSection
          name="Gemini"
          current={gemini}
          options={geminiOptions}
          onChange={(v) => handleUpdate({ gemini: v as GeminiMode })}
          disabled
          note="Not yet supported for Gemini — sessions launch with Gemini's own defaults for now."
        />
      </SettingsSection>

      <SettingsSection
        title="Default Parameters"
        icon={SlidersHorizontal}
        description="Set default CLI flags for each agent. These are passed as --flag value when sessions start."
      >
        <AgentParams
          name="Claude Code"
          agent="claude"
          params={defaultParams?.claude}
          onUpdate={updateDefaultParams}
        />
        <AgentParams
          name="Codex"
          agent="codex"
          params={defaultParams?.codex}
          onUpdate={updateDefaultParams}
        />
        <AgentParams
          name="Gemini"
          agent="gemini"
          params={defaultParams?.gemini}
          onUpdate={updateDefaultParams}
        />
        <AgentParams
          name="Cursor"
          agent="cursor"
          params={defaultParams?.cursor}
          onUpdate={updateDefaultParams}
        />
      </SettingsSection>
    </SettingsPanel>
  );
}

function AgentSection({
  name,
  current,
  options,
  onChange,
  disabled,
  note,
}: {
  name: string;
  current: string;
  options: { value: string; label: string; description: string; flag: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <div className="px-4 py-3.5 sm:px-5">
      <h3 className="text-sm font-semibold text-sol-text mb-2">{name}</h3>
      <SettingsOptionGroup
        label={`${name} permission mode`}
        value={current}
        onChange={onChange}
        disabled={disabled}
        options={options.map((o) => ({ value: o.value, label: o.label, description: o.description, mono: o.flag }))}
      />
      {note && <p className="mt-2 text-xs text-sol-text-muted">{note}</p>}
    </div>
  );
}

function AgentParams({
  name,
  agent,
  params,
  onUpdate,
}: {
  name: string;
  agent: "claude" | "codex" | "gemini" | "cursor";
  params?: Record<string, string>;
  onUpdate: (args: { agent: string; params: Record<string, string> }) => Promise<void>;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const entries = Object.entries(params ?? {});

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    const key = newKey.replace(/^--/, "").trim();
    const updated = { ...(params ?? {}), [key]: newValue.trim() };
    await onUpdate({ agent, params: updated });
    setNewKey("");
    setNewValue("");
    toast.success(`Added --${key} ${newValue.trim()}`);
  };

  const handleDelete = async (key: string) => {
    const updated = { ...(params ?? {}) };
    delete updated[key];
    await onUpdate({ agent, params: updated });
    toast.success(`Removed --${key}`);
  };

  return (
    <div className="px-4 py-3.5 sm:px-5">
      <h3 className="text-sm font-semibold text-sol-text mb-2">{name}</h3>
      {entries.length > 0 ? (
        <div className="space-y-1 mb-2">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-sm font-mono">
              <span className="text-sol-text-muted">--{k}</span>
              <span className="text-sol-text">{v}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleDelete(k)}
                className="ml-auto h-6 px-2 text-xs text-sol-red hover:text-sol-red/80"
              >
                remove
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-sol-text-muted mb-2">No default params</p>
      )}
      <div className="flex gap-2 items-center">
        <Input
          type="text"
          placeholder="--flag"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          className="h-8 w-32 font-mono text-sm bg-sol-bg-alt border-sol-border text-sol-text"
        />
        <Input
          type="text"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          className="h-8 w-40 font-mono text-sm bg-sol-bg-alt border-sol-border text-sol-text"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <Button
          size="sm"
          onClick={handleAdd}
          variant="cyan" className="h-8"
        >
          Add
        </Button>
      </div>
    </div>
  );
}
