import { useState } from "react";
import { Bell, Camera, CheckCircle, Mic, Monitor, type LucideIcon } from "lucide-react";
import { SettingsRow } from "../settings/ui";
import { isElectron } from "../../lib/desktop";
import {
  OS_PERMISSIONS,
  permissionActionLabel,
  permissionHint,
  requestOsPermission,
  type OsPermissionKind,
  type PermissionReadiness,
} from "../../lib/osPermissions";

import { useWatchEffect } from "../../hooks/useWatchEffect";
export const PERMISSION_ICONS: Record<OsPermissionKind, LucideIcon> = {
  notifications: Bell,
  microphone: Mic,
  camera: Camera,
  screen: Monitor,
};

// One permission as a settings-style row: what it is, why Codecast wants it
// (or what is wrong), and the one gesture that fixes it. The same row serves
// the first-run dialog, the desktop settings page and the notifications
// page, so every surface says the same thing.
//
// Renders nothing for "n/a" (this surface has no persistent grant for it)
// and "unknown" (we cannot tell here — an old desktop shell): a row that
// cannot report a state or offer a fix is noise.
export function PermissionRow({
  kind,
  readiness,
  onChange,
}: {
  kind: OsPermissionKind;
  readiness: PermissionReadiness;
  onChange: () => void;
}) {
  const info = OS_PERMISSIONS[kind];
  // After "Turn on": the OS is showing its own prompt somewhere else on
  // screen — point at it, because a button that appears to do nothing reads
  // as broken.
  const [awaitingPrompt, setAwaitingPrompt] = useState(false);
  useWatchEffect(() => {
    if (readiness !== "ask") setAwaitingPrompt(false);
  }, [readiness]);

  if (readiness === "n/a" || readiness === "unknown") return null;

  const granted = readiness === "granted";
  const action = permissionActionLabel(readiness);
  const hint = permissionHint(kind, readiness);
  const desktop = isElectron();

  const handle = async () => {
    const outcome = await requestOsPermission(kind, readiness);
    if (outcome === "requested" && readiness === "ask") setAwaitingPrompt(true);
    onChange();
  };

  const description = awaitingPrompt
    ? desktop
      ? `Answer the macOS prompt to finish.${kind === "screen" ? " Codecast may need a restart afterwards." : ""}`
      : "Answer the browser's permission prompt to finish."
    : readiness === "off" && hint
      ? (
        // A denial is the one state worth alarm: something was turned off
        // and the button alone doesn't say why. Undecided just gets the
        // reason and the button.
        <>
          {info.why}
          <span className="mt-0.5 block text-sol-orange">{hint}</span>
        </>
      )
      : info.why;

  return (
    <SettingsRow icon={granted ? CheckCircle : PERMISSION_ICONS[kind]} label={info.label} description={description} alignTop>
      {granted ? (
        <span className="text-xs text-sol-green">On</span>
      ) : action && !awaitingPrompt ? (
        <button
          onClick={handle}
          className="whitespace-nowrap rounded-md bg-sol-blue px-2.5 py-1 text-xs font-medium text-sol-bg transition-opacity hover:opacity-90"
        >
          {action}
        </button>
      ) : (
        <span className="text-xs text-sol-orange">{awaitingPrompt ? "Waiting" : "Blocked"}</span>
      )}
    </SettingsRow>
  );
}
