// Chat logic shared verbatim by web and mobile: message grouping, day
// separators, the unread rule, unread tallies, and the toast tier policy.
//
// This lives in shared rather than in either client because the rules are the
// product: two implementations of "what counts as unread" or "what may
// interrupt" WILL drift, and the drift is exactly the kind of bug nobody
// reports — the phone just buzzes for something the desktop said was read.
export * from "./timeline";
export * from "./handles";
export * from "./dm";
export * from "./agent";
export * from "./voice";
