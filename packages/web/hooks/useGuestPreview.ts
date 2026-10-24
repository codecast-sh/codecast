import { useState } from "react";
import { GuestPreview } from "../lib/calls/guestRoom";
import { readJoinPrefs } from "../lib/calls/joinPrefs";
import { useMountEffect } from "./useMountEffect";

// One preview per open dialog, opened with the remembered devices and the
// remembered on/off, and closed with the dialog (a Start disposes it first, so
// the join opens the devices fresh rather than beside a lit preview).
export function usePreview(): GuestPreview | null {
  const [preview, setPreview] = useState<GuestPreview | null>(null);
  useMountEffect(() => {
    const prefs = readJoinPrefs();
    const p = new GuestPreview({ micId: prefs.micDeviceId, cameraId: prefs.cameraDeviceId, speakerId: prefs.speakerDeviceId });
    setPreview(p);
    void p.start({ mic: prefs.micOn, camera: prefs.cameraOn });
    return () => p.dispose();
  });
  return preview;
}
