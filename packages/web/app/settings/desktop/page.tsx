import { useState, useCallback, useRef } from "react";
import { Info, Keyboard, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useOsPermissions } from "../../../hooks/useOsPermissions";
import { OS_PERMISSION_KINDS } from "../../../lib/osPermissions";
import { PermissionRow } from "../../../components/permissions/PermissionRow";
import { openDeviceSetup } from "../../../lib/deviceSetup";
import { useEventListener } from "../../../hooks/useEventListener";
import { useMountEffect } from "../../../hooks/useMountEffect";
import {
  isElectron,
  bridge,
  getAppVersion,
  checkDesktopUpdate,
  onUpdateStatus,
  restartForUpdate,
  checkForUpdate,
  DESKTOP_SHORTCUTS,
} from "../../../lib/desktop";
import { MeetingDetectSection } from "../../../components/settings/MeetingDetectSection";
import { useDesktopSettings, refreshDesktopSettings } from "../../../hooks/useDesktopSettings";
import { Button } from "../../../components/ui/button";
import { KeyCap } from "../../../components/KeyboardShortcutsHelp";
import { SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";
import { formatAcceleratorParts } from "../../../shortcuts";

function ShortcutRecorder({
  value,
  onChange,
}: {
  value: string;
  onChange: (accelerator: string) => void;
}) {
  const [recording, setRecording] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        setRecording(false);
        return;
      }

      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;

      let key: string;
      if (e.code === "Space") {
        key = "Space";
      } else if (e.key === "Dead" || e.key.length === 1 || e.key === "\u00A0") {
        key = e.code.replace(/^Key/, "").replace(/^Digit/, "");
      } else {
        key = e.key;
      }

      const parts: string[] = [];
      if (e.ctrlKey && !e.metaKey) parts.push("Control");
      if (e.metaKey) parts.push("CommandOrControl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      parts.push(key);

      if (parts.length < 2) return;

      setRecording(false);
      onChange(parts.join("+"));
    },
    [recording, onChange]
  );

  useEventListener("keydown", handleKeyDown, recording ? document : null, { capture: true });

  return (
    <button
      onClick={() => setRecording(!recording)}
      className={`px-3 py-1.5 rounded-md border text-sm transition-colors min-w-[140px] ${
        recording
          ? "border-sol-cyan bg-sol-cyan/10 text-sol-cyan animate-pulse"
          : "border-sol-border bg-sol-bg-alt text-sol-text hover:border-sol-text-dim"
      }`}
    >
      {recording ? (
        "Press shortcut..."
      ) : value ? (
        <span className="flex items-center justify-center gap-[3px]">
          {formatAcceleratorParts(value).map((part, i) => (
            <KeyCap key={i}>{part}</KeyCap>
          ))}
        </span>
      ) : (
        <span className="text-sol-text-dim">Not set</span>
      )}
    </button>
  );
}

// At-a-glance version readout + update control, mirroring the global banner's
// state machine (DesktopProvider) but as a passive settings row. Reflects the
// in-process updater's live IPC status (downloading % / ready) when present.
function DesktopVersionRow() {
  const [current, setCurrent] = useState<string | null>(null);
  const [available, setAvailable] = useState<string | null>(null);
  const [ipc, setIpc] = useState<{ status: string; version?: string; percent?: number } | null>(null);
  const [checking, setChecking] = useState(false);

  useMountEffect(() => {
    getAppVersion().then(setCurrent);
    checkDesktopUpdate().then((u) => setAvailable(u?.latest ?? null));
    onUpdateStatus(setIpc);
  });

  const ready = ipc?.status === "ready";
  const downloading = ipc?.status === "downloading";
  const latest = ipc?.version ?? available;

  let statusLine: string;
  if (ready) statusLine = `v${latest} is ready to install`;
  else if (downloading) statusLine = `Downloading v${latest}… ${ipc?.percent ?? 0}%`;
  else if (latest) statusLine = `v${latest} is available`;
  else if (checking) statusLine = "Checking for updates…";
  else statusLine = "You're on the latest version";

  const runCheck = () => {
    setChecking(true);
    checkForUpdate({ manual: true });
    // Re-poll the feed so the at-rest "available" readout refreshes even if the
    // in-process updater isn't present (older build) and emits no IPC.
    setTimeout(() => {
      checkDesktopUpdate().then((u) => setAvailable(u?.latest ?? null));
      setChecking(false);
    }, 4000);
  };

  return (
    <SettingsRow
      label="Codecast Desktop"
      description={current ? `Version ${current} — ${statusLine}` : statusLine}
    >
      {ready ? (
        <Button size="sm" onClick={() => restartForUpdate()} variant="cyan">
          Restart now
        </Button>
      ) : downloading ? (
        <span className="text-xs text-sol-cyan">{ipc?.percent ?? 0}%</span>
      ) : latest ? (
        <Button size="sm" onClick={() => checkForUpdate({ manual: false })} variant="cyan">
          Update now
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={runCheck} disabled={checking}>
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      )}
    </SettingsRow>
  );
}


// Every OS-level permission this Mac has decided about Codecast, with the
// fix in reach. Hidden on shells too old to report them (all unknown).
function PermissionsSection() {
  const { permissions, refresh } = useOsPermissions();
  if (OS_PERMISSION_KINDS.every((k) => permissions[k] === "unknown")) return null;
  return (
    <SettingsSection
      title="Permissions"
      icon={ShieldCheck}
      description="What macOS lets Codecast do on this Mac. Changes made in System Settings show up here on their own."
      actions={
        <Button size="sm" variant="outline" onClick={openDeviceSetup}>
          Run setup again
        </Button>
      }
    >
      {OS_PERMISSION_KINDS.map((k) => (
        <PermissionRow key={k} kind={k} readiness={permissions[k]} onChange={refresh} />
      ))}
    </SettingsSection>
  );
}

export default function DesktopSettingsPage() {
  const cfg = useDesktopSettings();
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "" removes the binding; the default value restores it. Re-fetch the full
  // config afterward so registration conflicts (issues) reflect the new state.
  const updateShortcut = useCallback(async (key: string, accelerator: string) => {
    if (!isElectron()) return;
    await bridge("setShortcut")?.(key, accelerator);
    await refreshDesktopSettings();
    setSaved(key);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(null), 1500);
  }, []);

  if (!isElectron()) {
    return (
      <div className="text-sol-text-dim text-sm py-8 text-center">
        Desktop settings are only available in the Codecast desktop app.
      </div>
    );
  }

  return (
    <SettingsPanel>
      <SettingsSection
        title="About"
        icon={Info}
        description="Updates download in the background; you choose when to restart and install."
      >
        <DesktopVersionRow />
      </SettingsSection>

      <PermissionsSection />

      <MeetingDetectSection />

      <SettingsSection
        title="Keyboard shortcuts"
        icon={Keyboard}
        description="Global shortcuts work from anywhere on your system, even when Codecast is in the background."
      >
        {cfg && DESKTOP_SHORTCUTS.map(({ key, label, description }) => {
          const value = cfg.shortcuts[key] || "";
          const conflict = !!cfg.issues[key];
          const isDefault = cfg.defaults ? value === cfg.defaults[key] : true;
          return (
            <SettingsRow
              key={key}
              label={label}
              description={
                <>
                  {description}
                  {conflict && (
                    <span className="mt-0.5 block text-sol-orange">
                      Couldn't register — another app may be using this shortcut.
                    </span>
                  )}
                </>
              }
            >
              {saved === key && <span className="text-xs text-sol-cyan">Saved</span>}
              <ShortcutRecorder value={value} onChange={(acc) => updateShortcut(key, acc)} />
              {!isDefault && cfg.defaults && (
                <button
                  onClick={() => updateShortcut(key, cfg.defaults![key])}
                  aria-label="Reset to default"
                  title="Reset to default"
                  className="p-1.5 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => updateShortcut(key, "")}
                aria-label="Remove shortcut"
                title="Remove shortcut"
                disabled={!value}
                className="p-1.5 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </SettingsRow>
          );
        })}
      </SettingsSection>

      <p className="px-1 text-xs text-sol-text-dim">
        Click a shortcut to re-record it, press <KeyCap size="xs">Esc</KeyCap> to cancel, or remove
        it with the remove button.
      </p>
    </SettingsPanel>
  );
}
