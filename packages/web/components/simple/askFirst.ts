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
