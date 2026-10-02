import { toast as sonner } from "sonner";
import type { RoomKnock } from "../../store/inboxStore";
import { firstName } from "../../components/calls/speakers";

// SOMEBODY AT THE DOOR, wherever the person inside is looking.
//
// The door itself (RoomDoor's RoomKnocks) lives on the call stage, and most
// of a call is spent with the stage closed: the header's faces and one line
// of card. A knock there was a sound and nothing to press, and a guest on a
// link (who usually arrives while the person who sent it is working) waited
// for somebody to think of opening the stage. So a knock that arrives while
// the stage is closed is also a toast with the door's own answers on it, and
// it leaves when the knock does (answered here, on the stage, by somebody
// else, or the knocker gave up), never on a timer: a guest can stand at the
// door for ten minutes and the toast is the only thing to press. With the
// stage open the door is on screen and the toast stays away; closing the
// stage on a knock nobody answered brings its toast back (pass the knocks
// as `fresh` again: a toast already up is updated in place, by its id).
//
// One window toasts: the notification leader (on desktop the shell elects it;
// a browser tab is its own). The voice host, the ring card and the call
// panel run the same sync and stay quiet, as they do for every banner. A
// knock arriving while that window is not in front is also a system
// notification (lib/desktop notifyNative, which decides whether the person
// is already looking and dedupes across windows by the knock's key).
//
// A teammate's knock has Admit and no Deny, as on the door itself: a
// teammate's knock is not turned away, it lapses (CALL_KNOCK_TTL_MS), and
// they can ring or message instead. A guest has neither, so a guest is
// answered both ways.

export type KnockAnswers = {
  admitPerson: (roomKey: string, userId: string) => void;
  admitGuest: (guestId: string, name: string) => void;
  denyGuest: (guestId: string) => void;
};

type Toaster = Pick<typeof sonner, "dismiss"> & ((message: string, data?: any) => string | number);
type Notify = (title: string, body: string, key: string) => void;

const idOf = (roomKey: string, k: Pick<RoomKnock, "from_user">) => `knock:${roomKey}:${k.from_user}`;

/** Show a toast for each knock in `fresh`, and take down the toast of every
 *  knock no longer in `current`. `shown` is the set of toast ids up, carried
 *  between calls by the caller. */
export function syncKnockToasts(opts: {
  roomKey: string;
  current: RoomKnock[];
  fresh: RoomKnock[];
  shown: Set<string>;
  stageOpen: boolean;
  answers: KnockAnswers;
  /** This window is the one that tells the person (isNotificationLeader). */
  leader?: boolean;
  /** A system notification for a knock that arrives unseen. */
  notify?: Notify;
  toast?: Toaster;
}): Set<string> {
  const toast = opts.toast ?? (sonner as unknown as Toaster);
  if (opts.leader === false) {
    for (const id of opts.shown) toast.dismiss(id);
    return new Set();
  }
  const live = new Set(opts.current.map((k) => idOf(opts.roomKey, k)));
  const next = new Set<string>();
  for (const id of opts.shown) {
    if (live.has(id) && !opts.stageOpen) next.add(id);
    else toast.dismiss(id);
  }
  if (opts.stageOpen) return next;
  for (const k of opts.fresh) {
    const id = idOf(opts.roomKey, k);
    const guest = k.kind === "guest" && !!k.guest_id;
    const canAnswer = k.can_answer !== false;
    const name = guest ? k.from_name : firstName(k.from_name);
    const title = `${name} ${canAnswer ? "wants to join the call" : "is waiting at the door"}`;
    const description = guest ? "A guest from outside the team, on a guest link" : undefined;
    if (!opts.shown.has(id)) opts.notify?.(title, description ?? "Open the call to let them in", `${id}:${k.created_at}`);
    toast(title, {
      id,
      duration: Infinity,
      description,
      ...(canAnswer
        ? {
            action: {
              label: "Admit",
              onClick: () =>
                guest ? opts.answers.admitGuest(k.guest_id!, k.from_name) : opts.answers.admitPerson(opts.roomKey, String(k.from_user)),
            },
            ...(guest ? { cancel: { label: "Deny", onClick: () => opts.answers.denyGuest(k.guest_id!) } } : {}),
          }
        : {}),
    });
    next.add(id);
  }
  return next;
}
