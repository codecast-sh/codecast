// A change request's card (DESIGN 6.5): queued (one dashed row), building
// (narrated live), live (the one celebration), superseded (one line) or
// failed. Everyone sees the same card; its state is the builds row, joined in
// by messages.list, and its narration is read apart (builds.progress) so only
// the card wakes while Clay works. The build line along the top carries
// progress. The steps and the clock are for eyes; the stream's status line
// says each change of state to a screen reader once.
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import type { BuildView, MessageView } from "../../convex/messages";
import { RETRYABLE_FAILURES, type NarrationLine } from "../../convex/validators";
import { useCopy } from "../lib/clipboard";
import { errorData } from "../lib/errors";
import { chatTime, clock, plural } from "../lib/format";
import { useIdentity, useVisitorMutation } from "../lib/identity";
import { absolute, appUrl, versionUrl } from "../lib/router";
import { useClamped } from "../lib/useClamped";
import { useNow } from "../lib/useNow";
import { BuildLine, buildProgress } from "../ui/BuildLine";
import { Blob } from "../ui/Blob";
import { Button, IconButton } from "../ui/Button";
import { ElementChip, FileChip } from "../ui/Chips";
import { Dots } from "../ui/Dots";
import { Face, type Person } from "../ui/Face";
import { CheckIcon, LinkIcon, RestoreIcon } from "../ui/icons";
import { Spinner } from "../ui/Spinner";
import { useTip } from "../ui/Tip";
import { useToast } from "../ui/Toast";
import { useBuildProgress } from "../data/builds";
import { useBuildsPaused } from "../data/budget";
import { restoreSaid, versionLine, versionSummary } from "../lib/versionCopy";
import { useAppState, useAskChange } from "./appState";
import { ChatMessage, ClayRow } from "./ChatMessage";
import { lineLabel, useBusy } from "./buildTicker";
import { ReverseButton, TryIt, useReverse, useSummary } from "./versionActions";
import s from "./BuildCard.module.css";

export function BuildCard({ m, b }: { m: MessageView; b: BuildView }) {
  if (b.status === "queued") return <Queued m={m} b={b} />;
  if (b.status === "building") return <Building m={m} b={b} />;
  if (b.status === "live") return <Live m={m} b={b} />;
  return <Failed m={m} b={b} />;
}

/** A request the builder has not picked up yet. */
export function WaitingCard({ m }: { m: MessageView }) {
  return <QueuedRow m={m} chip={<Dots />} />;
}

/** In line: its place, or "Starting" with nothing ahead of it. */
function Queued({ m, b }: { m: MessageView; b: BuildView }) {
  const label = lineLabel(b, useBusy());
  return <QueuedRow m={m} chip={label === "Starting" ? <><Spinner />Starting</> : label} />;
}

function QueuedRow({ m, chip }: { m: MessageView; chip: ReactNode }) {
  const { me } = useIdentity();
  const mine = m.author?.id === me.id;
  return (
    <div className={s.queued} data-id={m.id} title={m.body}>
      <span className={s.ordinal}>{chip}</span>
      {m.author && <Face person={m.author} size={20} />}
      <span className={s.queuedText}>{m.body}</span>
      <span className={s.queuedMeta}>{mine ? "You, in line" : m.author?.name}</span>
    </div>
  );
}

/** The asker on the right of a card's head: face, name, and one fact. */
function Asker({ m, fact }: { m: MessageView; fact?: ReactNode }) {
  return (
    <span className={s.asker}>
      {m.author && <Face person={m.author} size={20} decorative />}
      {m.author && <span className={s.askerName}>{m.author.name}</span>}
      {fact}
    </span>
  );
}

/** The asker's own words, clamped to three lines. Words that overflow the
 *  clamp make it a toggle, for a tap or a key. */
function Request({ m }: { m: MessageView }) {
  const [open, setOpen] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  const toggle = useClamped(text, open, m.body) || open;
  return (
    <>
      <p
        ref={text}
        className={`${s.request} ${toggle ? s.toggle : ""}`}
        style={{ WebkitLineClamp: open ? "unset" : 3 }}
        {...(toggle && {
          role: "button",
          tabIndex: 0,
          "aria-expanded": open,
          onClick: () => setOpen((o) => !o),
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            setOpen((o) => !o);
          },
        })}
      >
        {m.body}
      </p>
      {m.element && <div className={s.element}><ElementChip element={m.element} /></div>}
    </>
  );
}

const SHOWN_STEPS = 4;
const SHOWN_FILES = 6;

/** Clay at work: the request, Clay's plan under it once Clay has said it,
 *  then the steps, the newest being what Clay is doing now. `landing`: the
 *  version is live and on its way to your screen, so the line completes and
 *  turns green, the clock stops, every step is done and the title says so.
 *  While Clay makes an app's first version the app column narrates it
 *  (FirstBuild), so the card keeps to the request. */
function Building({ m, b, landing = false }: { m: MessageView; b: BuildView; landing?: boolean }) {
  const { app, making } = useAppState();
  const now = useNow(250);
  const { narration, files_touched: files } = useBuildProgress(b.id);
  const elapsed = b.started_at ? (landing && b.finished_at ? b.finished_at : now) - b.started_at : 0;
  const n = b.result_version ?? app.version_count + 1;
  return (
    <article className={s.card} data-id={m.id}>
      <BuildLine progress={landing ? 100 : buildProgress(elapsed)} state={landing ? "live" : "building"} />
      <header className={s.head}>
        <span className={s.title}>
          {landing ? <span className={s.check}><CheckIcon /></span> : <Spinner />}
          {landing ? <span>v{n} <span className={s.going}>going live</span></span> : `Building v${n}`}
        </span>
        <Asker m={m} fact={<span className={s.timer} aria-hidden>{clock(elapsed)}</span>} />
      </header>
      <div className={s.body}>
        <Request m={m} />
        {!making && <Narration narration={narration} landing={landing} />}
        {!making && files.length > 0 && (
          <div className={s.files} aria-hidden>
            {files.slice(0, SHOWN_FILES).map((f) => <FileChip key={f.path} path={f.path} written={f.how !== "read"} />)}
            {files.length > SHOWN_FILES && <span className={s.moreFiles}>+{files.length - SHOWN_FILES} more</span>}
          </div>
        )}
      </div>
    </article>
  );
}

/** Clay's plan, then its steps, the newest being what Clay is doing now;
 *  earlier ones fold away. Shared by the card and the first build's column. */
export function Narration({ narration, landing = false }: { narration: NarrationLine[]; landing?: boolean }) {
  const [allSteps, setAllSteps] = useState(false);
  const plan = narration.find((l) => l.kind === "plan");
  const steps = narration.filter((l) => l.kind !== "plan" && !(landing && l.kind === "now"));
  const hidden = allSteps ? 0 : Math.max(0, steps.length - SHOWN_STEPS);
  return (
    <>
      {plan && (
        <p className={s.plan} title={plan.text}>
          <Blob size={16} />
          <span>{plan.text}</span>
        </p>
      )}
      {steps.length > 0 && (
        <ol className={s.steps} aria-hidden>
          {hidden > 0 && (
            <li className={s.earlier}>
              <button onClick={() => setAllSteps(true)}>{plural(hidden, "earlier step")}</button>
            </li>
          )}
          {steps.slice(hidden).map((step, i, shown) => {
            const current = i === shown.length - 1 && !landing;
            return (
              <li key={step.at} className={current ? s.now : ""} title={current ? undefined : step.text}>
                {current ? <i className={s.pulse} /> : <CheckIcon />}
                <span>
                  {step.text}
                  {current && <i className={s.caret} />}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function Live({ m, b }: { m: MessageView; b: BuildView }) {
  const { landed } = useAppState();
  const n = b.result_version ?? 0;
  if (n > landed) return <Building m={m} b={b} landing />;
  if (n < landed) return <Superseded m={m} b={b} n={n} />;
  return <LiveNow m={m} b={b} n={n} />;
}

/** A folded row's tooltip: what it did, then who asked for it, in their words. */
const asked = (m: MessageView, summary: string) => `${summary}\n${m.author?.name ?? "Someone"} asked: ${m.body}`;

/** A version that is no longer live, folded to one log row: the version,
 *  what it did (a restore with the restore glyph and its verb), who and
 *  when. The whole row shows it to you; "See it" says so on hover or focus.
 *  The version you are viewing is marked as on the timeline, and its row
 *  takes you back to live. */
function FoldedRow({ id, n, summary, person, at, title, restore = false }: { id: string; n: number; summary: string; person: Person | null; at: number; title: string; restore?: boolean }) {
  const { view, viewing } = useAppState();
  const now = useNow(60_000);
  const isViewing = viewing === n;
  return (
    <button
      className={`${s.folded} ${isViewing ? s.foldedViewing : ""}`}
      data-id={id}
      title={title}
      aria-current={isViewing || undefined}
      aria-label={isViewing ? `v${n}, viewing: ${summary}. Back to live` : `v${n}: ${summary}${person ? `, ${person.name}` : ""}. See it`}
      onClick={() => view(isViewing ? null : n)}
    >
      <i className={s.bar} />
      <span className={s.foldedV}>v{n}</span>
      {restore && <span className={s.foldedGlyph} aria-hidden><RestoreIcon /></span>}
      <span className={s.foldedSummary}>{summary}</span>
      {person && <Face person={person} size={20} />}
      <span className={s.trail}>
        <span className={s.foldedMeta}>{isViewing ? "Viewing" : chatTime(at, now)}</span>
        <span className={s.seeIt} aria-hidden>{isViewing ? "Back to live" : "See it"}</span>
      </span>
    </button>
  );
}

function Superseded({ m, b, n }: { m: MessageView; b: BuildView; n: number }) {
  const summary = useSummary(b);
  return <FoldedRow id={m.id} n={n} summary={summary} person={m.author} at={b.finished_at ?? m.created_at} title={asked(m, summary)} />;
}

/** The card of the live version (DESIGN 6.5): the green line, "v15 is live",
 *  and one actions row that ends in its meta and its link. Celebrates only
 *  the version that just landed on this screen, not one scrolled back into.
 *  `share`: the maker's own first version, the moment to pass it around, so
 *  copying the app's link leads. */
function LiveShell({ id, n, aside, actions, meta, share = false, children }: { id: string; n: number; aside: ReactNode; actions: ReactNode; meta?: ReactNode; share?: boolean; children: ReactNode }) {
  const { app, flashLive, cheer } = useAppState();
  const { copied, copy } = useCopy();
  const [celebrate] = useState(() => cheer === n);
  return (
    <article className={`${s.card} ${s.live} ${celebrate ? s.celebrate : ""}`} data-id={id}>
      <BuildLine progress={100} state="live" />
      <header className={s.head}>
        <span className={`${s.title} ${s.liveTitle}`}><b>v{n}</b> is live</span>
        {aside}
      </header>
      <div className={s.body}>
        {children}
        {share && <p className={s.share}>Anyone with the link can change it. Send it to a friend.</p>}
        <div className={s.actions}>
          {share && (
            <Button variant="ink" onClick={() => copy("app", absolute(appUrl(app.slug)))}>
              {copied === "app" ? <CheckIcon /> : <LinkIcon />}
              {copied === "app" ? "Copied" : "Copy link"}
            </Button>
          )}
          <Button onClick={flashLive}>See it</Button>
          {actions}
          <span className={s.grow} />
          {meta && <span className={s.meta}>{meta}</span>}
          {!share && (
            <IconButton label={copied ? "Copied" : `Copy the link to v${n}`} onClick={() => copy("v", absolute(versionUrl(app.slug, n)))}>
              {copied ? <CheckIcon /> : <LinkIcon />}
            </IconButton>
          )}
        </div>
      </div>
    </article>
  );
}

function LiveNow({ m, b, n }: { m: MessageView; b: BuildView; n: number }) {
  const summary = useSummary(b) || m.body;
  const { files_touched } = useBuildProgress(b.id);
  const { versionByNumber } = useAppState();
  const { me } = useIdentity();
  const entry = versionByNumber.get(n);
  const tryIt = entry?.try_it;
  // The first thing Clay made for you: now it is worth sending to someone.
  const madeByYou = entry?.kind === "build" && entry.parent_number === null && m.author?.id === me.id;
  const undo = useReverse(n);
  const changed = files_touched.filter((f) => f.how !== "read").length;
  const took = b.started_at && b.finished_at ? `Built in ${clock(b.finished_at - b.started_at)}` : null;
  const files = changed > 0 ? `${plural(changed, "file")} changed` : null;
  // On a narrow card the file count goes first, so the time never truncates.
  const meta = (took || files) && (
    <>
      {took}
      {took && files && <span className={s.metaMore}> · {files}</span>}
      {!took && files}
    </>
  );
  return (
    <LiveShell
      id={m.id}
      n={n}
      aside={<Asker m={m} />}
      meta={meta}
      share={madeByYou}
      actions={undo && <ReverseButton r={undo} />}
    >
      <p className={s.summary} title={summary}>{summary}</p>
      {tryIt && <TryIt text={tryIt} className={s.tryIt} />}
    </LiveShell>
  );
}

type RestoreNote = Extract<NonNullable<MessageView["note"]>, { type: "restore" }>;

/** A restore is a version too: live, it is a card saying who undid or
 *  brought back whose version, with a one-click way to reverse it; once
 *  something newer lands, it folds into the log like any other version. */
export function RestoreCard({ m, note }: { m: MessageView; note: RestoreNote }) {
  const { landed, versionByNumber } = useAppState();
  const { me } = useIdentity();
  const now = useNow(30_000);
  const n = note.version;
  const entry = versionByNumber.get(n);
  const line = entry ? versionLine(entry, versionByNumber) : null;
  const said = restoreSaid(note, versionByNumber, me.id);
  const reverse = useReverse(n);
  if (n < landed) return <FoldedRow id={m.id} n={n} summary={entry ? versionSummary(entry, versionByNumber) : said} person={note.by} at={m.created_at} title={said} restore />;
  if (n > landed) return null;
  return (
    <LiveShell
      id={m.id}
      n={n}
      aside={<time className={s.when}>{chatTime(m.created_at, now)}</time>}
      actions={reverse && <ReverseButton r={reverse} />}
    >
      <p className={s.said}>
        {note.by && <Face person={note.by} size={20} />}
        <span>{said}</span>
      </p>
      {line && <p className={s.aboutSummary}>{line.summary}</p>}
    </LiveShell>
  );
}

/** A build that didn't go live. A decline is Clay's answer to the request,
 *  so it reads as a reply, not a failure. A real failure is a card offering
 *  what can work: Try again where the same words can get through, Edit where
 *  the request has to change. Once a newer version has landed, it folds to
 *  one log row, which opens it again. */
function Failed({ m, b }: { m: MessageView; b: BuildView }) {
  const { versionByNumber, landed } = useAppState();
  const at = b.finished_at ?? m.created_at;
  const [open, setOpen] = useState(false);
  if (b.failure === "declined") return <Declined m={m} b={b} />;
  const newer = (versionByNumber.get(landed)?.created_at ?? 0) > at;
  if (newer && !open) return <FailedRow m={m} at={at} onOpen={() => setOpen(true)} />;
  return <FailedCard m={m} b={b} at={at} />;
}

/** Clay said no, and why: the request as the asker said it, then Clay's
 *  reply with a way to put it another way. */
function Declined({ m, b }: { m: MessageView; b: BuildView }) {
  const { me } = useIdentity();
  const askChange = useAskChange();
  const now = useNow(30_000);
  return (
    <div data-id={m.id}>
      <ChatMessage m={m} grouped={false} now={now} mine={m.author?.id === me.id} sharedName={false} />
      <ClayRow at={b.finished_at ?? m.created_at} now={now} action={<Button variant="text" onClick={() => askChange(m.body, m.element)}>Edit</Button>}>
        {b.error ?? "Clay left this one as it is."}
      </ClayRow>
    </div>
  );
}

function FailedRow({ m, at, onOpen }: { m: MessageView; at: number; onOpen: () => void }) {
  const now = useNow(60_000);
  return (
    <button className={`${s.folded} ${s.foldedFailed}`} data-id={m.id} title={m.author ? `${m.author.name} asked: ${m.body}` : m.body} aria-label={`Didn't make it: ${m.body}${m.author ? `, ${m.author.name}` : ""}. Show`} onClick={onOpen}>
      <span className={s.bang} aria-hidden>!</span>
      <span className={s.foldedV}>Didn't make it</span>
      <span className={s.foldedSummary}>{m.body}</span>
      {m.author && <Face person={m.author} size={20} />}
      <span className={s.trail}>
        <span className={s.foldedMeta}>{chatTime(at, now)}</span>
        <span className={s.seeIt} aria-hidden>Show</span>
      </span>
    </button>
  );
}

function FailedCard({ m, b, at }: { m: MessageView; b: BuildView; at: number }) {
  const { app } = useAppState();
  const askChange = useAskChange();
  const retryBuild = useVisitorMutation(api.builder.queue.retry);
  const toast = useToast();
  const now = useNow(30_000);
  const [details, setDetails] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retryable = !b.failure || RETRYABLE_FAILURES.includes(b.failure);
  const paused = useBuildsPaused(app.id);
  const pausedTip = useTip(paused);
  const retry = async () => {
    setRetrying(true);
    try {
      await retryBuild({ build_id: b.id });
    } catch (err) {
      toast({ text: errorData(err).message });
    }
    setRetrying(false);
  };
  const edit = () => askChange(m.body, m.element);
  // The line stays where the build stopped.
  const stoppedAt = b.started_at && b.finished_at ? buildProgress(b.finished_at - b.started_at) : 8;
  return (
    <article className={s.card} data-id={m.id}>
      <BuildLine progress={stoppedAt} state="failed" />
      <header className={s.head}>
        <span className={s.title}>
          <span className={s.bang} aria-hidden>!</span>
          Didn't make it
        </span>
        <Asker m={m} fact={<time className={s.when}>{chatTime(at, now)}</time>} />
      </header>
      <div className={s.body}>
        <Request m={m} />
        <p className={s.why}>{b.error ?? "Clay couldn't finish this one."}</p>
        <div className={s.actions}>
          {retryable ? (
            <>
              <span className={s.tipped}>
                <Button variant="accent" busy={retrying} disabled={!!paused} onClick={retry} {...(paused ? pausedTip.describedBy : {})}>Try again</Button>
                {paused && pausedTip.tip}
              </span>
              <Button onClick={edit}>Edit</Button>
            </>
          ) : (
            <Button variant="ink" onClick={edit}>Edit</Button>
          )}
          <span className={s.grow} />
          {b.error_detail && (
            <Button variant="text" onClick={() => setDetails((d) => !d)} aria-expanded={details}>Details</Button>
          )}
        </div>
        {details && b.error_detail && <pre className={s.details}>{b.error_detail}</pre>}
      </div>
    </article>
  );
}
