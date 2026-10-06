// A change request's card (DESIGN 6.5): queued, building (narrated live),
// live (the one celebration) or failed. Everyone sees the same card; its
// state is the builds row, joined in by messages.list.
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { BuildView, MessageView } from "../../convex/messages";
import { useCopy } from "../lib/clipboard";
import { errorData } from "../lib/errors";
import { clock, ordinal } from "../lib/format";
import { useVisitorMutation } from "../lib/identity";
import { absolute, versionUrl } from "../lib/router";
import { useNow } from "../lib/useNow";
import { Button, IconButton } from "../ui/Button";
import { ElementChip, FileChip } from "../ui/Chips";
import { Dots } from "../ui/Dots";
import { Face } from "../ui/Face";
import { CheckIcon, LinkIcon } from "../ui/icons";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toast";
import { useAppState } from "./appState";
import s from "./BuildCard.module.css";

export function BuildCard({ m }: { m: MessageView & { build: BuildView } }) {
  const b = m.build;
  if (b.status === "queued") return <QueuedRow m={m} chip={ordinal(b.queue_position ?? 1)} />;
  if (b.status === "building") return <Building m={m} b={b} />;
  if (b.status === "live") return <Live m={m} b={b} />;
  return <Failed m={m} b={b} />;
}

/** A request the builder has not picked up yet. */
export function WaitingCard({ m }: { m: MessageView }) {
  return <QueuedRow m={m} chip={<Dots size={5} light />} />;
}

function QueuedRow({ m, chip }: { m: MessageView; chip: React.ReactNode }) {
  return (
    <div className={s.queued} data-id={m.id} title={m.body}>
      <span className={s.ordinal}>{chip}</span>
      {m.author && <Face person={m.author} size={24} />}
      <span className={s.queuedText}>{m.body}</span>
    </div>
  );
}

function Asker({ m, fact }: { m: MessageView; fact?: React.ReactNode }) {
  return (
    <span className={s.asker}>
      {m.author && <Face person={m.author} size={24} />}
      {m.author && <span className={s.askerName}>{m.author.name}</span>}
      {fact}
    </span>
  );
}

const EXPECTED_MS = 30_000;
const SHOWN_STEPS = 4;
const SHOWN_FILES = 6;

function Building({ m, b }: { m: MessageView; b: BuildView }) {
  const { app } = useAppState();
  const now = useNow(250);
  const [open, setOpen] = useState(false);
  const [allSteps, setAllSteps] = useState(false);
  const elapsed = b.started_at ? now - b.started_at : 0;
  const meter = 90 * (1 - Math.exp(-elapsed / EXPECTED_MS * 1.6));
  const steps = b.narration;
  const hidden = allSteps ? 0 : Math.max(0, steps.length - SHOWN_STEPS);
  const files = b.files_touched;
  return (
    <article className={`${s.card} ${s.building}`} data-id={m.id}>
      <header className={`${s.head} ${s.stripes}`}>
        <Spinner size={26} />
        <span className={s.state}>Building v{app.version_count + 1}</span>
        <Asker m={m} fact={<span className={s.timer}>{clock(elapsed)}</span>} />
      </header>
      <div className={s.body}>
        <p className={`${s.request} ${open ? s.open : ""}`} onClick={() => setOpen((o) => !o)}>{m.body}</p>
        {m.element && <ElementChip element={m.element} />}
        {steps.length > 0 && (
          <ol className={s.narration}>
            {hidden > 0 && (
              <li className={s.fold}>
                <button onClick={() => setAllSteps(true)}>+{hidden} earlier steps</button>
              </li>
            )}
            {steps.slice(hidden).map((step, i, shown) => (
              <li key={step.at + step.text} className={i === shown.length - 1 ? s.now : ""}>{step.text}</li>
            ))}
          </ol>
        )}
        {files.length > 0 && (
          <div className={s.files}>
            {files.slice(0, SHOWN_FILES).map((f) => <FileChip key={f} path={f} written />)}
            {files.length > SHOWN_FILES && <span className={s.moreFiles}>+{files.length - SHOWN_FILES} more</span>}
          </div>
        )}
        <div className={s.meter}><i style={{ width: `${meter}%` }} /></div>
      </div>
    </article>
  );
}

function Live({ m, b }: { m: MessageView; b: BuildView }) {
  const { app, versionByNumber, flashLive, view, restore } = useAppState();
  const { copied, copy } = useCopy();
  const n = b.result_version ?? 0;
  const summary = versionByNumber.get(n)?.summary ?? "";
  const current = n === app.live_version;
  // Celebrate only a card that turned live while it was on screen.
  const wasBuilding = useRef(false);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (wasBuilding.current) setCelebrate(true);
  }, []);
  const [undoing, setUndoing] = useState(false);
  useEffect(() => {
    if (!current) setUndoing(false);
  }, [current]);

  if (!current) {
    return (
      <div className={s.collapsed} data-id={m.id}>
        <i className={s.bar} />
        <span className={s.collapsedV}>v{n}</span>
        <span className={s.collapsedSummary}>{summary}</span>
        {m.author && <Face person={m.author} size={24} />}
        <button className={s.textBtn} onClick={() => view(n)}>See it</button>
      </div>
    );
  }
  return (
    <article className={`${s.card} ${celebrate ? s.celebrate : ""}`} data-id={m.id}>
      <header className={`${s.head} ${s.liveHead}`}>
        <span className={s.liveTitle}><b>v{n}</b> is live</span>
        <Asker m={m} />
      </header>
      <div className={s.body}>
        {summary && <p className={s.summary}>{summary}</p>}
        <div className={s.actions}>
          <Button size="sm" onClick={flashLive}>See it</Button>
          {b.base_version != null && (
            <Button size="sm" busy={undoing} onClick={async () => {
              setUndoing(true);
              await restore(b.base_version!);
              setUndoing(false);
            }}>
              {undoing ? "Undoing" : "Undo"}
            </Button>
          )}
          <IconButton label={copied ? "Copied" : `Copy the link to v${n}`} size={32} onClick={() => copy("v", absolute(versionUrl(app.slug, n)))}>
            {copied ? <CheckIcon /> : <LinkIcon />}
          </IconButton>
        </div>
      </div>
    </article>
  );
}

/** The build error, said the way a person would. */
export function failureReason(error: string | null): string {
  const e = (error ?? "").toLowerCase();
  if (/time|deadline|too long/.test(e)) return "It ran out of time on a big change.";
  if (/budget|spent|limit/.test(e)) return "This app has used today's building budget.";
  if (/valid|parse|syntax|transpile|compile|didn't run/.test(e)) return "The code it wrote didn't run, twice.";
  if (/refus|not allowed|policy/.test(e)) return "Clay won't build that one.";
  return "Something got in the way.";
}

function Failed({ m, b }: { m: MessageView; b: BuildView }) {
  const { app, composer } = useAppState();
  const send = useVisitorMutation(api.messages.send);
  const toast = useToast();
  const [details, setDetails] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await send({ app_id: app.id, body: m.body, mode: "change", ...(m.element ? { element: m.element } : {}) });
    } catch (err) {
      toast({ text: errorData(err).message });
    }
    setRetrying(false);
  };
  return (
    <article className={s.card} data-id={m.id}>
      <header className={`${s.head} ${s.failHead}`}>
        <span className={s.bang} aria-hidden>!</span>
        <span className={s.state}>Didn't make it</span>
        <Asker m={m} />
      </header>
      <div className={s.body}>
        <p className={s.request}>{m.body}</p>
        <p className={s.why}>Clay couldn't finish this one. {failureReason(b.error)}</p>
        <div className={s.actions}>
          <Button size="sm" variant="make" busy={retrying} onClick={retry}>Try again</Button>
          <Button size="sm" onClick={() => {
            composer.setMode("change");
            composer.setText(m.body);
            composer.setElement(m.element);
            composer.focus();
          }}>Edit</Button>
          {b.error && (
            <button className={s.textBtn} onClick={() => setDetails((d) => !d)} aria-expanded={details}>Details</button>
          )}
        </div>
        {details && b.error && <pre className={s.details}>{b.error}</pre>}
      </div>
    </article>
  );
}
