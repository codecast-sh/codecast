// What an approval is answered with: the stored option labels a hosted
// conversation's engine and a `cast decide --run` card both read the answer
// by. The cards draw them as Yes and Not now (assistant.ts APPROVAL_BUTTONS).
export const APPROVAL_ANSWERS = { approve: "Approve", always: "Always allow", decline: "Decline" } as const;
