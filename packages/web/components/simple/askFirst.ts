// The assistant's one promise about acting for the person, worded once. A
// leaf with no imports, so the lane (web and phone) and the light public pages
// can all say it without pulling in each other's code.

/** The promise, for whatever the assistant could do on the person's behalf. */
export function askFirst(act: string): string {
  return `I always ask before I ${act}.`;
}

/** The promise where mail and calendar are in reach: Home, Connections,
 *  onboarding's sign in and connect screens. */
export const ASK_FIRST = askFirst("send an email or change your calendar");

/** The promise for what the person's mail connection lets the assistant
 *  change (the send_mail and calendar parts of whisk.connection's `can`):
 *  both together are ASK_FIRST, one of them names only that one, and with
 *  neither (nothing connected, or a deployment that cannot connect mail) it
 *  promises only what holds for everyone. */
export function askFirstFor(can: { send_mail?: boolean; calendar?: boolean } | null | undefined): string {
  const send = !!can?.send_mail;
  const calendar = !!can?.calendar;
  if (send && calendar) return ASK_FIRST;
  if (send) return askFirst("send an email");
  if (calendar) return askFirst("change your calendar");
  return askFirst("act for you");
}
