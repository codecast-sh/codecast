// The version on screen did not load (its page never started): a quiet state
// in the app column instead of a browser's broken page, with the ways out.
// Fix it only when the app's own code said what broke; a page that never
// arrived is a connection, not something Clay can change.
import { Blob } from "../ui/Blob";
import { Button } from "../ui/Button";
import { fixText, useAppState, useAskChange } from "./appState";
import type { FailedFrame } from "./AppFrame";
import s from "./FrameFailed.module.css";

export function FrameFailed({ version, error, retry }: FailedFrame) {
  const { app, view } = useAppState();
  const askChange = useAskChange();
  const isLive = version === app.live_version;
  const before = version - 1;
  return (
    <div className={s.failed} role="alert">
      <Blob size={28} />
      <p className={s.title}>v{version} didn't load</p>
      {error ? <p className={s.why}>{error}</p> : <p className={s.hint}>It may be the connection. Try again in a moment.</p>}
      <div className={s.actions}>
        <Button onClick={retry}>Try again</Button>
        {isLive && before >= 1 && <Button onClick={() => view(before)}>Show v{before}</Button>}
        {isLive && error && <Button variant="text" onClick={() => askChange(fixText(error))}>Fix it</Button>}
        {!isLive && <Button variant="text" onClick={() => view(null)}>Back to live</Button>}
      </div>
    </div>
  );
}
