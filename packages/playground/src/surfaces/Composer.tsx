// The composer (DESIGN 6.3): one field, three modes (Auto lets Clay decide,
// Change it forces a build, Just chat forces talk), point and talk, and the
// sent message shows at once while the server catches up.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { insertAtTop, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { MessageView } from "../../convex/messages";
import { errorData } from "../lib/errors";
import { useIdentity } from "../lib/identity";
import { ElementChip } from "../ui/Chips";
import { ArrowUpIcon, PickIcon } from "../ui/icons";
import { Keys, MOD } from "../ui/Keys";
import { useToast } from "../ui/Toast";
import { freshFocus, useAppState, type Mode } from "./appState";
import s from "./Composer.module.css";

const MODES: { mode: Mode; label: string; placeholder: string }[] = [
  { mode: "auto", label: "Auto", placeholder: "Say anything, or ask for a change" },
  { mode: "change", label: "Change it", placeholder: "What should change?" },
  { mode: "chat", label: "Just chat", placeholder: "Say something" },
];

const TYPING_EVERY_MS = 3_000;
const MAX_LINES = 6;

export function Composer({ compact = false, onFocus }: { compact?: boolean; onFocus?: () => void }) {
  const { app, composer, picking, setPicking } = useAppState();
  const { creds, me } = useIdentity();
  const toast = useToast();
  const field = useRef<HTMLTextAreaElement>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());

  const send = useMutation(api.messages.send).withOptimisticUpdate((store, args) => {
    const pending: MessageView = {
      id: `pending:${crypto.randomUUID()}` as Id<"messages">,
      created_at: Date.now(),
      kind: args.mode === "change" ? "request" : "chat",
      author: me,
      body: args.body.trim(),
      element: args.element ?? null,
      triage_pending: args.mode === "auto",
      build: null,
      note: null,
    };
    insertAtTop({ paginatedQuery: api.messages.list, argsToMatch: { app_id: args.app_id }, localQueryStore: store, item: pending });
  });
  const setTyping = useMutation(api.presence.setTyping);
  const lastTyping = useRef(0);

  // Focus requests from anywhere ("/", the capsule, Edit, Fix it, an idea).
  useEffect(() => {
    if (!freshFocus(composer.focusAt)) return;
    const t = setTimeout(() => {
      const el = field.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }, 60);
    return () => clearTimeout(t);
  }, [composer.focusAt]);

  // Grow with the text up to six lines, then scroll.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 21;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + 4)}px`;
  }, [composer.text, compact]);

  // The rate limit's countdown.
  const waiting = retryAt > now;
  useEffect(() => {
    if (!retryAt) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= retryAt) setRetryAt(0);
    }, 250);
    return () => clearInterval(t);
  }, [retryAt]);

  const typing = (on: boolean) => {
    const t = Date.now();
    if (on && t - lastTyping.current < TYPING_EVERY_MS) return;
    if (!on && lastTyping.current === 0) return;
    lastTyping.current = on ? t : 0;
    setTyping({ ...creds, app_id: app.id, typing: on }).catch(() => {});
  };

  const submit = async () => {
    const body = composer.text.trim();
    if (!body || waiting) return;
    const element = composer.element;
    composer.setText("");
    composer.setElement(null);
    lastTyping.current = 0;
    try {
      await send({ ...creds, app_id: app.id, body, mode: composer.mode, ...(element ? { element } : {}) });
    } catch (err) {
      const e = errorData(err);
      composer.setText(body);
      composer.setElement(element);
      if (e.code === "rate_limited" && e.retry_after_ms) {
        setNow(Date.now());
        setRetryAt(Date.now() + e.retry_after_ms);
      } else toast({ text: e.message });
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if ((e.metaKey || e.ctrlKey) && ["1", "2", "3"].includes(e.key)) {
      e.preventDefault();
      composer.setMode(MODES[Number(e.key) - 1].mode);
    }
  };

  const current = MODES.find((m) => m.mode === composer.mode)!;
  const seconds = Math.ceil((retryAt - now) / 1000);

  return (
    <div className={`${s.composer} ${compact ? s.compact : ""}`}>
      {!compact && (
        <div className={s.modes} role="radiogroup" aria-label="What this message is">
          {MODES.map((m, i) => (
            <button
              key={m.mode}
              role="radio"
              aria-checked={composer.mode === m.mode}
              className={`${s.mode} ${s[m.mode]} ${composer.mode === m.mode ? s.on : ""}`}
              onClick={() => composer.setMode(m.mode)}
            >
              {m.label}
              <span className={s.tip} role="tooltip">
                <Keys keys={[MOD, String(i + 1)]} />
              </span>
            </button>
          ))}
        </div>
      )}
      {waiting && (
        <p className={s.limit} role="status">Slow down a little. Try again in {seconds}s</p>
      )}
      <div className={s.row}>
        <button
          className={`${s.pick} ${picking ? s.picking : ""}`}
          onClick={() => setPicking(!picking)}
          aria-pressed={picking}
          aria-label="Point at something in the app"
          title="Point at something in the app"
        >
          <PickIcon />
        </button>
        <div className={s.field}>
          {composer.element && <ElementChip element={composer.element} onRemove={() => composer.setElement(null)} />}
          <textarea
            ref={field}
            rows={1}
            value={composer.text}
            placeholder={current.placeholder}
            aria-label={current.placeholder}
            onChange={(e) => {
              composer.setText(e.target.value);
              typing(e.target.value.trim().length > 0);
            }}
            onKeyDown={onKey}
            onFocus={onFocus}
            onBlur={() => typing(false)}
          />
        </div>
        <button className={`${s.send} ${s[`send_${composer.mode}`]}`} onClick={submit} disabled={!composer.text.trim() || waiting} aria-label="Send">
          <ArrowUpIcon />
        </button>
      </div>
      {composer.mode === "change" && !compact && <p className={s.hint}>Goes live for everyone</p>}
    </div>
  );
}
