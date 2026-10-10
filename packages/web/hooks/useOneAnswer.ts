// One answer per approval card, on the web (HostedApprovalCard) and the phone
// (components/hosted/ApprovalCard): the row leaves the store when the server
// settles it, and a second tap meanwhile would answer twice. A refusal lets
// go of the hold and says so; any other failure is a write still on its way.
import { useState } from "react";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";

/** Said when the server turned an answer away for good, so the card is live
 *  again rather than a row of dead buttons. */
export const APPROVAL_REFUSED = "That answer didn't go through. Try again.";

export function useOneAnswer(answer: (index: number) => Promise<unknown> | undefined | void) {
  const [answered, setAnswered] = useState(false);
  const [refused, setRefused] = useState(false);
  const pick = (index: number) => {
    if (answered) return;
    setAnswered(true);
    setRefused(false);
    answer(index)?.catch((error: unknown) => {
      if (!isRefusedDispatchError(error)) return;
      setAnswered(false);
      setRefused(true);
    });
  };
  return { answered, refused, pick };
}
