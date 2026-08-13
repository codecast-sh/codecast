// Chat timeline rules — grouping, day separators, the unread rule, unread
// tallies, and the toast tier policy.
//
// The implementation lives in @codecast/shared/chat: the SAME module the convex
// mention resolver and the mobile screens import, so the rules cannot drift
// between surfaces. This file survives as a re-export because a large surface
// already imports from lib/chatTimeline, and a path is not worth a 20-file
// diff while other sessions have this package open.
export * from "@codecast/shared/chat";
