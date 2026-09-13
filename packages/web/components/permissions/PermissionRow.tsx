import { useState } from "react";
import {
  Bell,
  Camera,
  Check,
  ExternalLink,
  Image,
  Mic,
  Monitor,
  MousePointerClick,
  type LucideIcon,
} from "lucide-react";
import { SettingsRow } from "../settings/ui";
import { Button } from "../ui/button";
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
const PERMISSION_ICONS: Record<OsPermissionKind, LucideIcon> = {
  notifications: Bell,
  microphone: Mic,
  camera: Camera,
  screen: Monitor,
  computerAccessibility: MousePointerClick,
  computerScreen: Image,
};

// One permission as a settings-style row: what it is, why Codecast wants it
// (or what is wrong), and the one gesture that fixes it. The same row serves
// the first-run dialog, the desktop settings page and the notifications
// page, so every surface says the same thing.
//
// The control carries the hierarchy. "Turn on" is filled: one click, the OS
// asks right here. "Open System Settings" is outlined with an outward arrow:
// it leaves the app, and the person finishes elsewhere. A granted row settles
// into a quiet check so the eye goes to what is still open.
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
  const leavesApp = readiness === "off";

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
          <span className="mt-1 flex items-start gap-1.5 text-sol-orange">
            <span aria-hidden className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-sol-orange" />
            {hint}
          </span>
        </>
      )
      : info.why;

  const Icon = PERMISSION_ICONS[kind];

  return (
    <SettingsRow
      icon={Icon}
      label={info.label}
      description={description}
      alignTop
      className={granted ? "[&_svg]:text-sol-green" : undefined}
    >
      {granted ? (
        <span className="inline-flex h-7 items-center gap-1 rounded-full bg-sol-green/10 px-2.5 text-xs font-medium text-sol-green">
          <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
          On
        </span>
      ) : action && !awaitingPrompt ? (
        <Button
          size="sm"
          variant={leavesApp ? "outline" : "default"}
          onClick={handle}
          className={
            leavesApp
              ? "h-7 border-sol-border bg-transparent px-2.5 text-xs text-sol-text shadow-none hover:bg-sol-bg-highlight/60 [&_svg]:size-3"
              : "h-7 bg-sol-blue px-3 text-xs text-sol-bg shadow-none hover:bg-sol-blue/90"
          }
        >
          {action}
          {leavesApp && <ExternalLink aria-hidden />}
        </Button>
      ) : (
        <span
          className={
            awaitingPrompt
              ? "inline-flex h-7 items-center gap-1.5 text-xs text-sol-text-muted"
              : "inline-flex h-7 items-center text-xs text-sol-orange"
          }
        >
          {awaitingPrompt && <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sol-blue" />}
          {awaitingPrompt ? "Waiting" : "Blocked"}
        </span>
      )}
    </SettingsRow>
  );
}
