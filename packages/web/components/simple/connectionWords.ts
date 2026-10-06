// What the mail and calendar connection says, worded once for the web's
// Integrations row (components/integrations/WhiskCard.tsx) and the phone's
// Settings page (packages/mobile components/hosted/MailPage.tsx): what the
// connection lets the assistant do, which mailboxes
// it reaches, and what a disconnect will change. Mail comes through Whisk, so
// one connection reaches every mailbox the person keeps there.
import type { MailAbilities } from "./lane";

export function emailAbility(can: MailAbilities | null | undefined): string {
  if (!can?.read_mail) return "Read and sort your mail, find what needs you, and draft replies in your voice.";
  if (can.modify_mail && can.send_mail) return "I read and sort your mail and draft replies in your voice. I send only after you say yes.";
  if (can.send_mail) return "I can read your mail and send replies after you say yes. Sorting, archiving and drafts need you to connect again.";
  return "I can read your mail. Sorting it and sending replies need you to connect again.";
}

export function calendarAbility(can: MailAbilities | null | undefined): string {
  return can?.calendar
    ? "I see when you're free, and add or move events after you say yes."
    : "See when you're free, find times to meet, and add events for you.";
}

/** The mailboxes a connection reaches, as one short line: the main one, and
 *  how many more. */
export function mailboxLine(email: string | undefined, mailboxes: readonly string[]): string | undefined {
  const main = email ?? mailboxes[0];
  if (!main) return undefined;
  const more = mailboxes.filter((m) => m.toLowerCase() !== main.toLowerCase()).length;
  return more ? `${main} and ${more} more ${more === 1 ? "mailbox" : "mailboxes"}` : main;
}

/** The line under the card. Before anything is connected it tells someone
 *  deciding whether to connect that they can take it back; once connected,
 *  what a disconnect stops and what it leaves alone. */
export function disconnectNote(connected: boolean): string {
  if (!connected) return "You can disconnect any time, and I stop right away.";
  return "Disconnecting stops me from reading or sending anything right away. Your mail stays in Whisk, and nothing already written is deleted.";
}
