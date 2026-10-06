// Chat bubbles, Clay's notes and system notes (DESIGN 6.4, 6.5, 6.10).
import type { MessageView } from "../../convex/messages";
import { chatTime } from "../lib/format";
import { appUrl, navigate } from "../lib/router";
import { AVATAR_LABELS } from "../lib/avatars";
import { Blob } from "../ui/Blob";
import { Button } from "../ui/Button";
import { ElementChip } from "../ui/Chips";
import { Face } from "../ui/Face";
import { useAppState } from "./appState";
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

export function ChatMessage({ m, grouped, now, mine, sharedName }: { m: MessageView; grouped: boolean; now: number; mine: boolean; sharedName: boolean }) {
  const pending = isPending(m);
  if (mine) {
    return (
      <div className={`${s.row} ${s.mine} ${grouped ? s.grouped : ""} ${pending ? s.pending : ""}`} data-id={m.id}>
        <div className={s.col}>
          <p className={`${s.bubble} ${s.mineBubble}`}><Linked text={m.body} /></p>
          {m.element && <ElementChip element={m.element} />}
        </div>
      </div>
    );
  }
  const clay = !m.author;
  const showHead = !grouped;
  return (
    <div className={`${s.row} ${grouped ? s.grouped : ""}`} data-id={m.id}>
      <span className={s.faceSlot}>
        {(showHead || sharedName) && (clay ? <Blob size={30} /> : <Face person={m.author!} size={30} />)}
      </span>
      <div className={s.col}>
        {showHead && (
          <p className={s.who}>
            <b>{clay ? "Clay" : m.author!.name}</b>
            {sharedName && m.author && <span className={s.animal}>the {AVATAR_LABELS[m.author.avatar].toLowerCase()}</span>}
            <time dateTime={new Date(m.created_at).toISOString()}>{chatTime(m.created_at, now)}</time>
          </p>
        )}
        <p className={`${s.bubble} ${clay ? s.clayBubble : ""}`}><Linked text={m.body} /></p>
        {m.element && <ElementChip element={m.element} />}
      </div>
    </div>
  );
}

/** The app threw in someone's browser: Clay offers to fix it. */
function ClayNote({ id, note }: { id: string; note: { version: number; message: string } }) {
  const { composer } = useAppState();
  return (
    <div className={s.row} data-id={id}>
      <span className={s.faceSlot}><Blob size={30} /></span>
      <div className={s.col}>
        <p className={s.who}><b>Clay</b><span className={s.animal}>v{note.version}</span></p>
        <div className={`${s.bubble} ${s.clayBubble}`}>
          The app hit an error: <code className={s.code}>{note.message}</code>
          <Button
            size="sm"
            variant="make"
            className={s.fix}
            onClick={() => {
              composer.setMode("change");
              composer.setText(`Fix this error: ${note.message}`);
              composer.focus();
            }}
          >
            Fix it
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Restores and forks: one quiet centered line (no join or leave notes, ever).
 *  A runtime error is Clay's to say, with a way to fix it. */
export function SystemNote({ m }: { m: MessageView }) {
  const n = m.note;
  if (!n) return <p className={s.system}><Blob size={16} />{m.body}</p>;
  if (n.type === "error") return <ClayNote id={m.id} note={n} />;
  if (n.type === "restore") {
    return (
      <p className={s.system} data-id={m.id}>
        <i className={s.mintDot} />
        {n.by?.name ?? "Someone"} restored v{n.from_version} as v{n.version}
      </p>
    );
  }
  return (
    <p className={s.system} data-id={m.id}>
      <i className={s.poolDot} />
      <span>
        {n.by?.name ?? "Someone"} forked v{n.version} into{" "}
        {n.fork ? (
          <a href={appUrl(n.fork.slug)} onClick={(e) => {
            e.preventDefault();
            navigate(appUrl(n.fork!.slug));
          }}>{n.fork.name}</a>
        ) : "a new app"}
      </span>
    </p>
  );
}
