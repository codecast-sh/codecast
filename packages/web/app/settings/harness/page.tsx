"use client";

import { useState } from "react";
import { FileClock, MessageSquareText, Unplug } from "lucide-react";
import type { HarnessHook } from "@codecast/shared/contracts";
import { useInboxStore } from "../../../store/inboxStore";
import { AGENT_HOOKS, FUNCTIONAL_HOOKS, deviceHookInstalled, hookFeatureName } from "../../../lib/harnessHooksView";
import { Switch } from "../../../components/ui/switch";
import { Button } from "../../../components/ui/button";
import {
  SettingsCallout,
  SettingsOptionGroup,
  SettingsRow,
  SettingsSection,
} from "../../../components/settings/ui";
import { DeviceSettingsFrame } from "../../../components/settings/DeviceSettingsFrame";
import { useDeviceSettingsPanel } from "../../../components/settings/useDeviceSettingsPanel";
import { relativeSeen, type Device } from "../../../components/DeviceBadge";
import { useHarnessChanges, type HarnessChangeRow } from "../../../hooks/useHarnessChanges";
import { setHooksReminderHidden, useHooksReminderHidden } from "../../../lib/hooksReminder";

/**
 * Harness: what codecast puts into a machine's agent setup, and a record of
 * every change it made there. The hooks are one switch: codecast installs them
 * unless you turn them off, and once off no update or refresh puts them back.
 * The history lists every write to CLAUDE.md, AGENTS.md, hook scripts and
 * ~/.claude/settings.json, with the action that caused it, so a change you did
 * not make is never a mystery.
 */
export default function HarnessPage() {
  const panel = useDeviceSettingsPanel();
  return (
    <DeviceSettingsFrame panel={panel} title="Harness" icon={Unplug}>
      {(d) => (
        <>
          <HooksSection d={d} panel={panel} />
          <AgentHooksSection d={d} />
          <HistorySection d={d} />
        </>
      )}
    </DeviceSettingsFrame>
  );
}

function HooksSection({ d, panel }: { d: Device; panel: ReturnType<typeof useDeviceSettingsPanel> }) {
  const { pending, run, setSnippet } = panel;
  const [confirming, setConfirming] = useState(false);
  const reminderHidden = useHooksReminderHidden(d.device_id);
  // A daemon from before the switch reports no value; its hooks are always on
  // and it cannot take the command, so the control waits for an update.
  const known = d.settings?.hooks_enabled !== undefined;
  const on = d.settings?.hooks_enabled !== false;
  const busy = pending.has("hooks");
  const apply = (enabled: boolean) =>
    run("hooks", () => setSnippet({ device_id: d.device_id, snippet: "hooks", enabled })).then(() => setConfirming(false));

  return (
    <SettingsSection
      title="Codecast hooks"
      icon={Unplug}
      description={
        <>
          Scripts codecast registers in Claude Code&apos;s{" "}
          <code className="font-mono text-sol-text-muted">~/.claude/settings.json</code>. They are how codecast
          learns what your sessions are doing, and they print nothing the agent reads. Hooks you added
          yourself are never touched.
        </>
      }
    >
      <SettingsRow
        label="Install codecast hooks"
        description={
          !known
            ? "This machine's CLI installs them on every update and cannot turn them off. Update it with cast update to get this switch."
            : on
              ? "On. Codecast keeps them current when it updates."
              : "Off. No update or refresh installs them until you turn this back on."
        }
      >
        <Switch
          checked={on}
          disabled={!known || !d.online || busy}
          onCheckedChange={(next) => (next ? void apply(true) : setConfirming(true))}
          aria-label="Install codecast hooks"
        />
      </SettingsRow>

      {confirming && (
        <div className="px-4 pb-4 sm:px-5">
          <SettingsCallout tone="warning">
            <p className="font-medium">Turning the hooks off on this machine changes these:</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              {FUNCTIONAL_HOOKS.map((h) => (
                <li key={h.file}>{h.withoutIt}</li>
              ))}
            </ul>
            <p className="mt-1.5">
              The thread state and task reminders go too. To stop only what the agent sees, turn those
              features off in Agent Features instead and keep these on.
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void apply(false)}>
                Turn off hooks
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Keep them
              </Button>
            </div>
          </SettingsCallout>
        </div>
      )}

      {known && !on && (
        <SettingsRow
          label="Remind me in sessions"
          description="A small mark in the header of each session on this machine, while its hooks are off. Stored in this browser."
        >
          <Switch
            checked={!reminderHidden}
            onCheckedChange={(show) => setHooksReminderHidden(d.device_id, !show)}
            aria-label="Remind me in sessions"
          />
        </SettingsRow>
      )}

      {FUNCTIONAL_HOOKS.map((h) => (
        <HookRow key={h.file} hook={h} installed={deviceHookInstalled(d, h)} />
      ))}
    </SettingsSection>
  );
}

/**
 * The hooks that put text in front of the agent. Each belongs to an Agent
 * Features entry, and that entry's switch adds or removes it together with the
 * entry's CLAUDE.md section, so this section explains and points there.
 */
function AgentHooksSection({ d }: { d: Device }) {
  return (
    <SettingsSection
      title="Hooks that shape the agent"
      icon={MessageSquareText}
      description="These add text the agent reads, or hold a turn open for one more step. Each one belongs to a feature in Agent Features: turn the feature off there and its hook goes with it."
      actions={
        <Button size="sm" variant="ghost" onClick={() => useInboxStore.getState().openSettingsModal("agent-features")}>
          Agent Features
        </Button>
      }
    >
      {AGENT_HOOKS.map((h) => (
        <HookRow key={h.file} hook={h} installed={deviceHookInstalled(d, h)} owner={hookFeatureName(h)} />
      ))}
    </SettingsSection>
  );
}

function HookRow({ hook: h, installed, owner }: { hook: HarnessHook; installed: boolean; owner?: string | null }) {
  return (
    <SettingsRow
      alignTop
      label={
        <span className="flex flex-wrap items-center gap-2">
          {h.name}
          <span
            className={`text-[10px] px-1.5 py-px rounded-full border ${
              installed
                ? "bg-sol-green/10 text-sol-green border-sol-green/30"
                : "bg-sol-bg-alt text-sol-text-muted border-sol-border"
            }`}
          >
            {installed ? "Installed" : "Off"}
          </span>
          {owner && <span className="text-[11px] font-normal text-sol-text-muted">part of {owner}</span>}
        </span>
      }
      description={
        <>
          {h.purpose}
          <span className="mt-1.5 block leading-relaxed">
            <span className="text-sol-text-muted">Without it: </span>
            {h.withoutIt}
          </span>
          <span className="mt-1.5 block font-mono text-[11px] text-sol-text-dim">
            ~/.claude/hooks/{h.file}
            {h.events.length > 0 ? ` on ${h.events.join(", ")}` : h.kind === "statusLine" ? " as the statusLine command" : " (runs inside the prompt hook)"}
          </span>
        </>
      }
    >
      <span />
    </SettingsRow>
  );
}

const ACTION_VERB: Record<HarnessChangeRow["action"], string> = {
  created: "Created",
  modified: "Changed",
  removed: "Removed",
};

// "section:memory" -> "memory section"; the rest read as they are.
function whatLabel(what: string): string {
  if (what.startsWith("section:")) return `${what.slice(8)} section`;
  if (what.startsWith("capability:")) return `capability ${what.slice(11)}`;
  if (what.startsWith("skill:")) return `skill ${what.slice(6)}`;
  return what;
}

function HistorySection({ d }: { d: Device }) {
  const { rows, ready } = useHarnessChanges(d.device_id);
  const [filter, setFilter] = useState<"all" | "automatic">("all");
  const shown = filter === "automatic" ? rows.filter((r) => r.automatic) : rows;

  return (
    <SettingsSection
      title="Change history"
      icon={FileClock}
      description="Every change codecast made to this machine's agent setup, newest first. Automatic means nobody asked for it at that moment: an update, a team setting, or your default model."
      actions={
        <SettingsOptionGroup
          variant="pill"
          label="Show"
          value={filter}
          onChange={(v) => setFilter(v as "all" | "automatic")}
          options={[
            { value: "all", label: "All" },
            { value: "automatic", label: "Automatic" },
          ]}
        />
      }
    >
      {shown.length === 0 ? (
        <p className="px-4 py-4 text-sm text-sol-text-muted sm:px-5">
          {!ready && rows.length === 0
            ? "Loading…"
            : filter === "automatic" && rows.length > 0
              ? "No automatic changes. Everything listed was something you or an agent asked for."
              : "No changes recorded yet. The history starts when this machine runs a CLI that records them."}
        </p>
      ) : (
        <ol className="divide-y divide-sol-border/60">
          {shown.map((c) => (
            <li key={c._id} className="flex gap-3 px-4 py-2.5 sm:px-5">
              <span
                className="w-16 shrink-0 pt-px text-[11px] tabular-nums text-sol-text-dim"
                title={new Date(c.at).toLocaleString()}
              >
                {relativeSeen(c.at)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-sol-text">
                  {ACTION_VERB[c.action]} <code className="font-mono text-[11px] text-sol-text">{c.file}</code>
                  <span className="text-sol-text-muted"> · {whatLabel(c.what)}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-sol-text-muted">
                  {c.why}
                  <span className="text-sol-text-dim"> · v{c.version}</span>
                </p>
              </div>
              <span
                className={`h-fit shrink-0 text-[10px] px-1.5 py-px rounded-full border ${
                  c.automatic
                    ? "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/30"
                    : "bg-sol-bg-alt text-sol-text-muted border-sol-border"
                }`}
              >
                {c.automatic ? "Automatic" : "Requested"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </SettingsSection>
  );
}
