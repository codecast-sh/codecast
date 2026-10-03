"use client";

/**
 * Chapter 4, Chat: the API worker's question at the foot of its own pane,
 * and on the phone the codecast app's session screen, where Alex answers it:
 * the question arrives, the field takes focus, the answer is typed and sent,
 * and the worker turns back to Working and streams its reply. The screen is
 * the app's own (components/PhoneSession.tsx, drawn from the session screen's
 * spec in @codecast/shared/render/mobileSessionStyle) inside the iOS status
 * bar and keyboard.
 */

import type { ReactNode } from "react";
import { Globe, Mic } from "lucide-react";
import { AssistantBlock, UserPrompt } from "@/components/conversation/blocks/turnBlocks";
import { PhoneComposer, PhoneMessage, PhoneMessageText, PhoneSessionHeader, PhoneSessionMeta, PhoneStatusDot, PhoneToolCalls } from "@/components/PhoneSession";
import { MOBILE_COMPOSER_PLACEHOLDER, MOBILE_COMPOSER_STATUS, MOBILE_PULSE, MOBILE_SESSION_STYLE, mobileRelativeTime } from "@codecast/shared/render/mobileSessionStyle";
import { ASK, EARLIER, ME, PHONE_SESSION, REPLY, STEER } from "../fixtures/phone";
import { fly, useFilmTime } from "../filmClock";
import { FilmDip, FilmGrow } from "../film";
import { typed } from "../timeline";
import { APP_K, APP_W, DESK_AT, HOME_H, KEYBOARD_H, PHONE_AT, STATUS_H } from "./phone.motion";
import type { PartProps } from "./contract";

const SF = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";

/* ── The desk: the exchange in the worker's own pane ─────────────────── */

/**
 * The foot of the API worker's transcript: its question, then (while the
 * camera is on the phone) the answer from the phone and its reply. Each opens
 * its own room as it lands (FilmGrow), so the transcript above it rises.
 */
export function WorkerExchange({ now }: PartProps) {
  return (
    <div className="px-3 pb-1">
      <FilmGrow at={DESK_AT.ask} dur={0.6}>
        <div {...fly("pairA/phone.ask")}>
          <AssistantBlock content={ASK} timestamp={now - 1_000} messageId="hero-m-api-ask" agentType={PHONE_SESSION.agent} showHeader={false} />
        </div>
      </FilmGrow>
      <FilmGrow at={DESK_AT.steer}>
        <UserPrompt content={STEER} timestamp={now} messageId="hero-m-api-steer" userName={ME} avatarUrl={null} />
      </FilmGrow>
      <FilmGrow at={DESK_AT.reply}>
        <AssistantBlock content={REPLY} timestamp={now} messageId="hero-m-api-reply" agentType={PHONE_SESSION.agent} />
      </FilmGrow>
    </div>
  );
}

/* ── The phone: iOS around the app ───────────────────────────────────── */

function Glyph({ d, w, h }: { d: ReactNode; w: number; h: number }) {
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="currentColor" aria-hidden>
      {d}
    </svg>
  );
}

/** The iOS status bar beside the Dynamic Island: the time, signal, Wi-Fi and battery, in black over the app's light header. */
function StatusBar({ now }: { now: number }) {
  const d = new Date(now);
  const time = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
  return (
    <div className="absolute inset-x-0 top-0 z-30 flex items-center text-black" style={{ height: STATUS_H, fontFamily: SF }}>
      <span className="flex-1 pl-9 text-[15px] font-semibold tracking-[-0.2px]">{time}</span>
      <span className="h-[24px] w-[100px] rounded-full bg-black" />
      <span className="flex flex-1 items-center justify-end gap-[5px] pr-7">
        <Glyph w={17} h={11} d={[0, 1, 2, 3].map((i) => <rect key={i} x={i * 4.6} y={8 - i * 2.6} width={3} height={3 + i * 2.6} rx={0.8} />)} />
        <Glyph w={15} h={11} d={<path d="M7.5 2.2c2.3 0 4.4.9 6 2.4l1.1-1.2A10.2 10.2 0 0 0 7.5.5 10.2 10.2 0 0 0 .4 3.4l1.1 1.2a8.6 8.6 0 0 1 6-2.4Zm0 3.3c1.4 0 2.6.5 3.6 1.4l1.1-1.2a6.9 6.9 0 0 0-9.4 0l1.1 1.2c1-.9 2.2-1.4 3.6-1.4Zm0 3.3c.5 0 1 .2 1.3.5L7.5 10.8 6.2 9.3c.3-.3.8-.5 1.3-.5Z" />} />
        <span className="relative flex h-[12px] w-[25px] items-center rounded-[3.5px] border border-black/35 p-[1.5px]">
          <span className="h-full w-[72%] rounded-[1.5px] bg-black" />
          <span className="absolute -right-[3px] h-[4px] w-[1.5px] rounded-r-sm bg-black/35" />
        </span>
      </span>
    </div>
  );
}

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

/** QuickType's next-word guesses after each word of the answer (the words before them, lower-cased). */
const NEXT: Record<string, [string, string, string]> = {
  "": ["Agreed", "I", "Thanks"],
  "agreed.": ["Log", "I", "Thanks"],
  log: ["the", "410s", "it"],
  "410s,": ["never", "but", "and"],
  never: ["retry", "mind", "again"],
  "retry.": ["Thanks", "I", "The"],
};

/**
 * What QuickType offers as the answer is typed: the next word between words;
 * inside one, the word as typed (in quotes) with the word it is becoming and
 * a guess beside it; once the word is whole, the word itself in the middle,
 * unquoted, between two guesses. iOS never offers one word twice.
 */
function quickType(typedSoFar: string): [string, string, string] {
  const words = typedSoFar.split(" ");
  const partial = words[words.length - 1];
  const before = (words[words.length - 2] ?? "").toLowerCase();
  if (!partial) return NEXT[before] ?? NEXT[""];
  const bare = (STEER.split(" ")[words.length - 1] ?? partial).replace(/[.,]$/, "");
  const guesses = [...(NEXT[before] ?? NEXT[""]), ...NEXT[""]].filter((w, i, all) => w.toLowerCase() !== bare.toLowerCase() && all.indexOf(w) === i);
  if (partial.replace(/[.,]$/, "") === bare) return [guesses[0], bare, guesses[1]];
  return [`\u201c${partial}\u201d`, bare, guesses[0]];
}

/** The iOS keyboard in light mode, as the app's light theme raises it: QuickType's three suggestions (following the typing), the letter rows, the 123, space and return row, and the globe and mic under it. */
function Keyboard() {
  const key = "flex items-center justify-center rounded-[5px] shadow-[0_1px_0_rgba(0,0,0,0.3)]";
  const len = useFilmTime((t) => (t >= PHONE_AT.type && t < PHONE_AT.sent ? typed(STEER, t, PHONE_AT.type, PHONE_AT.rate).length : t >= PHONE_AT.sent ? -1 : 0));
  const words = len < 0 ? NEXT[""] : quickType(STEER.slice(0, len));
  return (
    <div {...fly("phone/phone.keyboard", { height: KEYBOARD_H, fontFamily: SF })} className="absolute inset-x-0 bottom-0 z-20 flex flex-col bg-[#d1d4da] px-[3px] text-black">
      <div className="flex h-[42px] shrink-0 items-center text-[15px] text-black">
        {words.map((w, i) => (
          <span key={i} className={`flex flex-1 justify-center truncate ${i ? "border-l border-black/15" : ""}`}>{w}</span>
        ))}
      </div>
      <div className="flex flex-col gap-[10px] pt-[4px]">
        {ROWS.map((row, r) => (
          <div key={row} className="flex justify-center gap-[5.5px]">
            {r === 2 && <span className={`${key} mr-[8px] h-[40px] w-[40px] bg-[#acb1b9] text-[15px]`}>⇧</span>}
            {[...row].map((c) => (
              <span key={c} className={`${key} h-[40px] w-[30.5px] bg-white text-[21px]`}>{c}</span>
            ))}
            {r === 2 && <span className={`${key} ml-[8px] h-[40px] w-[40px] bg-[#acb1b9] text-[15px]`}>⌫</span>}
          </div>
        ))}
        <div className="flex gap-[5.5px]">
          <span className={`${key} h-[40px] w-[44px] bg-[#acb1b9] text-[15px]`}>123</span>
          <span className={`${key} h-[40px] flex-1 bg-white text-[15px]`}>space</span>
          <span className={`${key} h-[40px] w-[86px] bg-[#acb1b9] text-[15px]`}>return</span>
        </div>
      </div>
      {/* The globe and the mic, in the inset under the keys on a Face ID iPhone. */}
      <div className="flex flex-1 items-center justify-between px-[22px] pb-[6px] text-[#50555c]">
        <Globe size={23} strokeWidth={1.6} />
        <Mic size={23} strokeWidth={1.6} />
      </div>
    </div>
  );
}

/** One of the app's breathing dots; its phase is film time, quantised so only the dot re-renders, about twenty times a cycle. */
function PulseDot({ color, pulse, glow }: { color: string; pulse: { leg: number; low: number }; glow?: boolean }) {
  const opacity = useFilmTime((t) => {
    const leg = pulse.leg / 1000;
    const u = (t % (2 * leg)) / leg;
    const e = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
    const k = u < 1 ? e(u) : 1 - e(u - 1);
    return Math.round((1 - (1 - pulse.low) * k) * 20) / 20;
  });
  return <PhoneStatusDot color={color} opacity={opacity} glow={glow} />;
}


/** The reply, streamed: the words so far, with the rest held invisibly so the bubble keeps the height it lands with. */
function StreamedReply() {
  const shown = useFilmTime((t) => typed(REPLY, t, PHONE_AT.replyWords, PHONE_AT.wordRate, true).length);
  return (
    <>
      {REPLY.slice(0, shown)}
      <span className="opacity-0">{REPLY.slice(shown)}</span>
    </>
  );
}

/** The worker's session in the app: what it did before the question, then the exchange as film time reaches it, each entry opening its own room (FilmGrow) so the feed above rises. */
function Feed({ now }: { now: number }) {
  // The same stamps the worker's pane on the desk gives these messages (fanout.tsx), so the two copies of the session agree.
  const agentType = PHONE_SESSION.agent;
  return (
    <div {...fly("phone/phone.feed", MOBILE_SESSION_STYLE.messageList)} className="flex flex-col">
      <PhoneMessage role="user" name={EARLIER.from} agentType={agentType} time={mobileRelativeTime(now - 4_000, now)}>
        <PhoneMessageText>{EARLIER.task}</PhoneMessageText>
      </PhoneMessage>
      <PhoneMessage role="assistant" agentType={agentType} model={PHONE_SESSION.model} time={mobileRelativeTime(now - 3_000, now)}>
        <PhoneMessageText>{EARLIER.plan}</PhoneMessageText>
      </PhoneMessage>
      <PhoneToolCalls only calls={EARLIER.calls.map(({ call, result }) => ({ call, result }))} />
      <FilmGrow at={PHONE_AT.askRoom} dur={0.55}>
        <div {...fly("phone/phone.askBubble")} data-phone="ask">
          <PhoneMessage role="assistant" agentType={agentType} time="just now" showHeader={false}>
            <PhoneMessageText>{ASK}</PhoneMessageText>
          </PhoneMessage>
        </div>
      </FilmGrow>
      <FilmGrow at={PHONE_AT.sent}>
        <div {...fly("phone/phone.steer")} data-phone="steer">
          <PhoneMessage role="user" name={ME} agentType={agentType} time="just now">
            <PhoneMessageText>{STEER}</PhoneMessageText>
          </PhoneMessage>
        </div>
      </FilmGrow>
      <FilmGrow at={PHONE_AT.reply} dur={0.6}>
        <div {...fly("phone/phone.reply")} data-phone="reply">
          <PhoneMessage role="assistant" agentType={agentType} model={PHONE_SESSION.model} time="just now">
            <PhoneMessageText>
              <StreamedReply />
            </PhoneMessageText>
          </PhoneMessage>
        </div>
      </FilmGrow>
    </div>
  );
}

/** The composer: empty, then the field focused, the answer typed in, and sent. */
function Composer() {
  // Working, then nothing while its turn has ended on the question (idle, as the app shows it), then working on the answer: the status clears and returns with a fade, held in its place.
  const status = "working";
  const focused = useFilmTime((t) => t >= PHONE_AT.focus);
  const len = useFilmTime((t) => (t >= PHONE_AT.type && t < PHONE_AT.sent ? typed(STEER, t, PHONE_AT.type, PHONE_AT.rate).length : 0));
  const meta = MOBILE_COMPOSER_STATUS[status];
  return (
    <div className="relative">
      <PhoneComposer
        value={STEER.slice(0, len)}
        placeholder={MOBILE_COMPOSER_PLACEHOLDER.active}
        status={status}
        statusDot={meta && <PulseDot color={meta.color} pulse={MOBILE_PULSE.status} />}
        statusWrap={(n) => <FilmDip out={PHONE_AT.askLands} back={PHONE_AT.working}>{n}</FilmDip>}
        caret={focused}
        bottom={HOME_H}
        send={(button) => (
          <span className="relative inline-flex">
            <span {...fly("phone/phone.send")} className="inline-flex">{button}</span>
            <span {...fly("phone/phone.sendTap", { left: "50%", top: "50%", margin: "-28px 0 0 -28px" })} aria-hidden className="pointer-events-none absolute h-14 w-14 rounded-full border-2 border-sol-blue/60 bg-sol-blue/15" />
          </span>
        )}
      />
      {/* The tap that focuses the field. */}
      <span {...fly("phone/phone.tap", { left: "30%", top: 30, margin: "-28px 0 0 -28px" })} aria-hidden className="pointer-events-none absolute h-14 w-14 rounded-full border-2 border-sol-blue/60 bg-sol-blue/15" />
    </div>
  );
}

/** The phone's screen: the app's session screen for the API worker, laid out at a phone's width and scaled onto the model's screen. */
export function PhoneScreen({ now }: PartProps) {
  return (
    <div className="absolute inset-0 overflow-clip bg-sol-bg font-mono">
      <div className="relative flex origin-top-left flex-col" style={{ width: APP_W, height: `calc(100% / ${APP_K})`, transform: `scale(${APP_K})` }}>
        <StatusBar now={now} />
        <div className="relative z-10 shrink-0">
          {/* The team has huddles (chapter 9), and the session has messages: the header carries both buttons, as the app's does. */}
          <PhoneSessionHeader title={PHONE_SESSION.title} top={STATUS_H} huddle messageList />
          <PhoneSessionMeta
            agentType={PHONE_SESSION.agent}
            ago="just now"
            live
            dot={<PulseDot color="#10b981" pulse={MOBILE_PULSE.live} glow />}
            model={PHONE_SESSION.model}
            modelEditable
            assignment={PHONE_SESSION.assignment}
            parent
          />
        </div>
        <div className="relative min-h-0 flex-1">
          <div {...fly("phone/phone.body")} className="absolute inset-0 flex flex-col">
            <div className="flex min-h-0 flex-1 flex-col justify-end">
              <Feed now={now} />
            </div>
            <Composer />
          </div>
        </div>
        <Keyboard />
        {/* The home indicator, over whatever is at the foot of the screen. */}
        <span className="absolute bottom-[8px] left-1/2 z-30 h-[5px] w-[134px] -translate-x-1/2 rounded-full bg-black/85" />
      </div>
    </div>
  );
}

/** The flyer that carries the question from the desk to the phone: the app's message as it will rest in the feed, on the screen's own ground, at the screen's scale. */
export function QuestionFlyer() {
  return (
    <div className="-translate-x-1/2 -translate-y-1/2 font-mono" style={{ width: APP_W * APP_K }}>
      <div className="rounded-[10px] bg-sol-bg" style={{ width: APP_W, zoom: APP_K, padding: "0 16px" }}>
        <PhoneMessage role="assistant" agentType={PHONE_SESSION.agent} time="just now" showHeader={false}>
          <PhoneMessageText>{ASK}</PhoneMessageText>
        </PhoneMessage>
      </div>
    </div>
  );
}
