// Settings > Agents > New sessions: where and how a new session starts when
// the person has not said otherwise in the composer. Each value is a stamped
// client_state.ui key (@codecast/shared/contracts newSessionDefaults), so it
// follows them to every device; "Last used" clears it.
import { Bot, FolderGit2, Monitor, Sparkles } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { AGENT_PICKER_OPTIONS, THIS_DEVICE, deviceDisplayName } from "@codecast/shared/contracts";
import { useInboxStore, type ClientUI } from "../../store/inboxStore";
import { useOnlyHostedAgent } from "../../hooks/usePinnedAgents";
import { SelectBox } from "../ui/select-box";
import { listedMachines } from "../../lib/machinePicker";
import { machineChipNote, type SessionMachine } from "../../lib/sessionMachines";
import { SettingsRow, SettingsSection } from "./ui";

const LAST_USED = "";

const repoLabel = (path: string) => path.split("/").filter(Boolean).pop() || path;

function DefaultSelect({ label, icon, field, value, options, disabled }: {
  label: string;
  icon: typeof Bot;
  field: "default_device" | "default_agent" | "default_project";
  value: string | null | undefined;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  const current = value ?? LAST_USED;
  // A saved value the list no longer offers (a removed machine, a folder out
  // of the recents) still shows as what it is, so the control never lies.
  const all = current && !options.some((o) => o.value === current) ? [...options, { value: current, label: repoLabel(current) }] : options;
  return (
    <SettingsRow label={label} icon={icon} disabled={disabled}>
      <SelectBox
        value={current}
        disabled={disabled}
        aria-label={`Default ${label.toLowerCase()} for new sessions`}
        onChange={(e) => useInboxStore.getState().updateClientUI({ [field]: e.target.value || null } as Partial<ClientUI>)}
      >
        <option value={LAST_USED}>Last used</option>
        {all.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </SelectBox>
    </SettingsRow>
  );
}

export function NewSessionDefaultsSection() {
  const ui = useInboxStore(useShallow((s) => ({
    device: s.clientState.ui?.default_device,
    agent: s.clientState.ui?.default_agent,
    project: s.clientState.ui?.default_project,
  })));
  // The machines the composer's row lists, named the way its chips are.
  const roster = useInboxStore((s) => s.machineRoster) as SessionMachine[];
  const projects = useInboxStore(useShallow((s) => s.recentProjects.map((p) => p.path)));
  const onlyHosted = useOnlyHostedAgent();
  const named = listedMachines(roster, ui.device).map((d) => {
    const note = machineChipNote(d, roster) ?? (d.online ? null : "offline");
    return { value: d.device_id, label: note ? `${deviceDisplayName(d)} · ${note}` : deviceDisplayName(d) };
  });
  const deviceOptions = [
    { value: THIS_DEVICE, label: "This device" },
    // Names that still collide (several hosts in one region) get their id.
    ...named.map((o) => (named.filter((x) => x.label === o.label).length > 1 ? { ...o, label: `${o.label} · ${o.value.slice(0, 6)}` } : o))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
  return (
    <SettingsSection title="New sessions" icon={Sparkles}>
      <DefaultSelect label="Device" icon={Monitor} field="default_device" value={ui.device} options={deviceOptions} />
      <DefaultSelect label="Agent" icon={Bot} field="default_agent" value={ui.agent} disabled={onlyHosted}
        options={AGENT_PICKER_OPTIONS.map((o) => ({ value: o.convexType, label: o.label }))} />
      <DefaultSelect label="Project" icon={FolderGit2} field="default_project" value={ui.project}
        options={projects.map((p) => ({ value: p, label: projects.filter((q) => repoLabel(q) === repoLabel(p)).length > 1 ? p : repoLabel(p) }))} />
    </SettingsSection>
  );
}
