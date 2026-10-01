"use client";

/**
 * Chapter 4, Approve: the API worker's ask as the permission stack at the
 * foot of its own conversation, and on the phone as the daemon's push on the
 * lock screen that opens into the app's notification row and permission
 * card. Approve works on both, locally.
 */

import { useState } from "react";
import { LogoIcon } from "@/components/Logo";
import { PermissionStackView } from "@/components/PermissionCard";
import { PhonePermissionCard } from "@/components/PhonePermissionCard";
import { NotificationRow } from "@/components/notifications/NotificationRow";
import { PhoneScreenHeader, PhoneTabBar } from "@/components/PhoneAppChrome";
import { EARLIER, NOTIFICATIONS, PERMISSION, PUSH } from "../fixtures/phone";
import { CUES, SESSIONS } from "../fixtures/story";
import { fly, useFilmTime } from "../filmClock";
import { Veil } from "../film";
import { PHONE_AT } from "./phone.motion";
import type { PartProps } from "./contract";

const noop = () => {};

/** Where the ask stands: 0 pending, 1 Approve tapped (in flight), 2 answered. */
type Answer = 0 | 1 | 2;

/** A local Approve or Deny: in flight for a beat, then answered, as the real round trip reads. */
function useLocalAnswer(): [Answer, () => void] {
  const [answer, setAnswer] = useState<Answer>(0);
  const respond = () => {
    setAnswer(1);
    setTimeout(() => setAnswer(2), 450);
  };
  return [answer, respond];
}

/** Allow all is a Claude Code permission mode; the conversation offers it to no other agent. */
const offersAllowAll = (agent: string) => agent === "claude_code";

const filmAnswer = (t: number): Answer => (t < PHONE_AT.tap ? 0 : t < PHONE_AT.gone ? 1 : 2);

function WorkerPermissionAsk() {
  const [local, respond] = useLocalAnswer();
  const answer = Math.max(useFilmTime(filmAnswer), local);
  if (answer === 2) return null;
  return (
    <div {...fly("pairA/phone.stack")} data-hero-live="" className="border-t border-sol-border/40 px-3 py-1.5">
      <PermissionStackView
        pending={[PERMISSION]}
        inflight={new Set(answer === 1 ? [PERMISSION._id] : [])}
        onApprove={respond}
        onDeny={respond}
        onApproveAll={respond}
        onDenyAll={respond}
        onAllowAll={offersAllowAll(SESSIONS.api.agent) ? respond : undefined}
      />
    </div>
  );
}

/** The API worker's transcript foot while it waits on permission. A new ask (the next loop) starts fresh. */
export function WorkerPermission() {
  const asked = useFilmTime((t) => t >= CUES.permissionAsk);
  return asked ? <WorkerPermissionAsk /> : null;
}

/** The dashboard worker steps back while the camera frames the API worker's ask. */
export function PairVeil() {
  return <Veil id="pairB/phone.veil" />;
}

/** The daemon's push as iOS shows it: the app's icon, the push title and body. */
function PushBannerCard() {
  return (
    <div
      className="flex items-start gap-2.5 rounded-[18px] bg-[#2a3135]/95 px-3 py-2.5 text-white shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
      style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}
    >
      <span className="mt-0.5 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-[#fdf6e3]">
        <LogoIcon size={22} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold leading-tight">{PUSH.title}</span>
          <span className="ml-auto shrink-0 self-start text-[11px] text-white/55">now</span>
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-white/85">{PUSH.body}</span>
      </span>
    </div>
  );
}

/** The flyer that carries the ask from the desk to the phone: the push it becomes. */
export function PushFlyer() {
  return (
    // The banner's own width on the lock screen, so the flyer's last frame is the banner's first.
    <div className="w-[260px] -translate-x-1/2 -translate-y-1/2">
      <PushBannerCard />
    </div>
  );
}

function LockScreen({ now }: PartProps) {
  const d = new Date(now);
  const time = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
  const date = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  return (
    <div
      {...fly("phone/phone.lock", {
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
        background: "radial-gradient(120% 70% at 30% 0%, rgba(38,139,210,0.35), transparent 60%), radial-gradient(90% 60% at 100% 100%, rgba(42,161,152,0.28), transparent 60%), #001f27",
      })}
      className="absolute inset-0 flex flex-col items-center pt-10 text-white"
    >
      <span className="text-[15px] font-medium text-white/80">{date}</span>
      <span className="text-[68px] font-semibold leading-none tracking-tight">{time}</span>
    </div>
  );
}

/**
 * The app's Notifications tab, where the push opens: its header and tab bar
 * (the app's own spec, PhoneAppChrome) around the notification rows and the
 * app's permission card.
 */
function PhoneApp({ now }: PartProps) {
  const [local, respond] = useLocalAnswer();
  const answer = Math.max(useFilmTime(filmAnswer), local);
  const done = useFilmTime((t) => t >= PHONE_AT.done);
  const unread = (answer > 0 ? 0 : 1) + (done ? 1 : 0);
  return (
    <div {...fly("phone/phone.app")} className="absolute inset-0 flex flex-col bg-sol-bg">
      <PhoneScreenHeader tab="notifications" />
      {/* At phone width a row's agent name would wrap mid-word ("cod / ex") and its status onto a second line; the app's rows keep the name whole and truncate the status. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-clip pt-1 [&_span.font-medium]:shrink-0 [&_span.font-medium]:whitespace-nowrap [&_span.text-xs]:min-w-0 [&_span.text-xs]:truncate">
        {done && (
          <div {...fly("phone/phone.done")}>
            <NotificationRow notification={{ ...NOTIFICATIONS.done, created_at: now - NOTIFICATIONS.done.ago, read: false }} onOpen={noop} />
          </div>
        )}
        <div {...fly("phone/phone.row")}>
          <NotificationRow notification={{ ...NOTIFICATIONS.ask, created_at: now - NOTIFICATIONS.ask.ago, read: answer > 0 }} onOpen={noop} />
        </div>
        {answer < 2 && (
          <div {...fly("phone/phone.card")} data-hero-live="" className="relative flex flex-col px-3 pt-3">
            <PhonePermissionCard permission={PERMISSION} processing={answer === 1} onApprove={respond} onDeny={respond} />
            {/* The tap, centred on Approve (the left half of the card's button row). */}
            <span
              {...fly("phone/phone.tap", { left: "calc(12px + 25% - 4px)", top: "calc(100% - 44px)", margin: "-28px 0 0 -28px" })}
              aria-hidden
              className="pointer-events-none absolute h-14 w-14 rounded-full border-2 border-white/80 bg-white/20"
            />
          </div>
        )}
        {EARLIER.map((n) => (
          <NotificationRow key={n._id} notification={{ ...n, created_at: now - n.ago, read: true }} onOpen={noop} />
        ))}
      </div>
      <PhoneTabBar active="notifications" badges={{ notifications: unread }} />
    </div>
  );
}

/** The phone's screen: the lock screen, the push landing on it, then the app it opens. */
export function PhoneScreen({ now }: PartProps) {
  const asked = useFilmTime((t) => t >= CUES.permissionAsk);
  return (
    <div className="relative h-full">
      <LockScreen now={now} />
      <PhoneApp key={asked ? "asked" : "idle"} now={now} />
      {/* Under the clock, where iOS stacks a new notification on the lock screen. */}
      <div {...fly("phone/phone.banner")} className="absolute inset-x-2 top-[150px]">
        <PushBannerCard />
      </div>
    </div>
  );
}
