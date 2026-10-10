"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Check, Copy, DoorOpen, Globe, Link2, MessageSquareOff, RefreshCw, Unlink, UserMinus, X } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { GUEST_LINK_TTL_MS, guestIdFromIdentity, isGuestIdentity } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useGuestLinks } from "../../hooks/useGuestLinks";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { copyToClipboard, copyToClipboardWhenReady } from "../../lib/utils";
import { guestLinkUrl, removeGuest } from "../../lib/calls/guestDoorActions";
import { sayRefusal } from "../../lib/calls/sayRefusal";
import { useGuestDoor } from "../../hooks/useGuestDoor";
import { GUEST_LINK_TTL_CHOICES, guestLinkExpiry, meetingTitle } from "../../lib/calls/roomGuests";
import { firstName } from "./speakers";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Button } from "../ui/button";

// THE ROOM'S SIDE OF A GUEST (callGuests.ts has the rules).
//
// Three gestures, each where the person making it already is:
//   the link     the stage header's door group and the call page: make one,
//                copy it, see when it closes, turn it off
//   the door     RoomDoor: a guest's knock beside a teammate's, admit or not
//   the remove   beside a guest's name on the stage, and on their face's
//                card in the header: put them out
//
// Answering a guest (admit, deny, remove) is a store action and paints in the
// frame it is pressed, everywhere at once (lib/calls/guestDoorActions); a
// refusal puts the row back and says why. A link cannot paint first: its
// token is minted by the server, so the panel shows it in flight.

// ── Remove ───────────────────────────────────────────────────────────────────

/** Put a guest out, beside their name. Two presses, the second within a few
 *  seconds: removing somebody from a meeting they are talking in is not a
 *  thing to do by brushing a button. The second press offers a choice: out,
 *  or out with the link they came in on turned off, because a guest put out
 *  can open the same link in a private window and knock again as somebody
 *  new. Renders nothing for anyone not a guest, or a viewer who could not. */
export function GuestRemoveButton({
  roomKey,
  identity,
  name,
  variant,
  always = false,
}: {
  /** The room the guest is in, which is the room the caller is drawing. */
  roomKey: string;
  identity: string;
  name: string;
  variant: "tile" | "row";
  /** Shown at rest, not only when the row is hovered (a card's own button). */
  always?: boolean;
}) {
  // Putting a guest out takes the standing that letting one in does; a
  // button that would only answer "you can't" is not offered.
  const { canInvite } = useGuestLinks(roomKey);
  const [confirm, setConfirm] = useState(false);
  useWatchEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 5000);
    return () => clearTimeout(t);
  }, [confirm]);
  const guestId = guestIdFromIdentity(identity);
  if (!guestId || !isGuestIdentity(identity) || !canInvite) return null;
  const who = firstName(name);
  const tile = variant === "tile";
  const base = tile
    ? "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] backdrop-blur transition-all"
    : "inline-flex items-center gap-1 rounded-full px-1.5 py-px font-mono text-[10px] transition-all";
  const out = (revokeLink: boolean) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirm(false);
    // The guest's face card offers this on the desktop float too, which has
    // no toasts (lib/calls/sayRefusal).
    void removeGuest(roomKey, guestId, revokeLink, sayRefusal(`Could not remove ${who}`));
  };
  if (confirm) {
    const armed = `${base} bg-sol-red/80 text-white hover:bg-sol-red`;
    return (
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={out(false)}
          className={armed}
          title={`Press to remove ${who} from the call`}
          aria-label={`Confirm: remove ${who} from the call`}
        >
          <UserMinus className="h-3 w-3" />
          remove {who}?
        </button>
        <button
          type="button"
          onClick={out(true)}
          className={`${base} ${tile ? "bg-black/55 text-white/85" : "text-sol-text-muted"} hover:bg-sol-red/80 hover:text-white`}
          title={`Remove ${who} and turn off the link they came in on, so nobody new can use it. Guests already in stay`}
          aria-label={`Remove ${who} and turn off their link`}
        >
          <Unlink className="h-3 w-3" />
          and link
        </button>
      </span>
    );
  }
  // Revealed by hover where there is one. A touch screen has none, and a
  // button that never appears there would leave the face card as the only
  // way to put a guest out, so on those it shows at rest.
  // A row also gives up its width at rest: the stage's side column is 200px,
  // and a button that is only transparent still took 64 of them, leaving a
  // guest's name, the one thing the room needs to read, as "P…". It stays in
  // the tab order and opens on focus as on hover.
  const reveal = always
    ? ""
    : tile
      ? " opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      : " max-w-0 overflow-hidden whitespace-nowrap !px-0 opacity-0 group-hover:max-w-32 group-hover:!px-1.5 group-hover:opacity-100 focus-visible:max-w-32 focus-visible:!px-1.5 focus-visible:opacity-100 [@media(hover:none)]:max-w-32 [@media(hover:none)]:!px-1.5 [@media(hover:none)]:opacity-100";
  const tone = tile ? " bg-black/45 text-white/80 hover:bg-sol-red/70 hover:text-white" : " text-sol-text-muted hover:bg-sol-red/15 hover:text-sol-red";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setConfirm(true);
      }}
      className={`${base}${tone}${reveal}`}
      title={`Remove ${who} from the call`}
      aria-label={`Remove ${who} from the call`}
    >
      <UserMinus className="h-3 w-3" />
      remove
    </button>
  );
}

// ── The link ─────────────────────────────────────────────────────────────────

/**
 * The guest link button and its panel. The trigger is the caller's (each
 * surface draws its own chrome) and toggles `open` itself, so the popover
 * only anchors to it. The panel is portaled to the body so a clipped header
 * (the stage's left group clips, on purpose) cannot cut it; Radix flips it
 * above the trigger when below would run off the screen, holds it inside
 * the viewport, follows a scroll, and dismisses on Escape or a press
 * outside. It wears the theme of wherever the trigger sits.
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
  // A press elsewhere already put focus where the person meant it; only a
  // close from inside (Escape, the close button) hands focus back.
  const pressedOutside = useRef(false);
  const close = useCallback(() => setOpen(false), []);
  // Offered only to somebody who may make a link here (the same feed the
  // panel lists from answers null for anybody else).
  const { canInvite } = useGuestLinks(roomKey);
  if (!canInvite) return null;
  const dark = open && !!anchorRef.current?.closest(".dark");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span ref={anchorRef} className="relative inline-flex shrink-0">
          {trigger({ open, toggle: () => setOpen((o) => !o) })}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align={align === "end" ? "end" : "start"}
        sideOffset={6}
        collisionPadding={8}
        hideWhenDetached
        aria-label="Invite someone outside the team"
        tabIndex={-1}
        className={`${dark ? "dark " : ""}z-[260] w-[min(340px,calc(100vw-16px))] rounded-xl border-0 bg-sol-bg-alt p-3 text-sol-text shadow-2xl ring-1 ring-black/10 duration-150 dark:ring-white/[0.08] motion-reduce:animate-none`}
        // Focus lands on the panel itself as it opens, so Esc closes it
        // rather than the stage behind it, with no ring on its first button.
        onOpenAutoFocus={(e) => {
          pressedOutside.current = false;
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus?.();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!pressedOutside.current) anchorRef.current?.querySelector<HTMLElement>("button, [tabindex]")?.focus();
        }}
        // Radix closes on Escape; the stage behind must not hear it too.
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
        // A press on the trigger is the toggle's job, not a dismissal:
        // otherwise the outside press closes and the toggle reopens.
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
          else pressedOutside.current = true;
        }}
      >
        <GuestInvitePanel roomKey={roomKey} onClose={close} />
      </PopoverContent>
    </Popover>
  );
}

const GUEST_FACTS = [
  { icon: Globe, text: "Joins in a browser, no account" },
  { icon: DoorOpen, text: "Someone in the call lets them in" },
  { icon: MessageSquareOff, text: "Sees and hears the call, not its chat" },
];

function GuestInvitePanel({ roomKey, onClose }: { roomKey: string; onClose: () => void }) {
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
  const inputRef = useRef<HTMLInputElement>(null);

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
  // What travels with the viewer's link: the guest's page and every unfurl
  // of it. The server says it (callGuests.guestLinkPreview), from the same
  // two functions the guest's page uses, before any link exists, because
  // that is when the person decides what to send: a private channel's name
  // stays inside, and the meeting is then named after whoever invites.
  const preview = useQueryNoThrow(api.callGuests.guestLinkPreview, { room_key: roomKey }).data;
  const seenAs = preview ? meetingTitle(preview.title, { name: preview.inviter }) : null;

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sol-yellow/15 text-sol-yellow">
          <Link2 className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1 text-[13px] font-medium">Guest link</div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close" className="-mr-1 text-sol-text-dim">
          <X />
        </Button>
      </div>
      {/* What a guest gets, as facts to scan rather than a paragraph. */}
      <ul className="mt-2.5 space-y-1 text-[11.5px] text-sol-text-muted">
        {GUEST_FACTS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-2">
            <Icon className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
            {text}
          </li>
        ))}
      </ul>

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
                <Button size="xs" variant={copied ? "green" : "yellow"} onClick={() => void copy(mine.path)} className="shrink-0">
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy"}
                </Button>
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
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={!!busy}
                  onClick={() => void revoke(mine.link_id)}
                  className="ml-auto shrink-0 text-sol-text-muted hover:bg-sol-red/10 hover:text-sol-red"
                  title="Nobody new can use it; guests already in stay"
                >
                  <Unlink />
                  {busy === mine.link_id ? "Turning off…" : "Turn off"}
                </Button>
              </div>
            </>
          )}
          {/* How long the next link stays open: always in sight, because a
              replacement is a new choice, not the old link's. */}
          <div className={`flex items-center gap-2 ${mine ? "mt-3 border-t border-sol-border/50 pt-3" : "mt-3"}`}>
            <span className="w-14 shrink-0 text-[11px] text-sol-text-dim">{mine ? "New link" : "Expires"}</span>
            <div role="radiogroup" aria-label="Link lasts" className="flex flex-1 rounded-md bg-sol-bg p-0.5 ring-1 ring-sol-border/60">
              {GUEST_LINK_TTL_CHOICES.map((c) => (
                <button
                  key={c.ms}
                  type="button"
                  role="radio"
                  aria-checked={ttl === c.ms}
                  onClick={() => setTtl(c.ms)}
                  className={`flex-1 rounded px-1.5 py-1 text-[11px] transition-colors ${
                    ttl === c.ms ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:text-sol-text"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          {mine ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() => create(true)}
              className="mt-2 w-full"
              title={`The old link stops working; the new one is open for ${ttlLabel}`}
            >
              <RefreshCw className={busy === "fresh" ? "animate-spin" : ""} />
              {busy === "fresh" ? "Replacing…" : "Replace link"}
            </Button>
          ) : (
            <Button variant="yellow" size="sm" disabled={!!busy} onClick={() => create(false)} className="mt-2 w-full">
              <Link2 />
              {busy === "create" ? "Making a link…" : "Create and copy link"}
            </Button>
          )}
          {!mine && copyFailed && (
            <p className="mt-1.5 px-0.5 font-mono text-[10.5px] text-sol-orange">The link was made but not copied. Press copy above.</p>
          )}
          {seenAs && (
            <p className="mt-2 truncate text-[11px] text-sol-text-dim">
              Shown to guests as <span className="text-sol-text-muted">{seenAs}</span>
            </p>
          )}
        </div>
      )}

      {others.length > 0 && (
        <div className="mt-3 border-t border-sol-border/50 pt-2">
          <div className="mb-1 text-[11px] text-sol-text-dim">Other open links</div>
          {others.map((l) => (
            <div key={l.link_id} className="flex items-center gap-2 rounded-md px-0.5 py-1 font-mono text-[11px] text-sol-text-muted">
              <span className="min-w-0 flex-1 truncate">
                {l.mine ? "your older link" : `${firstName(l.created_by_name)}'s link`} · {guestLinkExpiry(l.expires_at, now)}
                {l.waiting > 0 && <span className="text-sol-yellow"> · {l.waiting} waiting</span>}
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={!!busy}
                onClick={() => void revoke(l.link_id)}
                className="shrink-0 text-sol-text-muted hover:bg-sol-red/10 hover:text-sol-red"
              >
                {busy === l.link_id ? "Turning off…" : "Turn off"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
