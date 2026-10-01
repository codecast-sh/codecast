"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { Check, Copy, Link2, RefreshCw, UserMinus, X } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { GUEST_LINK_TTL_MS, guestIdFromIdentity, humanizeConvexError, isGuestIdentity } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { copyToClipboard, sharePageUrl } from "../../lib/utils";
import { GUEST_LINK_TTL_CHOICES, guestLinkExpiry } from "../../lib/calls/roomGuests";
import { firstName } from "./speakers";

// THE ROOM'S SIDE OF A GUEST (callGuests.ts has the rules).
//
// Three gestures, each where the person making it already is:
//   the link     the stage header's door group and the call page: make one,
//                copy it, see when it closes, turn it off
//   the door     RoomDoor: a guest's knock beside a teammate's, admit or not
//   the remove   beside a guest's name on the stage: put them out
//
// None of these can paint before the server answers, and none pretends to:
// a link's token is minted by the server, and letting a stranger in or
// putting them out is a decision the room should see land, not assume. So a
// gesture shows itself in flight ("removing…") and the store's own feeds
// (liveRooms, roomKnocks) carry the result everywhere else.

type Convex = ReturnType<typeof useConvex>;

async function attempt<T>(fallback: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    toast.error(humanizeConvexError(err, fallback));
    return null;
  }
}

/** The room's answers to a guest, each with its own failure words. */
export function guestDoorActions(convex: Convex) {
  return {
    admit: (guestId: string, name: string) =>
      attempt("Could not let them in", () => convex.mutation(api.callGuests.admitGuest, { guest_id: guestId, name })),
    deny: (guestId: string, opts?: { revokeLink?: boolean }) =>
      attempt("Could not turn them away", () =>
        convex.mutation(api.callGuests.denyGuest, { guest_id: guestId, ...(opts?.revokeLink ? { revoke_link: true } : {}) }),
      ),
    remove: (guestId: string, opts?: { revokeLink?: boolean }) =>
      attempt("Could not remove them", () =>
        convex.mutation(api.callGuests.removeGuest, { guest_id: guestId, ...(opts?.revokeLink ? { revoke_link: true } : {}) }),
      ),
    createLink: (roomKey: string, opts?: { ttlMs?: number; fresh?: boolean }) =>
      attempt("Could not make a guest link", () =>
        convex.mutation(api.callGuests.createGuestLink, {
          room_key: roomKey,
          ...(opts?.ttlMs !== undefined ? { ttl_ms: opts.ttlMs } : {}),
          ...(opts?.fresh ? { fresh: true } : {}),
        }),
      ),
    revokeLink: (linkId: string) =>
      attempt("Could not turn the link off", () => convex.mutation(api.callGuests.revokeGuestLink, { link_id: linkId as any })),
  };
}

export function useGuestDoor() {
  const convex = useConvex();
  // One object per client: the actions close over nothing that moves.
  const ref = useRef<ReturnType<typeof guestDoorActions> | null>(null);
  if (!ref.current) ref.current = guestDoorActions(convex);
  return ref.current;
}

/** The absolute address of a guest link: the public web, whichever window
 *  (a desktop pane, localhost) the link was made in. */
export function guestLinkUrl(path: string): string {
  return sharePageUrl(path);
}

/** Make (or reuse) the caller's link into this room and copy it: the add
 *  list's one-press "someone outside the team". Says when it closes. */
export async function copyGuestLink(convex: Convex, roomKey: string): Promise<void> {
  const link = await guestDoorActions(convex).createLink(roomKey);
  if (!link) return;
  try {
    await copyToClipboard(guestLinkUrl(link.path));
    toast.success("Guest link copied", {
      description: `Anyone with it can ask to join; someone in the call lets them in. It is ${guestLinkExpiry(link.expires_at, Date.now())}.`,
    });
  } catch {
    toast.error("Couldn't copy the guest link");
  }
}

// ── Remove ───────────────────────────────────────────────────────────────────

/** Put a guest out, beside their name. Two presses, the second within a few
 *  seconds: removing somebody from a meeting they are talking in is not a
 *  thing to do by brushing a button. Renders nothing for anyone not a guest. */
export function GuestRemoveButton({ identity, name, variant }: { identity: string; name: string; variant: "tile" | "row" }) {
  const door = useGuestDoor();
  const [phase, setPhase] = useState<"idle" | "confirm" | "busy">("idle");
  useWatchEffect(() => {
    if (phase !== "confirm") return;
    const t = setTimeout(() => setPhase("idle"), 4000);
    return () => clearTimeout(t);
  }, [phase]);
  const guestId = guestIdFromIdentity(identity);
  if (!guestId || !isGuestIdentity(identity)) return null;
  const who = firstName(name);
  const tile = variant === "tile";
  const base = tile
    ? "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] backdrop-blur transition-all"
    : "inline-flex items-center gap-1 rounded-full px-1.5 py-px font-mono text-[10px] transition-all";
  const reveal = phase === "idle" ? " opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : "";
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
  return (
    <span ref={anchorRef} className="relative inline-flex shrink-0">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && anchorRef.current && (
        <GuestInvitePanel roomKey={roomKey} anchor={anchorRef.current} align={align} onClose={() => setOpen(false)} />
      )}
    </span>
  );
}

type GuestLinkRow = {
  link_id: string;
  token: string;
  path: string;
  created_by_name: string;
  mine: boolean;
  expires_at: number;
  waiting: number;
  admitted: number;
};

const PANEL_W = 340;

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
  const links = useQueryNoThrow(api.callGuests.listGuestLinks, { room_key: roomKey }).data as GuestLinkRow[] | undefined;
  const mine = links?.find((l) => l.mine) ?? null;
  const others = (links ?? []).filter((l) => !l.mine);
  const [ttl, setTtl] = useState<number>(GUEST_LINK_TTL_MS);
  const [busy, setBusy] = useState<null | "create" | "fresh" | string>(null);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Where the panel stands: under the trigger, held inside the viewport.
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - PANEL_W - 8, align === "end" ? rect.right - PANEL_W : rect.left));
  const top = rect.bottom + 6;
  const dark = !!anchor.closest(".dark");

  useWatchEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    rootRef.current?.focus();
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anchor, onClose]);

  const copy = async (path: string) => {
    try {
      await copyToClipboard(guestLinkUrl(path));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn't copy the link");
    }
  };
  const create = async (fresh: boolean) => {
    setBusy(fresh ? "fresh" : "create");
    const link = await door.createLink(roomKey, fresh ? { fresh: true, ttlMs: ttl } : { ttlMs: ttl });
    setBusy(null);
    if (link) await copy(link.path);
  };
  const revoke = async (linkId: string) => {
    setBusy(linkId);
    await door.revokeLink(linkId);
    setBusy(null);
  };

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
      style={{ left, top, width: PANEL_W }}
      className={`${dark ? "dark " : ""}fixed z-[260] rounded-xl bg-sol-bg-alt p-3 text-sol-text shadow-2xl outline-none ring-1 ring-black/10 animate-in fade-in slide-in-from-top-1 duration-150 dark:ring-white/[0.08] motion-reduce:animate-none`}
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

      {links === undefined ? (
        <div className="mt-3 h-[74px] animate-pulse rounded-lg bg-sol-bg-highlight/60" />
      ) : mine ? (
        <div className="mt-3">
          <div className="flex items-center gap-1.5 rounded-lg bg-sol-bg p-1 pl-2.5 ring-1 ring-sol-border/60">
            <input
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
              {guestLinkExpiry(mine.expires_at, now)}
              {mine.waiting > 0 && <span className="text-sol-violet"> · {mine.waiting} waiting</span>}
              {mine.admitted > 0 && <span> · {mine.admitted} in the call</span>}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void create(true)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-sol-bg-highlight hover:text-sol-text disabled:opacity-50"
                title={`Replace this link with a new one, open for ${GUEST_LINK_TTL_CHOICES.find((c) => c.ms === ttl)?.label ?? "7 days"}. The old one stops working`}
              >
                <RefreshCw className={`h-3 w-3 ${busy === "fresh" ? "animate-spin" : ""}`} />
                new link
              </button>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void revoke(mine.link_id)}
                className="rounded px-1.5 py-0.5 transition-colors hover:bg-sol-red/10 hover:text-sol-red disabled:opacity-50"
                title="Turn this link off. Nobody new can use it; guests already in stay"
              >
                {busy === mine.link_id ? "turning off…" : "turn off"}
              </button>
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <div className="mb-2 flex items-center gap-1 px-0.5">
            <span className="mr-1 font-mono text-[10.5px] text-sol-text-muted">open for</span>
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
          </div>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void create(false)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-sol-yellow/90 px-3 py-2 text-[12.5px] font-medium text-sol-base03 transition-colors hover:bg-sol-yellow disabled:opacity-60"
          >
            <Link2 className="h-3.5 w-3.5" />
            {busy === "create" ? "Making a link…" : "Make a link and copy it"}
          </button>
        </div>
      )}

      {others.length > 0 && (
        <div className="mt-3 border-t border-sol-border/50 pt-2">
          <div className="mb-1 px-0.5 font-mono text-[10.5px] text-sol-text-dim">other open links into this call</div>
          {others.map((l) => (
            <div key={l.link_id} className="flex items-center gap-2 rounded-md px-0.5 py-1 font-mono text-[11px] text-sol-text-muted">
              <span className="min-w-0 flex-1 truncate">
                {firstName(l.created_by_name)}'s link · {guestLinkExpiry(l.expires_at, now)}
                {l.waiting > 0 && <span className="text-sol-violet"> · {l.waiting} waiting</span>}
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
