// Touch ID for a Vault action on a client that cannot run a passkey ceremony
// itself: the phone, and the desktop app (Electron has no platform passkeys).
// It opens a presence challenge (convex/passkeys.ts), hands the ceremony to
// the web origin's /confirm page in a browser, and settles on what the
// challenge reached: granted, or not. A person with no passkey yet enrolls on
// the same page first, then confirms. The caller runs the gated action only
// when this answers true; the server's gate is what holds either way.
//
// Pure on purpose (the phone and the desktop each pass their browser and
// their Convex client), so it is reachable from the mobile bundle and testable.

import type { PresenceAction, PresenceChallengeState } from "@codecast/shared/contracts/secrets";

type Status = PresenceChallengeState["status"];

/** What presenceBegin and registrationBegin answer. */
export type OpenedChallenge = { challenge_id: string } | { error: string; needs_passkey?: boolean };

export interface PresenceHandoffDeps {
  /** The web origin the /confirm page is served from. */
  webBase: string;
  begin: (action: PresenceAction, target: string) => Promise<OpenedChallenge>;
  enroll: () => Promise<OpenedChallenge>;
  /** Show a page; resolves when the person closes it, or with "opened" when the browser cannot say (Android). */
  open: (url: string) => Promise<"closed" | "opened">;
  /** Close the page this opened, once the challenge settled. */
  close: () => void;
  /** Follow one challenge's status; returns the unsubscribe. */
  watch: (challengeId: string, onStatus: (status: Status | null) => void) => () => void;
  /** The challenge's status right now. */
  read: (challengeId: string) => Promise<Status | null>;
  /** How long a challenge waits for its assertion (PRESENCE_TTL_MS). */
  ttlMs: number;
}

export function confirmPageUrl(webBase: string, challengeId: string): string {
  return `${webBase.replace(/\/+$/, "")}/confirm?c=${encodeURIComponent(challengeId)}`;
}

/** Whether the person confirmed `action` on `target`. Throws with the server's words when the challenge cannot open. */
export async function confirmPresenceViaWeb(action: PresenceAction, target: string, deps: PresenceHandoffDeps): Promise<boolean> {
  let opened = await deps.begin(action, target);
  if ("needs_passkey" in opened && opened.needs_passkey) {
    const enrolled = await deps.enroll();
    if ("error" in enrolled) throw new Error(enrolled.error);
    // A finished enrollment uses its challenge up.
    if ((await onConfirmPage(enrolled.challenge_id, deps)) !== "used") return false;
    opened = await deps.begin(action, target);
  }
  if ("error" in opened) throw new Error(opened.error);
  return (await onConfirmPage(opened.challenge_id, deps)) === "granted";
}

/**
 * Open the confirm page for one challenge and settle on the first status past
 * pending, closing the page then. A person who closes the page first settles
 * it on a fresh read, since the grant can land a moment before its push.
 */
function onConfirmPage(challengeId: string, deps: PresenceHandoffDeps): Promise<Status | null> {
  return new Promise((resolve) => {
    let done = false;
    let stop = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: Status | null) => {
      if (done) return;
      done = true;
      stop();
      clearTimeout(timer);
      resolve(status);
    };
    const settleNow = () => void deps.read(challengeId).then(finish, () => finish(null));
    stop = deps.watch(challengeId, (status) => {
      if (!status || status === "pending") return;
      deps.close();
      finish(status);
    });
    if (done) stop();
    void deps.open(confirmPageUrl(deps.webBase, challengeId)).then(
      (how) => {
        if (how === "closed") settleNow();
        else timer = setTimeout(settleNow, deps.ttlMs);
      },
      settleNow,
    );
  });
}
