// The phone sheet at its peek (DESIGN 6.11): one line for what matters now,
// in this order: you are looking at the past; a change is building or in
// line; a change just went live (with Undo); else the latest thing said. The
// build line runs along the sheet's top edge while a change is on its way.
import type { BuildView, MessageView, NoteView } from "../../convex/messages";
import { useIdentity } from "../lib/identity";
import { restoreSaid } from "../lib/versionCopy";
import { clock } from "../lib/format";
import { Blob } from "../ui/Blob";
import { BuildLine } from "../ui/BuildLine";
import { Button } from "../ui/Button";
import { Face } from "../ui/Face";
import { CheckIcon } from "../ui/icons";
import { Spinner } from "../ui/Spinner";
import { useAppState, useStream } from "./appState";
import { ReverseButton, useReverse, useSummary } from "./BuildCard";
import { useBuildTicker } from "./buildTicker";
import { SystemNote } from "./ChatMessage";
import { useAlsoViewing, viewingText } from "./ViewingPill";
import s from "./SheetPeek.module.css";

export function SheetPeek() {
  const { viewing, view, landed } = useAppState();
  const { messages, building } = useStream();
  const ticker = useBuildTicker(building);
  const last = messages.at(-1);

  if (viewing !== null) return <PastRow n={viewing} onBack={() => view(null)} />;
  if (ticker) {
    const { phase } = ticker;
    return (
      <p className={s.row} role="status">
        <BuildLine progress={ticker.progress} state={ticker.state} />
        {phase === "landing" ? <span className={s.check} aria-hidden><CheckIcon /></span> : phase === "queued" ? <Blob size={16} /> : <Spinner />}
        <b className={s.title}>{ticker.title}</b>
        {phase === "building" && ticker.elapsed > 0 && <span className={s.clock}>{clock(ticker.elapsed)}</span>}
        <span className={s.text} key={ticker.lineKey}>{ticker.line}</span>
      </p>
    );
  }
  const b = last?.build;
  if (last && b?.status === "live" && b.result_version === landed) return <LiveRow m={last} b={b} n={landed} />;
  if (last && b?.status === "failed") {
    return (
      <p className={s.row}>
        <BuildLine progress={8} state="failed" />
        <span className={s.bang} aria-hidden>!</span>
        <b className={s.title}>Didn't make it</b>
        <span className={s.text}>{b.error ?? "Clay couldn't finish this one."}</span>
      </p>
    );
  }
  if (last?.note?.type === "restore" && last.note.version === landed) return <RestoreRow note={last.note} n={landed} />;
  if (last?.kind === "system") return <div className={s.note}><SystemNote m={last} /></div>;
  return (
    <p className={s.row}>
      {last?.author ? <Face person={last.author} size={20} /> : <Blob size={20} />}
      {last ? (
        <>
          <b className={s.name}>{last.author?.name ?? "Clay"}</b>
          <span className={s.text}>{last.body}</span>
        </>
      ) : (
        <span className={s.text}>It's quiet in here. Say what you'd change.</span>
      )}
    </p>
  );
}

/** On a phone the past is marked inside the sheet, never over the app's own
 *  header (DESIGN 6.7). */
export function PastRow({ n, onBack, className = "" }: { n: number; onBack: () => void; className?: string }) {
  const others = useAlsoViewing(n);
  return (
    <p className={`${s.row} ${className}`} role="status">
      <span className={s.past} aria-hidden />
      <span className={`${s.text} ${s.pastText}`}>{viewingText(n, others)}</span>
      <Button variant="text" className={s.action} onClick={onBack}>Back to live</Button>
    </p>
  );
}

function RestoreRow({ note, n }: { note: Extract<NoteView, { type: "restore" }>; n: number }) {
  const { versionByNumber } = useAppState();
  const { me } = useIdentity();
  const reverse = useReverse(n);
  return (
    <p className={s.row}>
      <BuildLine progress={100} state="live" />
      <span className={s.check} aria-hidden><CheckIcon /></span>
      <b className={s.title}>v{n} <span className={s.live}>is live</span></b>
      <span className={s.text}>{restoreSaid(note, versionByNumber, me.id)}</span>
      {reverse && <ReverseButton r={reverse} variant="text" className={s.action} />}
    </p>
  );
}

function LiveRow({ m, b, n }: { m: MessageView; b: BuildView; n: number }) {
  const undo = useReverse(n);
  const summary = useSummary(b) || m.body;
  return (
    <p className={s.row}>
      <BuildLine progress={100} state="live" />
      <span className={s.check} aria-hidden><CheckIcon /></span>
      <b className={s.title}>v{n} <span className={s.live}>is live</span></b>
      <span className={s.text}>{summary}</span>
      {undo && <ReverseButton r={undo} variant="text" className={s.action} />}
    </p>
  );
}
