// The agent dock's setting: on or off for this machine, and which edge.
import { useState } from "react";
import { PanelRight } from "lucide-react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { getAgentDock, setAgentDock, type AgentDockConfig } from "../../lib/desktopAgentDock";
import { SettingsOptionGroup, SettingsSection } from "./ui";

export function AgentDockSection() {
  const [cfg, setCfg] = useState<AgentDockConfig | null>(null);
  useMountEffect(() => { void getAgentDock().then(setCfg); });

  const patch = async (next: Partial<Pick<AgentDockConfig, "enabled" | "edge">>) => {
    const saved = await setAgentDock(next);
    if (saved) setCfg((prev) => (prev ? { ...prev, ...saved } : prev));
  };

  // Absent in a browser and on desktop builds older than the dock.
  if (!cfg?.supported) return null;

  return (
    <SettingsSection
      title="Agent dock"
      icon={PanelRight}
      description="A pill on the edge of your screen with a dot for every agent. Click it, or press its shortcut, to answer the ones waiting on you without opening Codecast."
      padded
    >
      <div className="space-y-3">
        <SettingsOptionGroup
          label="Dock"
          variant="pill"
          value={cfg.enabled ? cfg.edge : "off"}
          onChange={(v) => patch(v === "off" ? { enabled: false } : { enabled: true, edge: v as AgentDockConfig["edge"] })}
          options={[
            { value: "off", label: "Off" },
            { value: "right", label: "Right edge" },
            { value: "left", label: "Left edge" },
          ]}
        />
        <p className="text-xs text-sol-text-dim">
          Answers, discards and kills from the dock wait two seconds before they happen. Press Esc in that time to take one back.
        </p>
      </div>
    </SettingsSection>
  );
}
