// A new app's first build (DESIGN 6.10): until Clay's first version lands,
// the app column says what was asked for, in the asker's words, and Clay's
// steps as it works, instead of the starter app, which would read as Clay
// having built the wrong thing. It fades away as the app arrives.
import type { MessageView } from "../../convex/messages";
import { useBuildProgress } from "../data/builds";
import { clock } from "../lib/format";
import { useNow } from "../lib/useNow";
import { Blob } from "../ui/Blob";
import { BuildLine, buildProgress } from "../ui/BuildLine";
import { Face } from "../ui/Face";
import { Narration } from "./BuildCard";
import s from "./FirstBuild.module.css";

export function FirstBuild({ m, leaving }: { m: MessageView; leaving: boolean }) {
  const b = m.build;
  const { narration } = useBuildProgress(b?.id);
  const now = useNow(1000);
  const live = b?.status === "live";
  const elapsed = b?.started_at ? (live && b.finished_at ? b.finished_at : now) - b.started_at : 0;
  const status = live ? "Going live" : b?.status === "building" ? `Clay is making it · ${clock(elapsed)}` : "Clay is about to start";
  return (
    <div className={`${s.first} ${leaving ? s.leaving : ""}`} role="status">
      <BuildLine progress={live ? 100 : buildProgress(elapsed)} state={live ? "live" : "building"} />
      <div className={s.inner}>
        <p className={s.asked}>
          {m.author ? <Face person={m.author} size={20} /> : <Blob size={20} />}
          <span><b>{m.author?.name ?? "Someone"}</b> asked for</span>
        </p>
        <p className={s.request}>{m.body}</p>
        <div className={s.steps}>
          <Narration narration={narration} landing={live} />
        </div>
        <p className={s.status}>
          <Blob size={16} />
          {status}
        </p>
      </div>
    </div>
  );
}
