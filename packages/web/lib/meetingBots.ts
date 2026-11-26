import { toastWriteError } from "./dispatchBinding";
import { useInboxStore } from "../store/inboxStore";

/** Send a bot to a meeting link: its row paints at once (a stub the server
 *  row folds into), and a link the server refuses takes the row back and says
 *  the server's words. `onRefused` lets the caller put the link back. */
export function sendBotToMeeting(url: string, onRefused?: () => void): void {
  const clientKey = crypto.randomUUID();
  const store = useInboxStore.getState();
  store.sendMeetingBot(url, clientKey).catch((err: unknown) => {
    store.discardMeetingBotStub(clientKey);
    onRefused?.();
    toastWriteError(err, "the bot could not be sent");
  });
}
