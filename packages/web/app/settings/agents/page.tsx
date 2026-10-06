import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useInboxStore } from "../../../store/inboxStore";
import { useState } from "react";
import { Pin, Shield, SlidersHorizontal } from "lucide-react";
import { AGENT_CLIENTS, AGENT_PICKER_OPTIONS, isHostedAgentType, type AgentClientId } from "@codecast/shared/contracts";
import { useDefaultAgentType, useOnlyHostedAgent, usePinnedAgentIds } from "../../../hooks/usePinnedAgents";
import { AgentTypeIcon } from "../../../components/AgentTypeIcon";
import { Switch } from "../../../components/ui/switch";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { SelectBox } from "../../../components/ui/select-box";
import { SettingsOptionGroup, SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";
import { toast } from "sonner";

type ClaudeMode = "default" | "bypass";
type CodexMode = "default" | "full_auto" | "bypass";
type GeminiMode = "default" | "bypass";
type MuseMode = "default" | "bypass";

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

const museOptions: { value: MuseMode; label: string; description: string; flag: string }[] = [
  { value: "default", label: "Default", description: "Standard approval prompts for dangerous operations", flag: "(no extra flags)" },
  { value: "bypass", label: "Yolo", description: "No approval prompts, no sandbox, workspace trusted", flag: "--yolo" },
];

export default function AgentsPage() {
  const { user } = useCurrentUser();
  const modes = user?.agent_permission_modes;
  const defaultParams = user?.agent_default_params;

  const claude = modes?.claude ?? "default";
  const codex = modes?.codex ?? "default";
  const gemini = modes?.gemini ?? "default";
  // Muse runs yolo unless explicitly set to "default" (the daemon default),
  // so the switch shows Yolo selected when nothing is stored.
  const muse = modes?.muse ?? "bypass";

  // Both go through the store (setAgentPermissionModes / setAgentDefaultParams):
  // the choice shows now, holds over pushes, and a refusal puts it back with
  // the standard dispatch toast.
  const handleUpdate = (updates: {
    claude?: ClaudeMode;
    codex?: CodexMode;
    gemini?: GeminiMode;
    muse?: MuseMode;
  }) => {
    useInboxStore.getState().setAgentPermissionModes({
      claude: updates.claude ?? claude,
      codex: updates.codex ?? codex,
      gemini: updates.gemini ?? gemini,
      muse: updates.muse ?? muse,
    });
  };

  const updateDefaultParams = (args: { agent: string; params: Record<string, string> }) => {
    useInboxStore.getState().setAgentDefaultParams(args.agent, args.params);
  };

  return (
    <SettingsPanel>
      <PinnedAgentsSection />

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
        <AgentSection
          name="Muse Spark"
          current={muse}
          options={museOptions}
          onChange={(v) => handleUpdate({ muse: v as MuseMode })}
          note="Yolo is on unless you pick Default: managed sessions run without a terminal to answer prompts."
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
        <AgentParams
          name="Muse Spark"
          agent="muse"
          params={defaultParams?.muse}
          onUpdate={updateDefaultParams}
        />
      </SettingsSection>
    </SettingsPanel>
  );
}

/** Which agents the pickers offer. Every supported agent stays launchable from
 *  the CLI; an unpinned one still shows on a session already running it. */
function PinnedAgentsSection() {
  const pinned = usePinnedAgentIds();
  const clients = Object.values(AGENT_CLIENTS);
  const toggle = (id: AgentClientId, on: boolean) => {
    const next = clients.map((d) => d.id).filter((x) => (x === id ? on : pinned.includes(x)));
    useInboxStore.getState().setPinnedAgents(next);
  };
  return (
    <SettingsSection
      title="Pinned agents"
      icon={Pin}
      description="The agents offered when you start, switch, fork or hand off a session. Unpinned agents stay available from the CLI."
    >
      <DefaultAgentRow />
      {clients.map((d) => {
        const on = pinned.includes(d.id);
        // Switch, fork and hand-off offer local agents only, so the last
        // pinned LOCAL agent stays pinned; the hosted assistant never counts.
        const last = on && !isHostedAgentType(d.id) && pinned.filter((id) => !isHostedAgentType(id)).length === 1;
        return (
          <SettingsRow
            key={d.id}
            label={<span className="flex items-center gap-2"><AgentTypeIcon agentType={d.convexId} className="h-4 w-4" />{d.displayName}</span>}
            description={last ? "At least one local agent stays pinned." : d.pinnedByDefault === false ? "Unpinned by default." : undefined}
          >
            <Switch checked={on} disabled={last} onCheckedChange={(v) => toggle(d.id, v)} aria-label={`Pin ${d.displayName}`} />
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}

/** The agent a new conversation starts with (client_state.ui.default_agent,
 *  read through lib/defaultAgent). Hosted mode and an account with no machine
 *  always start the hosted assistant, so the row says so instead. */
function DefaultAgentRow() {
  const current = useDefaultAgentType();
  const forced = useOnlyHostedAgent();
  return (
    <SettingsRow
      label="Default agent"
      description={forced ? "Hosted mode, or no machine connected: new conversations start with the Codecast assistant." : "New conversations start with this agent unless the one on screen runs another."}
    >
      <SelectBox
        value={current}
        disabled={forced}
        onChange={(e) => useInboxStore.getState().updateClientUI({ default_agent: e.target.value })}
        aria-label="Default agent"
      >
        {AGENT_PICKER_OPTIONS.map((o) => (
          <option key={o.id} value={o.convexType}>{o.label}</option>
        ))}
      </SelectBox>
    </SettingsRow>
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
  agent: "claude" | "codex" | "gemini" | "cursor" | "muse";
  params?: Record<string, string>;
  onUpdate: (args: { agent: string; params: Record<string, string> }) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const entries = Object.entries(params ?? {});

  const handleAdd = () => {
    if (!newKey.trim() || !newValue.trim()) return;
    const key = newKey.replace(/^--/, "").trim();
    onUpdate({ agent, params: { ...(params ?? {}), [key]: newValue.trim() } });
    setNewKey("");
    setNewValue("");
  };

  const handleDelete = (key: string) => {
    const updated = { ...(params ?? {}) };
    delete updated[key];
    onUpdate({ agent, params: updated });
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
