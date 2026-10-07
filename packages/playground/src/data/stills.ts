// Taking a version's still for the gallery (convex/stills.ts): ask whether
// this screen should, have the app draw itself at the gallery's size
// (runtime/capture.ts), and upload the picture. A screen tries each version
// once; the server keeps the first picture and refuses the rest.
import { useCallback } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { STILL_VIEWPORT } from "../../convex/lib/limits";
import { isAppMessage, postToApp } from "../../runtime/protocol";
import { useVisitorMutation } from "../lib/identity";

/** Long enough for a first paint's transitions, fonts and the landing's
 *  spotlight ring (gone after 1.2s) to settle. */
export const STILL_SETTLE_MS = 2_000;
const CAPTURE_WAIT_MS = 20_000;
const tried = new Set<string>();

/** The picture `target` (an app's frame) draws of itself, or null. */
function captureFrom(target: Window): Promise<Blob | null> {
  return new Promise((resolve) => {
    const done = (image: Blob | null) => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      resolve(image);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source === target && isAppMessage(e.data) && e.data.type === "captured") done(e.data.image);
    };
    const timer = setTimeout(() => done(null), CAPTURE_WAIT_MS);
    addEventListener("message", onMessage);
    postToApp(target, { type: "capture", ...STILL_VIEWPORT });
  });
}

/** take(frame window, app, version): picture it if nobody has yet. */
export function useTakeStill() {
  const uploadUrl = useVisitorMutation(api.stills.uploadUrl);
  const attach = useVisitorMutation(api.stills.attach);
  return useCallback(
    async (target: Window, appId: Id<"apps">, number: number) => {
      const key = `${appId}:${number}`;
      if (tried.has(key)) return;
      tried.add(key);
      try {
        const url = await uploadUrl({ app_id: appId, number });
        const image = url && (await captureFrom(target));
        if (!url || !image) return;
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": image.type }, body: image });
        const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
        await attach({ app_id: appId, number, storage_id: storageId });
      } catch {
        // A missing picture is only a plainer gallery tile; another screen takes it.
      }
    },
    [uploadUrl, attach],
  );
}
