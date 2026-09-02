// The meeting recorder's one setting, shared by the Desktop settings page and
// the call settings panel in the people window.
import { useState } from "react";
import { Video, X } from "lucide-react";
import { useMountEffect } from "../../hooks/useMountEffect";
import {
  canDetectMeetings,
  getMeetingDetect,
  setMeetingDetect,
  type MeetingDetectConfig,
  type MeetingDetectMode,
} from "../../lib/desktop";
import { SettingsOptionGroup, SettingsSection } from "./ui";

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

export function MeetingDetectSection() {
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
