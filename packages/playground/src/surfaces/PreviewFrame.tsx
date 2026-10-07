// An app as a watch-only preview at the gallery's page size (800x800): it
// shows the version with its real data and writes nothing (a watch token,
// runtime/protocol). Gallery tiles scale it into place; the room mounts one
// out of sight to picture a version that just went live. Either way, when
// `pictureIt`, the page is pictured once it has painted and settled, and
// that becomes the version's still for everyone (data/stills).
import { useEffect, useRef } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import { RUNTIME_TOKEN_RENEW_MS, runtimeTokenForSecret } from "../../convex/lib/identity";
import { STILL_VIEWPORT } from "../../convex/lib/limits";
import { versionPath } from "../../convex/lib/runPaths";
import { RUNTIME_CSP } from "../../convex/lib/runtime";
import { initFor, isAppMessage, postToApp } from "../../runtime/protocol";
import { STILL_SETTLE_MS, useTakeStill } from "../data/stills";
import { avatarUrlsForApps } from "../lib/avatars";
import { RUN_ORIGIN } from "../lib/convex";
import { useIdentity } from "../lib/identity";
import { appLink } from "../lib/router";

const SANDBOX = RUNTIME_CSP.replace(/^sandbox /, "");

type Props = {
  appId: Id<"apps">;
  slug: string;
  name: string;
  version: number;
  pictureIt: boolean;
  className?: string;
  onPainted?: () => void;
  /** The picture was taken, or this screen will not take it. */
  onPictured?: () => void;
};

export function PreviewFrame({ appId, slug, name, version, pictureIt, className, onPainted, onPictured }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { creds, me } = useIdentity();
  const takeStill = useTakeStill();
  const latest = useRef({ creds, me, name, pictureIt, onPainted, onPictured, takeStill });
  latest.current = { creds, me, name, pictureIt, onPainted, onPictured, takeStill };

  useEffect(() => {
    let answered = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onMessage = async (e: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || e.source !== target || !isAppMessage(e.data)) return;
      const { creds, me, name, pictureIt, onPainted, onPictured, takeStill } = latest.current;
      if (e.data.type === "ready" && !answered) {
        answered = true;
        postToApp(target, await initFor({ creds, appId, version, visitor: me, avatars: await avatarUrlsForApps(), app: appLink(slug, name), scope: "watch" }));
      } else if (e.data.type === "painted") {
        onPainted?.();
        if (pictureIt) settle = setTimeout(() => void takeStill(target, appId, version).then(onPictured), STILL_SETTLE_MS);
      }
    };
    const renew = setInterval(() => {
      const target = frame.current?.contentWindow;
      if (target && answered) {
        void runtimeTokenForSecret(latest.current.creds.secret, appId, version, Date.now(), "watch").then((token) => postToApp(target, { type: "token", token }));
      }
    }, RUNTIME_TOKEN_RENEW_MS);
    addEventListener("message", onMessage);
    return () => {
      removeEventListener("message", onMessage);
      clearInterval(renew);
      clearTimeout(settle);
    };
  }, [appId, version]);

  return (
    <iframe
      ref={frame}
      className={className}
      style={STILL_VIEWPORT}
      src={RUN_ORIGIN + versionPath(slug, version)}
      sandbox={SANDBOX}
      tabIndex={-1}
      aria-hidden
      title=""
    />
  );
}
