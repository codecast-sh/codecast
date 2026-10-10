// Chat rows, Clay's notes and system notes (DESIGN 6.4, 6.5, 6.10).
import { useRef, useState, type ReactNode } from "react";
import type { MessageView, NoteView } from "../../convex/messages";
import { ago, chatTime } from "../lib/format";
import { appUrl } from "../lib/router";
import { Link } from "../ui/Link";
import { AVATAR_LABELS } from "../lib/avatars";
import { Blob } from "../ui/Blob";
import { Button } from "../ui/Button";
import { ElementChip } from "../ui/Chips";
import { Face } from "../ui/Face";
import { ClockIcon, ForkIcon, RestoreIcon } from "../ui/icons";
import { useIdentity } from "../lib/identity";
import { useClamped } from "../lib/useClamped";
import { nameFor, restoreSaid } from "../lib/versionCopy";
import { fixText, useAppState, useAskChange } from "./appState";
import s from "./ChatMessage.module.css";

const isPending = (m: MessageView) => m.id.startsWith("pending:");

const URL_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/g;

function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** One message as a dense row (DESIGN 6.4): face, name and time, then the
 *  text. A run from one person within two minutes drops the face and name. */
export function ChatMessage({ m, grouped, now, mine, sharedName }: { m: MessageView; grouped: boolean; now: number; mine: boolean; sharedName: boolean }) {
  const pending = isPending(m);
  const clay = !m.author;
  const showHead = !grouped;
  const showFace = showHead || sharedName;
  const name = clay ? "Clay" : m.author!.name;
  // Said once as the row arrives, so the log never re-reads it as time passes.
  const [when] = useState(() => ago(m.created_at, now));
  return (
    // A message on its way is said once, when the server has it.
    <div className={`${s.row} ${grouped ? s.grouped : ""} ${pending ? s.pending : ""} ${mine ? s.mine : ""}`} data-id={m.id} aria-hidden={pending || undefined}>
      {showFace && (clay ? <Blob size={28} className={s.face} /> : <Face person={m.author!} size={28} className={s.face} decorative />)}
      {/* Still on its way: the clock sits in the head, or for a grouped row
          in the gutter where its face would be. */}
      {pending && !showHead && <span className={s.gutterClock} aria-hidden><ClockIcon /></span>}
      {showHead && (
        <p className={s.who} aria-hidden>
          <b>{name}</b>
          {sharedName && m.author && <span className={s.meta}>the {AVATAR_LABELS[m.author.avatar].toLowerCase()}</span>}
          {mine && <span className={s.youTag}>you</span>}
          <time className={s.meta} dateTime={new Date(m.created_at).toISOString()}>{chatTime(m.created_at, now)}</time>
          {pending && <ClockIcon />}
        </p>
      )}
      <div className={s.body}>
        <ClampedText body={m.body}>
          <span className="sr-only">{mine ? "You" : name}, {when}: </span>
          <Linked text={m.body} />
        </ClampedText>
        {m.element && <ElementChip element={m.element} />}
        {m.triage_pending && (
          <span className={s.reading}>
            <Blob size={16} />
            Clay is reading this
          </span>
        )}
      </div>
    </div>
  );
}

/** Clay speaking outside a card: the blob, "Clay", what it said and, when
 *  there is something to do about it, one quiet action. */
export function ClayRow({ id, at, now, meta, action, children }: { id?: string; at?: number; now?: number; meta?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className={s.row} data-id={id}>
      <Blob size={28} className={s.face} />
      <p className={s.who}>
        <b>Clay</b>
        {meta && <span className={s.meta}>{meta}</span>}
        {at !== undefined && now !== undefined && <time className={s.meta} dateTime={new Date(at).toISOString()}>{chatTime(at, now)}</time>}
      </p>
      <div className={s.body}>
        <p className={s.text}>{children}</p>
        {action && <span className={s.fix}>{action}</span>}
      </div>
    </div>
  );
}

/** A message's text, clamped to eight lines with a toggle when it holds more,
 *  so one long paste never pushes the room off everyone's screen. */
function ClampedText({ body, children }: { body: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  const clamped = useClamped(text, open, body);
  return (
    <>
      <p ref={text} className={`${s.text} ${open ? "" : s.clamp}`}>{children}</p>
      {(clamped || open) && (
        <button className={s.more} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

/** The app threw in someone's browser: Clay offers to fix it. */
function ClayNote({ id, note }: { id: string; note: { version: number; message: string } }) {
  const askChange = useAskChange();
  return (
    <ClayRow id={id} meta={`v${note.version}`} action={<Button variant="text" onClick={() => askChange(fixText(note.message))}>Fix it</Button>}>
      The app hit an error: <code className={s.code}>{note.message}</code>
    </ClayRow>
  );
}

function RestoreNoteLine({ id, note }: { id: string; note: Extract<NoteView, { type: "restore" }> }) {
  const { versionByNumber } = useAppState();
  const { me } = useIdentity();
  return (
    <p className={s.system} data-id={id}>
      <span className={s.restoreGlyph}><RestoreIcon /></span>
      <span>{restoreSaid(note, versionByNumber, me.id)} as v{note.version}</span>
    </p>
  );
}

/** Restores and forks: one quiet centered line (no join or leave notes, ever).
 *  A runtime error is Clay's to say, with a way to fix it. */
export function SystemNote({ m }: { m: MessageView }) {
  const { me } = useIdentity();
  const n = m.note;
  if (!n || n.type === "data") return <p className={s.system} data-id={m.id}><Blob size={16} /><span>{m.body}</span></p>;
  if (n.type === "error") return <ClayNote id={m.id} note={n} />;
  if (n.type === "restore") return <RestoreNoteLine id={m.id} note={n} />;
  return (
    <p className={s.system} data-id={m.id}>
      <span className={s.forkGlyph}><ForkIcon /></span>
      <span>
        <b>{nameFor(n.by, me.id)}</b> forked v{n.version} into{" "}
        {n.fork ? (
          <Link to={appUrl(n.fork.slug)}>{n.fork.name}</Link>
        ) : "a new app"}
      </span>
    </p>
  );
}
