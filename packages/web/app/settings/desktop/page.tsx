import { useState, useCallback, useRef } from "react";
import { Info, Keyboard, RotateCcw, ShieldCheck, Video, X } from "lucide-react";
import { useOsPermissions } from "../../../hooks/useOsPermissions";
import { OS_PERMISSION_KINDS } from "../../../lib/osPermissions";
import { PermissionRow } from "../../../components/permissions/PermissionRow";
import { openDeviceSetup } from "../../../components/permissions/DeviceSetupDialog";
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
  getDesktopShortcutConfig,
  DESKTOP_SHORTCUTS,
  canDetectMeetings,
  getMeetingDetect,
  setMeetingDetect,
  type DesktopShortcutConfig,
  type MeetingDetectConfig,
  type MeetingDetectMode,
} from "../../../lib/desktop";
import { AppLoader } from "../../../components/AppLoader";
import { Button } from "../../../components/ui/button";
import { KeyCap } from "../../../components/KeyboardShortcutsHelp";
import { SettingsOptionGroup, SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";
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

// Record a meeting when one starts.
//
// The setting is PER MACHINE, kept by the desktop shell rather than in the
// prefs that roam. Detection happens where the meeting apps run: a laptop with
// Zoom and a desktop without it want different answers, and "never for Webex"
// names software installed here.
const MEETING_MODES: { value: MeetingDetectMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Codecast does not look at what is running." },
  { value: "ask", label: "Ask me", hint: "A card offers to record. Nothing starts until you press it." },
  { value: "auto", label: "Record it", hint: "Recording starts on its own and the pill says so." },
];

function MeetingDetectSection() {
  const [cfg, setCfg] = useState<MeetingDetectConfig | null>(null);

  useMountEffect(() => {
    if (!canDetectMeetings()) return;
    getMeetingDetect().then(setCfg);
  });

  const patch = async (next: { mode?: MeetingDetectMode; never?: string[] }) => {
    const saved = await setMeetingDetect(next);
    if (saved) setCfg((prev) => (prev ? { ...prev, ...saved } : prev));
  };

  // Absent on a browser and on desktop builds older than this feature, and off
  // the mac it only works on. Nothing is offered rather than offered and dead.
  if (!cfg || !cfg.supported) return null;

  const neverApps = cfg.apps.filter((a) => cfg.never.includes(a.id));

  return (
    <SettingsSection
      title="Meetings"
      icon={Video}
      description="Codecast can notice a meeting starting on this machine and record it — live transcript while it runs, a summary and action items when you stop."
      padded
    >
      <div className="space-y-3">
        <SettingsOptionGroup
          label="When a meeting starts"
          variant="pill"
          value={cfg.mode}
          onChange={(v) => patch({ mode: v as MeetingDetectMode })}
          options={MEETING_MODES.map((m) => ({ value: m.value, label: m.label }))}
        />
        <p className="text-xs text-sol-text-dim">
          {MEETING_MODES.find((m) => m.value === cfg.mode)?.hint}
        </p>

        {/* The privacy line. It is the whole of what detection reads, and
            meetingDetector.js is what makes it true. */}
        <p className="text-xs text-sol-text-dim border-t border-sol-border/60 pt-3">
          Codecast reads the names of running apps to notice meetings. It never reads window
          contents. It watches for {cfg.apps.map((a) => a.name).join(", ")}, and only while this is
          on. Recording listens through your microphone, and a recording is yours alone.
        </p>

        {neverApps.length > 0 && (
          <div className="border-t border-sol-border/60 pt-3">
            <div className="text-xs text-sol-text-dim mb-1.5">Never offered for</div>
            <div className="flex flex-wrap gap-1.5">
              {neverApps.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex items-center gap-1.5 rounded-md bg-sol-bg-alt px-2 py-1 text-xs text-sol-text"
                >
                  {a.name}
                  <button
                    onClick={() => patch({ never: cfg.never.filter((id) => id !== a.id) })}
                    aria-label={`Offer again for ${a.name}`}
                    title={`Offer again for ${a.name}`}
                    className="text-sol-text-dim hover:text-sol-text transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
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
  const [cfg, setCfg] = useState<DesktopShortcutConfig | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useMountEffect(() => {
    if (!isElectron()) return;
    getDesktopShortcutConfig().then(setCfg);
  });

  // "" removes the binding; the default value restores it. Re-fetch the full
  // config afterward so registration conflicts (issues) reflect the new state.
  const updateShortcut = useCallback(async (key: string, accelerator: string) => {
    if (!isElectron()) return;
    await bridge("setShortcut")?.(key, accelerator);
    setCfg(await getDesktopShortcutConfig());
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

  if (!cfg) {
    return <AppLoader className="min-h-0 bg-transparent py-10" size={28} />;
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
        {DESKTOP_SHORTCUTS.map(({ key, label, description }) => {
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
