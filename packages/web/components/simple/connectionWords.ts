// What the Connections screen says about Google, worded once for the web
// lane (app/simple/connections) and the phone's (packages/mobile
// app/(simple)): what each part of the grant lets the assistant do, and what
// a disconnect will change.
import type { GoogleAbilities } from "./lane";

export function emailAbility(can: GoogleAbilities | null | undefined): string {
  if (!can?.read_mail) return "Read and sort your mail, find what needs you, and draft replies.";
  if (can.modify_mail && can.send_mail) return "I read and sort your mail and draft replies. I send only after you say yes.";
  if (can.send_mail) return "I can read your mail and send replies after you say yes. Sorting, archiving and labels need one more permission.";
  return "I can read your mail. Sorting it and sending replies need one more permission.";
}

export function calendarAbility(can: GoogleAbilities | null | undefined): string {
  return can?.calendar
    ? "I see when you're free, and add or move events after you say yes."
    : "See when you're free, find times to meet, and add events for you.";
}

/** The line under the card. Before anything is connected it tells someone
 *  deciding whether to connect that they can take it back; once connected,
 *  what a disconnect stops, and which account the assistant would use
 *  instead when the person has more than one. */
export function disconnectNote(connected: boolean, email: string | undefined, others: Array<{ email?: string }>): string {
  if (!connected) return "You can disconnect any time, and I stop right away.";
  if (others.length > 0) {
    return `Disconnecting ${email ?? "this account"} stops me from using it right away. Your other Google ${others.length === 1 ? "account stays" : "accounts stay"} connected, and I would use ${others[0].email ?? "that one"} instead. Nothing already written is deleted.`;
  }
  return "Disconnecting stops me from reading or sending anything right away. Nothing already written is deleted.";
}
