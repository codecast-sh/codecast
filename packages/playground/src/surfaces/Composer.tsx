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
import { useDesktop } from "../lib/useMedia";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, PickIcon } from "../ui/icons";
import { Keys, MOD, MOD_ARIA } from "../ui/Keys";
import { Popover } from "../ui/Popover";
import { Segmented } from "../ui/Segmented";
import { useToast } from "../ui/Toast";
import { load, save } from "../lib/storage";
import { freshFocus, useAppState, useComposer, useStream, type Mode } from "./appState";
import { IdeaChips } from "./IdeaChips";
import s from "./Composer.module.css";

/** `short`: the placeholder beside the folded mode chip, one line on a phone. */
const MODES: { mode: Mode; label: string; placeholder: string; short: string; hint: string }[] = [
  { mode: "auto", label: "Auto", placeholder: "Say anything, or ask for a change", short: "Say anything", hint: "Clay decides whether it's a change or just chat" },
  { mode: "change", label: "Change it", placeholder: "What should change?", short: "What should change?", hint: "Goes live for everyone" },
  { mode: "chat", label: "Just chat", placeholder: "Say something", short: "Say something", hint: "Clay stays out of it" },
];

const TYPING_EVERY_MS = 3_000;
const MAX_LINES = 6;

/** `compact`: the phone sheet's peek. Below desktop the mode folds into a
 *  chip in the field, and the placeholder carries the hint. */
export function Composer({ compact = false, onFocus }: { compact?: boolean; onFocus?: () => void }) {
  const { app, picking, setPicking } = useAppState();
  const folded = !useDesktop();
  const composer = useComposer();
  const { creds, me } = useIdentity();
  const toast = useToast();
  const stream = useStream();
  // A newcomer's first contribution shouldn't start from a blank field:
  // until they send something here, Clay's ideas sit above it.
  const sentKey = `clayground.sent.${app.id}.${me.id}`;
  const [sent, setSent] = useState(() => load(sentKey, false));
  const newcomer = !sent && !stream.messages.some((m) => m.author?.id === me.id);
  const ideas = !compact && newcomer && !composer.text && stream.messages.length > 0;
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

  // Change it can't build while budgets are spent or building is paused.
  const paused = composer.mode === "change" ? app.builds_paused : null;
  const pick = (m: Mode) => !(m === "change" && app.builds_paused) && composer.setMode(m);
  const blocked = waiting || !!paused;

  const submit = async () => {
    const body = composer.text.trim();
    if (!body || blocked) return;
    const element = composer.element;
    composer.setText("");
    composer.setElement(null);
    lastTyping.current = 0;
    if (!sent) {
      setSent(true);
      save(sentKey, true);
    }
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
      pick(MODES[Number(e.key) - 1].mode);
    }
  };

  const index = MODES.findIndex((m) => m.mode === composer.mode);
  const current = MODES[index];
  const next = MODES[(index + 1) % MODES.length];
  const seconds = Math.ceil((retryAt - now) / 1000);

  return (
    <div className={`${s.composer} ${compact ? s.compact : ""}`}>
      {!folded && (
        <div className={s.modes}>
          <Segmented
            label="What this message is"
            value={composer.mode}
            onChange={pick}
            options={MODES.map((m, i) => ({
              value: m.mode,
              label: m.label,
              disabled: m.mode === "change" && !!app.builds_paused,
              tip: m.mode === "change" && app.builds_paused ? app.builds_paused : <Keys keys={[MOD, String(i + 1)]} />,
              keyshortcuts: `${MOD_ARIA}+${i + 1}`,
            }))}
          />
        </div>
      )}
      {ideas && (
        <div className={s.ideas}>
          <span>Try</span>
          <IdeaChips className={s.ideaRow} />
        </div>
      )}
      {waiting ? (
        <p className={s.limit} role="status">Slow down a little. Try again in {seconds}s</p>
      ) : paused ? (
        <p className={s.limit} role="status">{paused}</p>
      ) : null}
      <div className={s.field}>
        <button
          className={`${s.pick} ${picking ? s.picking : ""}`}
          onClick={() => setPicking(!picking)}
          aria-pressed={picking}
          aria-label="Point at something in the app"
          title="Point at something in the app"
        >
          <PickIcon />
        </button>
        {folded && <ModeChip mode={composer.mode} paused={app.builds_paused} onPick={pick} />}
        <div className={s.text}>
          {composer.element && <ElementChip element={composer.element} onRemove={() => composer.setElement(null)} />}
          <textarea
            ref={field}
            rows={1}
            value={composer.text}
            placeholder={folded ? current.short : current.placeholder}
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
        <button className={`${s.send} ${s[`send_${composer.mode}`]}`} onClick={submit} disabled={!composer.text.trim() || blocked} aria-label="Send">
          <ArrowUpIcon />
        </button>
      </div>
      {!folded && (
        <p className={s.hint}>
          <span>{current.hint}</span>
          <span className={s.nextMode}>
            <Keys keys={[MOD, String(MODES.indexOf(next) + 1)]}>{next.label}</Keys>
          </span>
        </p>
      )}
    </div>
  );
}

/** The mode, folded into the field on narrow screens: a chip that opens the
 *  three modes, each with what it does. */
function ModeChip({ mode, paused, onPick }: { mode: Mode; paused: string | null; onPick: (m: Mode) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = MODES.find((m) => m.mode === mode)!;
  return (
    <>
      <button
        className={`${s.chip} ${s[`chip_${mode}`]}`}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label={`Mode: ${current.label}. Change mode`}
      >
        {current.label}
        <ChevronDownIcon />
      </button>
      {anchor && (
        <Popover anchor={anchor} place="above" align="start" width={280} onClose={() => setAnchor(null)} label="Mode" role="menu">
          <ul className={s.modeMenu} role="none">
            {MODES.map((m) => {
              const off = m.mode === "change" && !!paused;
              return (
                <li key={m.mode} role="none">
                  <button
                    role="menuitemradio"
                    data-autofocus={m.mode === mode || undefined}
                    aria-checked={m.mode === mode}
                    disabled={off}
                    onClick={() => {
                      onPick(m.mode);
                      setAnchor(null);
                    }}
                  >
                    <b>{m.label}</b>
                    <span>{off ? paused : m.hint}</span>
                    {m.mode === mode && <CheckIcon />}
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover>
      )}
    </>
  );
}
