"use client";

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Link2, RefreshCw, UserMinus, X } from "lucide-react";
import { GUEST_LINK_TTL_MS, guestIdFromIdentity, isGuestIdentity } from "@codecast/shared/contracts";
import { useGuestLinks } from "../../hooks/useGuestLinks";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { copyToClipboard, copyToClipboardWhenReady } from "../../lib/utils";
import { guestLinkUrl } from "../../lib/calls/guestDoorActions";
import { useGuestDoor } from "../../hooks/useGuestDoor";
import { useInboxStore } from "../../store/inboxStore";
import { GUEST_LINK_TTL_CHOICES, guestLinkExpiry, meetingTitle } from "../../lib/calls/roomGuests";
import { firstName } from "./speakers";

// THE ROOM'S SIDE OF A GUEST (callGuests.ts has the rules).
//
// Three gestures, each where the person making it already is:
//   the link     the stage header's door group and the call page: make one,
//                copy it, see when it closes, turn it off
//   the door     RoomDoor: a guest's knock beside a teammate's, admit or not
//   the remove   beside a guest's name on the stage, and on their face's
//                card in the header: put them out
//
// None of these can paint before the server answers, and none pretends to:
// a link's token is minted by the server, and letting a stranger in or
// putting them out is a decision the room should see land, not assume. So a
// gesture shows itself in flight ("removing…") and the store's own feeds
// (liveRooms, roomKnocks) carry the result everywhere else.

// ── Remove ───────────────────────────────────────────────────────────────────

/** Put a guest out, beside their name. Two presses, the second within a few
 *  seconds: removing somebody from a meeting they are talking in is not a
 *  thing to do by brushing a button. Renders nothing for anyone not a guest. */
export function GuestRemoveButton({
  identity,
  name,
  variant,
  always = false,
}: {
  identity: string;
  name: string;
  variant: "tile" | "row";
  /** Shown at rest, not only when the row is hovered (a card's own button). */
  always?: boolean;
}) {
  const door = useGuestDoor();
  // Putting a guest out takes the standing that letting one in does; a
  // button that would only answer "you can't" is not offered.
  const roomKey = useInboxStore((st) => (st.call as any)?.roomKey ?? null);
  const { canInvite } = useGuestLinks(roomKey);
  const [phase, setPhase] = useState<"idle" | "confirm" | "busy">("idle");
  useWatchEffect(() => {
    if (phase !== "confirm") return;
    const t = setTimeout(() => setPhase("idle"), 4000);
    return () => clearTimeout(t);
  }, [phase]);
  const guestId = guestIdFromIdentity(identity);
  if (!guestId || !isGuestIdentity(identity) || !canInvite) return null;
  const who = firstName(name);
  const tile = variant === "tile";
  const base = tile
    ? "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] backdrop-blur transition-all"
    : "inline-flex items-center gap-1 rounded-full px-1.5 py-px font-mono text-[10px] transition-all";
  const reveal = phase === "idle" && !always ? " opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "";
  const tone =
    phase === "idle"
      ? tile
        ? " bg-black/45 text-white/80 hover:bg-sol-red/70 hover:text-white"
        : " text-sol-text-muted hover:bg-sol-red/15 hover:text-sol-red"
      : " bg-sol-red/80 text-white hover:bg-sol-red";
  return (
    <button
      type="button"
      disabled={phase === "busy"}
      onClick={(e) => {
        e.stopPropagation();
        if (phase === "idle") return setPhase("confirm");
        if (phase !== "confirm") return;
        setPhase("busy");
        void door.remove(guestId).finally(() => setPhase("idle"));
      }}
      className={`${base}${tone}${reveal}`}
      title={phase === "confirm" ? `Press again to remove ${who} from the call` : `Remove ${who} from the call`}
      aria-label={phase === "confirm" ? `Confirm: remove ${who} from the call` : `Remove ${who} from the call`}
    >
      <UserMinus className="h-3 w-3" />
      {phase === "busy" ? "removing…" : phase === "confirm" ? `remove ${who}?` : "remove"}
    </button>
  );
}

// ── The link ─────────────────────────────────────────────────────────────────

/**
 * The guest link button and its panel. The trigger is the caller's (each
 * surface draws its own chrome); the panel is portaled to the body so a
 * clipped header (the stage's left group clips, on purpose) cannot cut it,
 * and it wears the theme of wherever the trigger sits.
 */
export function GuestInvite({
  roomKey,
  trigger,
  align = "start",
}: {
  roomKey: string;
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  /** Which edge of the trigger the panel lines up with. */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // Offered only to somebody who may make a link here (the same feed the
  // panel lists from answers null for anybody else).
  const { canInvite } = useGuestLinks(roomKey);
  if (!canInvite) return null;
  return (
    <span ref={anchorRef} className="relative inline-flex shrink-0">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && anchorRef.current && (
        <GuestInvitePanel roomKey={roomKey} anchor={anchorRef.current} align={align} onClose={close} />
      )}
    </span>
  );
}

const PANEL_W = 340;
const GAP = 6;

/** Where the panel stands: under the trigger, or above it when below would
 *  run off the screen, held inside the viewport either way. Measured after
 *  layout (the panel's own height decides the flip) and again whenever the
 *  window resizes. */
function usePanelPlacement(anchor: HTMLElement, panel: React.RefObject<HTMLDivElement | null>, align: "start" | "end") {
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const place = useCallback(() => {
    const rect = anchor.getBoundingClientRect();
    const h = panel.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(window.innerWidth - PANEL_W - 8, align === "end" ? rect.right - PANEL_W : rect.left));
    const below = rect.bottom + GAP;
    const above = below + h > window.innerHeight - 8 && rect.top - GAP - h >= 8;
    const top = above ? rect.top - GAP - h : below;
    // The layout effect below measures after every render, so a placement
    // that has not moved must not set state: a fresh object each time is a
    // render each time, and React gives up on the loop ("Maximum update
    // depth exceeded"), taking the whole call window down with it.
    setPos((p) => (p && p.left === left && p.top === top && p.above === above ? p : { left, top, above }));
  }, [anchor, panel, align]);
  useLayoutEffect(() => {
    place();
  });
  useWatchEffect(() => {
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);
  return pos;
}

function GuestInvitePanel({
  roomKey,
  anchor,
  align,
  onClose,
}: {
  roomKey: string;
  anchor: HTMLElement;
  align: "start" | "end";
  onClose: () => void;
}) {
  const door = useGuestDoor();
  const now = useCoarseNow(30_000);
  const { links, ready } = useGuestLinks(roomKey);
  // My newest open link is THE link; any other of mine (two surfaces made one
  // at once, an older one kept for a standing meeting) is listed with the
  // rest, so no open door into the call is ever out of sight.
  const mine = links.find((l) => l.mine) ?? null;
  const others = links.filter((l) => l !== mine);
  const [ttl, setTtl] = useState<number>(GUEST_LINK_TTL_MS);
  const [busy, setBusy] = useState<null | "create" | "fresh" | string>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pos = usePanelPlacement(anchor, rootRef, align);
  const dark = !!anchor.closest(".dark");

  useWatchEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    // A scroll that moves the trigger leaves the panel pointing at nothing;
    // one inside the panel is the panel's own.
    const onScroll = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);
  // Focus lands in the panel once, as it opens, so Esc closes it rather than
  // the stage behind it.
  useMountEffect(() => {
    rootRef.current?.focus();
  });

  const copied_ = () => {
    setCopyFailed(false);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  // A browser that would not copy gets the link selected, ready for a key.
  const copyMissed = () => {
    setCopyFailed(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };
  const copy = async (path: string) => {
    try {
      await copyToClipboard(guestLinkUrl(path));
      copied_();
    } catch {
      copyMissed();
    }
  };
  // The copy starts inside the press, before the link exists: Safari drops a
  // clipboard write made after an await (copyToClipboardWhenReady).
  const create = (fresh: boolean) => {
    setBusy(fresh ? "fresh" : "create");
    const made = door.createLink(roomKey, fresh ? { fresh: true, ttlMs: ttl } : { ttlMs: ttl });
    void copyToClipboardWhenReady(made.then((link) => (link ? guestLinkUrl(link.path) : null)))
      .then((ok) => ok && copied_())
      .catch(copyMissed)
      .finally(() => setBusy(null));
  };
  const revoke = async (linkId: string) => {
    setBusy(linkId);
    await door.revokeLink(linkId);
    setBusy(null);
  };
  const ttlLabel = GUEST_LINK_TTL_CHOICES.find((c) => c.ms === ttl)?.label ?? "7 days";
  // What travels with the link: the guest's page and every unfurl of it.
  const seenAs = meetingTitle(links[0]?.title ?? null, { name: (mine ?? links[0])?.created_by_public ?? null });

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Invite someone outside the team"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width: PANEL_W, visibility: pos ? "visible" : "hidden" }}
      className={`${dark ? "dark " : ""}fixed z-[260] rounded-xl bg-sol-bg-alt p-3 text-sol-text shadow-2xl outline-none ring-1 ring-black/10 animate-in fade-in duration-150 dark:ring-white/[0.08] motion-reduce:animate-none ${
        pos?.above ? "slide-in-from-bottom-1" : "slide-in-from-top-1"
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sol-yellow/15 text-sol-yellow">
          <Link2 className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-snug">Invite someone outside the team</div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-sol-text-muted">
            They join from the link in a browser, no account. Someone in the call lets them in, and they are told first if the call is transcribed or recorded.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {!ready && links.length === 0 ? (
        <div className="mt-3 h-[74px] animate-pulse rounded-lg bg-sol-bg-highlight/60" />
      ) : (
        <div className="mt-3">
          {mine && (
            <>
              <div className="flex items-center gap-1.5 rounded-lg bg-sol-bg p-1 pl-2.5 ring-1 ring-sol-border/60">
                <input
                  ref={inputRef}
                  readOnly
                  value={guestLinkUrl(mine.path).replace(/^https?:\/\//, "")}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Guest link"
                  className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-sol-text-secondary outline-none"
                  style={{ fontVariantLigatures: "none" }}
                />
                <button
                  type="button"
                  onClick={() => void copy(mine.path)}
                  className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                    copied ? "bg-sol-green/15 text-sol-green" : "bg-sol-yellow/15 text-sol-yellow hover:bg-sol-yellow/25"
                  }`}
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? "copied" : "copy"}
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-2 px-0.5 font-mono text-[10.5px] text-sol-text-muted">
                <span className="min-w-0 truncate">
                  {copyFailed ? (
                    <span className="text-sol-orange">couldn't copy: the link is selected, copy it with a key</span>
                  ) : (
                    <>
                      {guestLinkExpiry(mine.expires_at, now)}
                      {mine.waiting > 0 && <span className="text-sol-yellow"> · {mine.waiting} waiting</span>}
                      {mine.admitted > 0 && <span> · {mine.admitted} in the call</span>}
                    </>
                  )}
                </span>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void revoke(mine.link_id)}
                  className="ml-auto shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-sol-red/10 hover:text-sol-red disabled:opacity-50"
                  title="Turn this link off. Nobody new can use it; guests already in stay"
                >
                  {busy === mine.link_id ? "turning off…" : "turn off"}
                </button>
              </div>
            </>
          )}
          {/* How long the next link stays open: always in sight, because a
              replacement is a new choice, not the old link's. */}
          <div className={`flex items-center gap-1 px-0.5 ${mine ? "mt-3 border-t border-sol-border/50 pt-2.5" : "mb-2"}`}>
            <span className="mr-1 font-mono text-[10.5px] text-sol-text-muted">{mine ? "new link, open for" : "open for"}</span>
            {GUEST_LINK_TTL_CHOICES.map((c) => (
              <button
                key={c.ms}
                type="button"
                onClick={() => setTtl(c.ms)}
                aria-pressed={ttl === c.ms}
                className={`rounded-md px-1.5 py-0.5 font-mono text-[10.5px] transition-colors ${
                  ttl === c.ms ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:text-sol-text"
                }`}
              >
                {c.label}
              </button>
            ))}
            {mine && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => create(true)}
                className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10.5px] text-sol-text-muted transition-colors hover:bg-sol-bg-highlight hover:text-sol-text disabled:opacity-50"
                title={`Replace your link with a new one, open for ${ttlLabel}. The old one stops working`}
              >
                <RefreshCw className={`h-3 w-3 ${busy === "fresh" ? "animate-spin" : ""}`} />
                replace
              </button>
            )}
          </div>
          {!mine && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => create(false)}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-sol-yellow/90 px-3 py-2 text-[12.5px] font-medium text-sol-base03 transition-colors hover:bg-sol-yellow disabled:opacity-60"
            >
              <Link2 className="h-3.5 w-3.5" />
              {busy === "create" ? "Making a link…" : "Make a link and copy it"}
            </button>
          )}
          {!mine && copyFailed && (
            <p className="mt-1.5 px-0.5 font-mono text-[10.5px] text-sol-orange">The link was made but not copied. Press copy above.</p>
          )}
          <p className="mt-2 px-0.5 text-[11px] leading-snug text-sol-text-dim">
            Guests see this call as <span className="text-sol-text-muted">{seenAs}</span>.
          </p>
        </div>
      )}

      {others.length > 0 && (
        <div className="mt-3 border-t border-sol-border/50 pt-2">
          <div className="mb-1 px-0.5 font-mono text-[10.5px] text-sol-text-dim">other open links into this call</div>
          {others.map((l) => (
            <div key={l.link_id} className="flex items-center gap-2 rounded-md px-0.5 py-1 font-mono text-[11px] text-sol-text-muted">
              <span className="min-w-0 flex-1 truncate">
                {l.mine ? "your older link" : `${firstName(l.created_by_name)}'s link`} · {guestLinkExpiry(l.expires_at, now)}
                {l.waiting > 0 && <span className="text-sol-yellow"> · {l.waiting} waiting</span>}
              </span>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void revoke(l.link_id)}
                className="shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-sol-red/10 hover:text-sol-red disabled:opacity-50"
              >
                {busy === l.link_id ? "turning off…" : "turn off"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
