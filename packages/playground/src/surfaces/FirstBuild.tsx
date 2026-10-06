// A new app's first build (DESIGN 6.10): until Clay's first change goes live,
// the app column shows the blob shaping it, with the current narration line.
import type { AppView } from "../../convex/apps";
import type { MessageView } from "../../convex/messages";
import { Blob } from "../ui/Blob";
import { useAppState } from "./appState";
import s from "./FirstBuild.module.css";

/** Only the seed so far, and a change on its way. */
export function isFirstBuild(app: AppView, messages: MessageView[]): boolean {
  return app.version_count === 1 && messages.some((m) => m.kind === "request" && (!m.build || m.build.status === "queued" || m.build.status === "building"));
}

export function FirstBuild() {
  const { app, stream } = useAppState();
  const build = stream.messages.find((m) => m.build?.status === "building")?.build;
  const line = build?.narration.at(-1)?.text;
  return (
    <div className={s.shaping}>
      <Blob size={96} squash />
      <p className={s.title}>Clay is shaping v{app.live_version + 1}</p>
      {line && <p className={s.line} key={line}>{line}</p>}
    </div>
  );
}
